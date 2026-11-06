#!/usr/bin/env bash
# Teardown completo de la demo. Toma la cuenta de las credenciales activas y
# busca el peering por su etiqueta Name=shared-dev (la que crea el paso 3 del README).
#
#   bash teardown.sh 2>&1 | tee teardown.log
#
# Orden: cargas y charts de dev → charts e Ingress de shared (esperar que Auto Mode
# borre NLB y ALB) → peering → clusters con eksctl (borra VPC, NAT, subredes, roles
# que creó) → bucket, rol y política de Loki, repositorio ECR → verificación final
# en las dos regiones. Idempotente: cada paso tolera que el recurso ya no exista.
set -u
cd "$(dirname "$0")"

paso() { printf '\n\033[1;33m== %s  (%s)\033[0m\n' "$1" "$(date '+%H:%M:%S')"; }

paso "0. Identidad"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text) || { echo "Sin credenciales de AWS. Me detengo."; exit 1; }
echo "cuenta: $ACCOUNT"
read -r -p "¿Borrar la demo de esta cuenta? Escribe 'si' para seguir: " OK
[ "$OK" = "si" ] || { echo "Cancelado."; exit 1; }

BUCKET="loki-chunks-${ACCOUNT}-use1"
POLICY_ARN="arn:aws:iam::${ACCOUNT}:policy/loki-s3-${BUCKET}"
PCX=$(aws ec2 describe-vpc-peering-connections --region us-east-1 \
  --filters Name=tag:Name,Values=shared-dev Name=status-code,Values=active,pending-acceptance \
  --query 'VpcPeeringConnections[0].VpcPeeringConnectionId' --output text 2>/dev/null)

paso "1. dev: cargas, CronJobs, NodePools y charts"
kubectl --context dev delete -f dev/apagado-cronjob.yaml --ignore-not-found 2>&1 | grep -v 'not found' || true
sed "s/ACCOUNT_PLACEHOLDER/$ACCOUNT/" app/k8s/demo-app.yaml | kubectl --context dev delete -f - --ignore-not-found 2>&1 | grep -v 'not found' || true
kubectl --context dev delete job --all -n demo --ignore-not-found || true
helm --kube-context dev uninstall goldilocks vpa -n goldilocks 2>&1 || true
helm --kube-context dev uninstall alloy kps -n observability 2>&1 || true
kubectl --context dev delete nodepool spot-tm cronjob --ignore-not-found || true

paso "2. shared: Ingress (ALB) y charts (NLB)"
kubectl --context shared delete -f shared/grafana-ingress.yaml --ignore-not-found 2>&1 | grep -v 'not found' || true
helm --kube-context shared uninstall loki kps -n observability 2>&1 || true
kubectl --context shared delete configmap dash-demo-app -n observability --ignore-not-found || true

paso "3. Esperar a que Auto Mode borre los balanceadores de us-east-1 (hasta 6 min)"
for i in $(seq 1 24); do
  N=$(aws elbv2 describe-load-balancers --region us-east-1 --query 'length(LoadBalancers[?starts_with(LoadBalancerName, `k8s-`)])' --output text 2>/dev/null || echo "?")
  echo "  balanceadores k8s-* restantes: $N"
  [ "$N" = "0" ] && break
  sleep 15
done

paso "4. Peering"
if [ -n "$PCX" ] && [ "$PCX" != "None" ]; then
  aws ec2 delete-vpc-peering-connection --region us-east-1 --vpc-peering-connection-id "$PCX" --output text 2>&1 || true
else
  echo "  sin peering shared-dev activo"
fi

paso "5. Clusters (eksctl, en paralelo, borra VPC/NAT/subredes/roles propios; 10 a 20 min)"
eksctl delete cluster -f clusters/dev.yaml --wait --disable-nodegroup-eviction 2>&1 | sed 's/^/  [dev] /' &
eksctl delete cluster -f clusters/shared.yaml --wait --disable-nodegroup-eviction 2>&1 | sed 's/^/  [shared] /' &
wait

paso "6. Bucket de Loki, rol y política IAM, repositorio ECR"
aws s3 rb "s3://$BUCKET" --force 2>&1 || true
aws iam detach-role-policy --role-name loki-shared --policy-arn "$POLICY_ARN" 2>&1 || true
aws iam delete-role --role-name loki-shared 2>&1 || true
aws iam delete-policy --policy-arn "$POLICY_ARN" 2>&1 || true
aws ecr delete-repository --region us-east-2 --repository-name demo-app --force --query repository.repositoryName --output text 2>&1 || true

paso "7. Stacks de CloudFormation que pudieran quedar"
for r in us-east-1 us-east-2; do
  for s in $(aws cloudformation list-stacks --region $r --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED --query 'StackSummaries[?starts_with(StackName,`eksctl-`)].StackName' --output text); do
    echo "  $r: stack $s todavía existe; intentando borrarlo"
    aws cloudformation delete-stack --region $r --stack-name "$s" || true
  done
done

paso "8. Verificación final en las dos regiones (todo debería estar vacío)"
for r in us-east-1 us-east-2; do
  echo "== $r"
  echo "  instancias:   $(aws ec2 describe-instances --region $r --query 'Reservations[].Instances[?State.Name!=`terminated`].InstanceId' --output text)"
  echo "  balanceadores: $(aws elbv2 describe-load-balancers --region $r --query 'LoadBalancers[].LoadBalancerName' --output text)"
  echo "  NAT:          $(aws ec2 describe-nat-gateways --region $r --filter Name=state,Values=available --query 'NatGateways[].NatGatewayId' --output text)"
  echo "  volúmenes:    $(aws ec2 describe-volumes --region $r --query 'Volumes[].VolumeId' --output text)"
  echo "  peering:      $(aws ec2 describe-vpc-peering-connections --region $r --query 'VpcPeeringConnections[?Status.Code!=`deleted`].VpcPeeringConnectionId' --output text)"
  echo "  VPC no default: $(aws ec2 describe-vpcs --region $r --query 'Vpcs[?IsDefault==`false`].VpcId' --output text)"
  echo "  clusters EKS: $(aws eks list-clusters --region $r --query 'clusters' --output text)"
  echo "  stacks eksctl: $(aws cloudformation list-stacks --region $r --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED DELETE_IN_PROGRESS --query 'StackSummaries[?starts_with(StackName,`eksctl-`)].StackName' --output text)"
done
echo "  bucket Loki:  $(aws s3 ls 2>/dev/null | grep -c loki-chunks || true) (0 = borrado)"
echo "  rol loki-shared: $(aws iam get-role --role-name loki-shared --query Role.RoleName --output text 2>&1 | head -1)"
echo "  ECR demo-app: $(aws ecr describe-repositories --region us-east-2 --repository-names demo-app --query 'repositories[0].repositoryName' --output text 2>&1 | head -1)"

paso "Listo. Si algo quedó en la verificación, borrarlo a mano desde la consola."
