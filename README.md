# Arquitectura de contenedores en AWS: observabilidad y FinOps

Demo de la charla *Arquitecturas de contenedores en AWS: observabilidad y
FinOps* (AWS Women Ecuador, 2026-11-05).

- Grabación: https://www.youtube.com/watch?v=c075TsArbYc
- Slides: https://lucasdevops.cloud/charlas/aws-women-ecuador-contenedores-finops/

Dos clusters de EKS Auto Mode en dos regiones: `shared` (us-east-1) guarda las
métricas y los logs y sirve Grafana; `dev` (us-east-2) corre una app con
botones para romperla a propósito. La telemetría de dev viaja a shared por un
VPC peering inter-región. Sobre dev se aplican dos palancas de FinOps: ajustar
los requests según Goldilocks y apagar los nodos fuera de horario con un
CronJob.

> ⚠️ **Cuesta dinero real mientras esté vivo**: dos control planes, nodos, dos
> NAT Gateway, dos NLB y un ALB. En la prueba original fue del orden de
> **USD 1 por hora**. Verifica los precios vigentes antes de desplegar
> ([EKS](https://aws.amazon.com/eks/pricing/),
> [VPC/NAT](https://aws.amazon.com/vpc/pricing/),
> [ELB](https://aws.amazon.com/elasticloadbalancing/pricing/)) y corre el
> [teardown](#10-teardown) al terminar. Úsalo solo en una cuenta propia de pruebas.

## Arquitectura

```
┌─ us-east-1 · VPC 10.0.0.0/16 ──────────────┐     ┌─ us-east-2 · VPC 10.1.0.0/16 ──────────────┐
│  cluster SHARED (EKS Auto Mode)            │     │  cluster DEV (EKS Auto Mode)               │
│                                            │     │                                            │
│  Prometheus (receptor de remote_write) ◄───┼─────┼── Prometheus (agente) ── remote_write      │
│  Loki (single binary, chunks en S3)   ◄────┼─────┼── Alloy (logs de todos los pods)           │
│  Grafana ─── ALB, solo desde tu IP         │     │  VPA + Goldilocks                          │
│                                            │     │  demo-app (panel con botones + API)        │
│                                            │     │  NodePool spot-tm · CronJob de apagado     │
└──────────────── VPC peering inter-región ──┴─────┴────────────────────────────────────────────┘
```

| Decisión | Por qué |
|---|---|
| La telemetría va de dev a shared (push) con `remote_write` y push a Loki | Un solo Prometheus con la etiqueta `cluster` permite un dashboard para N clusters |
| Receptores en shared detrás de NLB **internos** | La telemetría no sale a internet; Auto Mode crea el NLB sin instalar controlador ([doc](https://docs.aws.amazon.com/eks/latest/userguide/auto-configure-nlb.html)) |
| Grafana por ALB de Auto Mode con `inboundCIDRs` = tu IP | Pestaña normal del navegador, sin dejar nada abierto a internet ([doc](https://docs.aws.amazon.com/eks/latest/userguide/auto-configure-alb.html)) |
| Loki guarda chunks en S3 con **EKS Pod Identity** | Sin claves ni OIDC provider ([doc](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)) |
| En dev, un único NodePool propio `spot-tm` (Spot, familias t y m, arm64 y amd64) | Los NodePools integrados de Auto Mode son on-demand ([best practices](https://docs.aws.amazon.com/eks/latest/best-practices/automode.html)); sin uno propio no hay Spot ni Graviton |

## Archivos

```
clusters/shared.yaml, dev.yaml     eksctl ClusterConfig (Auto Mode, VPC propia, NAT único)
shared/values-kps.yaml             kube-prometheus-stack: receptor remote_write + Grafana + Alertmanager
shared/values-loki.yaml            Loki single binary con S3 (Pod Identity)
shared/loki-s3-policy.json         política IAM del rol de Loki
shared/grafana-ingress.yaml        ALB de Auto Mode para Grafana, solo desde tu IP
dev/values-kps.yaml                Prometheus agente con remote_write a shared
dev/values-alloy.yaml              Alloy DaemonSet → Loki de shared
dev/values-goldilocks.yaml         Goldilocks (VPA solo recomienda)
dev/nodepool-spot-tm.yaml          NodePool Spot t/m: app y plataforma de dev
dev/nodepool-cronjob.yaml          NodePool Spot chico con taint propio: solo el Job de prender
dev/apagado-cronjob.yaml           CronJobs apagar-dev / prender-dev (suspendidos, se disparan a mano)
app/                               demo-app: Dockerfile, server.js (Express + prom-client), public/index.html
app/k8s/demo-app.yaml              estado "antes": 4 réplicas con requests inflados, PDB, ServiceMonitor
app/k8s/demo-app-rightsized.yaml   requests según Goldilocks
grafana/dashboards/demo-app.json   dashboard de la app (Prometheus + Loki)
teardown.sh                        borra todo y verifica las dos regiones
```

Placeholders que se reemplazan al desplegar: `TU_IP_PUBLICA`,
`ACCOUNT_PLACEHOLDER`, `BUCKET_PLACEHOLDER`, `PROM_NLB_PLACEHOLDER` y
`LOKI_NLB_PLACEHOLDER`. Los comandos de abajo los resuelven con `sed` o
`--set`.

## La demo-app

Una imagen Node.js multi-arch con un panel de botones y una API:

| Botón | Endpoint | Qué se ve |
|---|---|---|
| Generar tráfico | `POST /api/load?mode=ok&rps=50&seconds=60` | rps y p95 estables |
| Romper el 30 % | `POST /api/load?mode=error` | tasa de error; en Loki `level="error"` |
| Poner lento | `POST /api/load?mode=slow` | histograma corrido |
| Quemar CPU | `POST /api/cpu?seconds=60` | uso vs. request de CPU |
| Perder memoria | `POST /api/mem?mb=20&seconds=30` | working set; OOMKill con limit chico |
| Inundar Loki | `POST /api/logs?lines=5000` | ingesta |
| Matar esta réplica | `POST /api/crash` | reinicios |
| Detener carga | `POST /api/load/stop` | |

Métricas en `/metrics`: `http_requests_total{route,method,status}`,
`http_request_duration_seconds`, `app_errors_total`, `demo_load_active`,
`demo_memory_held_bytes` y las de proceso. Logs JSON en stdout con `level`,
`route`, `status`, `latency_ms` y `pod`.

Para probarla en local, sin cluster:

```bash
cd app && npm install && npm start     # http://localhost:8080
```

## Despliegue

Todos los comandos se corren desde la raíz del repositorio. Tiempo total:
alrededor de dos horas, la mayor parte esperando a eksctl.

### 1. Prerrequisitos

```bash
aws --version            # AWS CLI v2
eksctl version           # Auto Mode requiere eksctl >= 0.195
kubectl version --client
helm version
docker buildx version    # imagen multi-arch

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update
```

Versiones probadas: Kubernetes 1.37, kube-prometheus-stack 92.18.0, loki 7.5.0,
alloy 1.15.0, vpa 5.1.0 y goldilocks 11.2.0. Fuente del formato de eksctl:
[eksctl Auto Mode](https://docs.aws.amazon.com/eks/latest/eksctl/auto-mode.html).

Variables que usan los pasos siguientes:

```bash
aws sts get-caller-identity          # confirma que es tu cuenta de pruebas
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export BUCKET=loki-chunks-${ACCOUNT}-use1
export MY_IP=$(curl -s https://checkip.amazonaws.com)

# tu IP en la API de EKS y en el ALB de Grafana
sed -i.bak "s#TU_IP_PUBLICA#${MY_IP}#" clusters/shared.yaml clusters/dev.yaml shared/grafana-ingress.yaml
```

### 2. Clusters (≈ 20 min, en paralelo)

```bash
eksctl create cluster -f clusters/shared.yaml &
eksctl create cluster -f clusters/dev.yaml &
wait

aws eks update-kubeconfig --region us-east-1 --name shared --alias shared
aws eks update-kubeconfig --region us-east-2 --name dev    --alias dev
```

### 3. NodePools de dev

En dev solo queda el NodePool integrado `system`, reservado a addons críticos.
Todo lo demás necesita `spot-tm`, así que va antes que cualquier chart:

```bash
kubectl --context dev apply -f dev/nodepool-spot-tm.yaml -f dev/nodepool-cronjob.yaml
```

Fuente: [NodePools en Auto Mode](https://docs.aws.amazon.com/eks/latest/userguide/create-node-pool.html).

### 4. Peering inter-región y Loki con Pod Identity

```bash
SHARED_VPC=$(aws ec2 describe-vpcs --region us-east-1 --filters Name=tag:alpha.eksctl.io/cluster-name,Values=shared --query 'Vpcs[0].VpcId' --output text)
DEV_VPC=$(aws ec2 describe-vpcs --region us-east-2 --filters Name=tag:alpha.eksctl.io/cluster-name,Values=dev --query 'Vpcs[0].VpcId' --output text)

PCX=$(aws ec2 create-vpc-peering-connection --region us-east-1 \
  --vpc-id $SHARED_VPC --peer-vpc-id $DEV_VPC --peer-region us-east-2 \
  --tag-specifications 'ResourceType=vpc-peering-connection,Tags=[{Key=Name,Value=shared-dev}]' \
  --query 'VpcPeeringConnection.VpcPeeringConnectionId' --output text)
sleep 10
aws ec2 accept-vpc-peering-connection --region us-east-2 --vpc-peering-connection-id $PCX

# rutas en todas las tablas de cada VPC
for rt in $(aws ec2 describe-route-tables --region us-east-1 --filters Name=vpc-id,Values=$SHARED_VPC --query 'RouteTables[].RouteTableId' --output text); do
  aws ec2 create-route --region us-east-1 --route-table-id $rt --destination-cidr-block 10.1.0.0/16 --vpc-peering-connection-id $PCX
done
for rt in $(aws ec2 describe-route-tables --region us-east-2 --filters Name=vpc-id,Values=$DEV_VPC --query 'RouteTables[].RouteTableId' --output text); do
  aws ec2 create-route --region us-east-2 --route-table-id $rt --destination-cidr-block 10.0.0.0/16 --vpc-peering-connection-id $PCX
done

# security group del cluster shared: remote_write (9090) y push a Loki (3100) desde dev
SHARED_SG=$(aws eks describe-cluster --region us-east-1 --name shared --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' --output text)
aws ec2 authorize-security-group-ingress --region us-east-1 --group-id $SHARED_SG --ip-permissions \
  'IpProtocol=tcp,FromPort=9090,ToPort=9090,IpRanges=[{CidrIp=10.1.0.0/16,Description=remote_write desde dev}]' \
  'IpProtocol=tcp,FromPort=3100,ToPort=3100,IpRanges=[{CidrIp=10.1.0.0/16,Description=loki push desde dev}]'

# bucket y rol de Loki
aws s3api create-bucket --region us-east-1 --bucket $BUCKET
aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
sed "s/BUCKET_PLACEHOLDER/${BUCKET}/g" shared/loki-s3-policy.json > /tmp/loki-s3-policy.json
aws iam create-policy --policy-name loki-s3-${BUCKET} --policy-document file:///tmp/loki-s3-policy.json
aws iam create-role --role-name loki-shared --assume-role-policy-document '{
  "Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Principal":{"Service":"pods.eks.amazonaws.com"},
  "Action":["sts:AssumeRole","sts:TagSession"]}]}'
aws iam attach-role-policy --role-name loki-shared --policy-arn arn:aws:iam::${ACCOUNT}:policy/loki-s3-${BUCKET}
aws eks create-pod-identity-association --region us-east-1 --cluster-name shared \
  --namespace observability --service-account loki --role-arn arn:aws:iam::${ACCOUNT}:role/loki-shared
```

> En zsh, escribe `${ACCOUNT}` con llaves: `$ACCOUNT:role` se interpreta como
> el modificador `:r` y rompe el ARN.

Fuentes: [VPC peering](https://docs.aws.amazon.com/vpc/latest/peering/create-vpc-peering-connection.html),
[EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html).

### 5. Observabilidad en shared

```bash
# la contraseña no se escribe en ningún archivo; queda en el Secret kps-grafana
export GRAFANA_PASS=$(openssl rand -base64 18)
helm upgrade --install kps prometheus-community/kube-prometheus-stack \
  --kube-context shared -n observability --create-namespace \
  --version 92.18.0 -f shared/values-kps.yaml --set grafana.adminPassword="$GRAFANA_PASS"

helm upgrade --install loki grafana/loki --kube-context shared -n observability \
  --version 7.5.0 -f shared/values-loki.yaml \
  --set loki.storage.bucketNames.chunks=$BUCKET --set loki.storage.bucketNames.ruler=$BUCKET --set loki.storage.bucketNames.admin=$BUCKET

kubectl --context shared apply -f shared/grafana-ingress.yaml
kubectl --context shared -n observability get ingress grafana -w   # hostname del ALB en 2 o 3 min

# DNS de los NLB internos (los usa dev)
export PROM_NLB=$(kubectl --context shared -n observability get svc kps-prometheus -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
export LOKI_NLB=$(kubectl --context shared -n observability get svc loki-gateway -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
```

Grafana queda en `http://<hostname-del-alb>`, usuario `admin`. Para leer la
contraseña:

```bash
kubectl --context shared -n observability get secret kps-grafana -o jsonpath='{.data.admin-password}' | base64 -d
```

Si el ALB no responde, `kubectl --context shared -n observability port-forward svc/kps-grafana 3000:80`.

### 6. Telemetría en dev

```bash
helm upgrade --install kps prometheus-community/kube-prometheus-stack \
  --kube-context dev -n observability --create-namespace --version 92.18.0 -f dev/values-kps.yaml \
  --set "prometheus.prometheusSpec.remoteWrite[0].url=http://${PROM_NLB}:9090/api/v1/write"

sed "s/LOKI_NLB_PLACEHOLDER/${LOKI_NLB}/" dev/values-alloy.yaml > /tmp/values-alloy.yaml
helm upgrade --install alloy grafana/alloy --kube-context dev -n observability --version 1.15.0 -f /tmp/values-alloy.yaml

helm upgrade --install vpa fairwinds-stable/vpa --kube-context dev -n goldilocks --create-namespace --version 5.1.0 \
  --set recommender.enabled=true --set updater.enabled=false --set admissionController.enabled=false
helm upgrade --install goldilocks fairwinds-stable/goldilocks --kube-context dev -n goldilocks --version 11.2.0 -f dev/values-goldilocks.yaml
```

En Grafana, `up{cluster="dev"}` debería devolver targets y en Loki
`{cluster="dev", namespace="observability"}` los logs de Alloy.

### 7. La app

```bash
aws ecr create-repository --region us-east-2 --repository-name demo-app --image-scanning-configuration scanOnPush=true
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin ${ACCOUNT}.dkr.ecr.us-east-2.amazonaws.com
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ${ACCOUNT}.dkr.ecr.us-east-2.amazonaws.com/demo-app:1.1.0 --push app

sed "s/ACCOUNT_PLACEHOLDER/${ACCOUNT}/" app/k8s/demo-app.yaml | kubectl --context dev apply -f -
kubectl --context dev -n demo rollout status deploy/demo-app
kubectl --context dev label ns demo goldilocks.fairwinds.com/enabled=true
kubectl --context dev apply -f dev/apagado-cronjob.yaml
```

### 8. Dashboard

```bash
kubectl --context shared -n observability create configmap dash-demo-app \
  --from-file=grafana/dashboards/demo-app.json --dry-run=client -o yaml \
  | kubectl --context shared label --local -f - grafana_dashboard=1 -o yaml \
  | kubectl --context shared apply -f -
```

## 9. La demo

```bash
kubectl --context dev -n demo port-forward svc/demo-app 8080:80                     # panel de botones
kubectl --context dev -n goldilocks port-forward svc/goldilocks-dashboard 8081:80   # Goldilocks
```

Con port-forward, todos los clics llegan al mismo pod. Solo los botones de
carga reparten entre réplicas, porque generan tráfico contra el Service.

1. **Antes.** Dashboard `demo-app` en Grafana: la brecha entre uso y request.
   `kubectl --context dev get nodes -L karpenter.sh/capacity-type` muestra que
   todo corre en Spot.
2. **Caos.** "Romper el 30 %" y "Poner lento". Se ven en las métricas y en los
   paneles de logs, todo mirado desde shared.
3. **Requests correctos.** Goldilocks recomienda; se aplican los valores:

   ```bash
   sed "s/ACCOUNT_PLACEHOLDER/${ACCOUNT}/" app/k8s/demo-app-rightsized.yaml | kubectl --context dev apply -f -
   ```

   Los valores de ese archivo (marcados `[GOLDILOCKS]`) son los que dio la
   prueba original; ajústalos con lo que veas en tu dashboard. Con menos
   request, Auto Mode consolida y quedan menos nodos.
4. **Apagado fuera de horario.**

   ```bash
   kubectl --context dev -n demo create job apagar-ahora --from=cronjob/apagar-dev
   kubectl --context dev get nodes -w
   ```

   El Job pone el taint `apagado=true:NoExecute` en el template de `spot-tm` y
   en sus nodos: todos los pods de dev quedan Pending y los nodos desaparecen
   (en la prueba, cero nodos a los 95 s). Mientras está apagado, el Prometheus
   de dev también se apaga y Grafana deja de recibir datos. Para prender:

   ```bash
   kubectl --context dev -n demo create job prender-ahora --from=cronjob/prender-dev
   ```

   `prender-dev` corre en el NodePool `cronjob`, el único que puede crear nodos
   mientras todo está apagado, y quita el taint. Logs del proceso en Loki:
   `{cluster="dev", namespace="demo", container="apagador"}`.

Los CronJobs van con `suspend: true`. Para usarlos de verdad, quita el
`suspend` y ajusta el `schedule` (UTC).

## 10. Teardown

```bash
bash teardown.sh 2>&1 | tee teardown.log
```

Borra cargas y charts, espera a que Auto Mode elimine los balanceadores, borra
el peering, los dos clusters con eksctl (VPC, NAT, subredes), el bucket, el rol
y la política de Loki y el repositorio de ECR. Al final lista lo que quede en
us-east-1 y us-east-2: todo debería salir vacío. Si eksctl falla a mitad de
camino, vuelve a correr el script: cada paso tolera que el recurso ya no exista.

## Limitaciones conocidas

- Grafana va por HTTP sin TLS. Es aceptable para una demo de un día con una
  sola IP permitida, no para algo que quede vivo.
- En la prueba original, dev se creó con los NodePools `general-purpose` y
  `system` y después se dejó solo `system` con `aws eks update-cluster-config`.
  Crear dev directamente con `nodePools: ["system"]` no se probó de punta a punta.
- Si tu organización restringe regiones con una SCP, necesitas us-east-1 y
  us-east-2 habilitadas.

## Licencia

[MIT](LICENSE)
