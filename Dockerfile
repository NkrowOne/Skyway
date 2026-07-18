# ---------- build: compila la web y el servidor ----------
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY server server
COPY web web
RUN npm run build

# ---------- prod-deps: solo dependencias de producción del servidor ----------
FROM node:22-alpine AS prod-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci -w server --omit=dev --no-audit --no-fund

# ---------- runtime ----------
FROM node:22-alpine
# docker-cli para builds/pulls contra el socket del host; git para clonar repos.
RUN apk add --no-cache docker-cli git curl bash ca-certificates

# Nixpacks (builds sin Dockerfile, como Railway). Best-effort: si falla,
# Skyway sigue funcionando y lo indica en Ajustes → Sistema.
RUN curl -fsSL https://nixpacks.com/install.sh | bash || echo "aviso: nixpacks no instalado"

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST=/app/web/dist \
    PORT=4000

COPY package.json ./
COPY server/package.json server/
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

VOLUME /data
EXPOSE 4000
CMD ["node", "server/dist/index.js"]
