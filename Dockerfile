FROM ubuntu:24.04

# OCI labels — set via docker build --label or CI
LABEL org.opencontainers.image.version="pihub:0.7.0"
LABEL org.opencontainers.image.source="https://github.com/ipepio/pi-hub"
LABEL org.opencontainers.image.ref="0.80.3"

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (nodesource)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# pi CLI global (para `pi install/remove/list` desde el manager)
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.3

# uv/uvx (H10): forma estándar de ejecutar MCP servers en Python — sin ella
# queda fuera medio catálogo de MCPs. UV_INSTALL_DIR fija el destino en una
# ruta del sistema (ya en PATH), independiente de HOME: en el User Runtime
# gestionado HOME apunta al volumen (ver más abajo) y el binario tiene que
# sobrevivir aunque ese volumen todavía no exista en el momento del build.
# Deliberadamente NO se instalan pnpm/yarn/bun/deno: los MCPs se distribuyen
# por npx o uvx, y menos superficie es mejor en una imagen que ejecuta
# código de terceros.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

WORKDIR /app

# Dependencias primero (cache de capas)
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/manager/package.json packages/manager/
COPY packages/runner/package.json packages/runner/
COPY packages/cli/package.json packages/cli/
COPY packages/memory-extension/package.json packages/memory-extension/
RUN npm ci --ignore-scripts

# Código y build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY models.json* ./
RUN npm run build

# CLI `pihub` disponible en PATH
RUN ln -s /app/packages/cli/dist/index.js /usr/local/bin/pihub \
    && chmod +x /app/packages/cli/dist/index.js

ENV PIHUB_DATA_DIR=/data
# H10: sin esto, HOME lo deriva Docker del `User` del contenedor —
# /home/ubuntu para el 1000:1000 con el que corre el User Runtime
# gestionado, dentro del filesystem de solo lectura. npx/uv/git/ssh
# necesitan un HOME escribible para su estado (caché, config); apuntarlo
# al volumen persistente es lo único que lo consigue sin tocar
# ReadonlyRootfs/CapDrop/el usuario no-root. Compartido entre todos los
# Agents del Runtime a propósito — ver el comentario de `homeDir` en
# packages/shared/src/registry.ts. Sobrevive a los reinicios porque vive
# en /data; entra en los snapshots de D09.04 por el mismo motivo.
ENV HOME=/data/home
VOLUME /data

EXPOSE 4000 4100-4199

CMD ["node", "packages/manager/dist/index.js"]
