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
# docker-cli para builds/pulls contra el socket del host (buildx: el CLI
# moderno construye con BuildKit y sin ese plugin `docker build` falla en
# seco); git para clonar repos.
RUN apk add --no-cache docker-cli docker-cli-buildx git curl bash ca-certificates

# Nixpacks (builds sin Dockerfile, como Railway). Best-effort: si falla,
# Skyway sigue funcionando y lo indica en Ajustes → Sistema. Se descarga el
# binario musl directamente de las releases: el install.sh oficial invoca
# `tar "" -xzf` (argumento vacío) y el tar de busybox lo rechaza, así que en
# Alpine ese script no funciona nunca. La versión sale del Cargo.toml del
# repo (mismo mecanismo que usa el instalador oficial).
RUN set -x; \
    case "$(uname -m)" in x86_64) t=x86_64-unknown-linux-musl ;; aarch64) t=aarch64-unknown-linux-musl ;; *) t= ;; esac; \
    ver="$(curl -fsSL --retry 3 https://raw.githubusercontent.com/railwayapp/nixpacks/master/Cargo.toml | sed -n 's/^version = "\(.*\)"/\1/p' | head -1)"; \
    if [ -n "$t" ] && [ -n "$ver" ]; then \
      for i in 1 2 3; do \
        curl -fL --retry 3 --retry-delay 2 -o /tmp/nixpacks.tgz "https://github.com/railwayapp/nixpacks/releases/download/v${ver}/nixpacks-v${ver}-${t}.tar.gz" \
        && tar -xzf /tmp/nixpacks.tgz -C /usr/local/bin && break; \
        echo "intento $i de instalar nixpacks falló"; sleep 2; \
      done; \
      rm -f /tmp/nixpacks.tgz; \
    fi; \
    nixpacks --version \
    || echo "AVISO: nixpacks no instalado: los repos sin Dockerfile no se podrán construir (se ve en Ajustes → Sistema)"

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
