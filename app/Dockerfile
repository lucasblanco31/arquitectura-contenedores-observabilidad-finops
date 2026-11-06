# Imagen multi-arch (amd64 + arm64) para poder correr en Graviton.
# docker buildx build --platform linux/amd64,linux/arm64 -t <ECR>/demo-app:1.1.0 --push app
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public

USER node
EXPOSE 8080
CMD ["node", "server.js"]
