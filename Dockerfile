FROM ubuntu:24.04

# OCI labels — set via docker build --label or CI
LABEL org.opencontainers.image.version="pihub:0.1.0"
LABEL org.opencontainers.image.source="https://github.com/earendil-works/goguest_agent_pi"
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
VOLUME /data

EXPOSE 4000 4100-4199

CMD ["node", "packages/manager/dist/index.js"]
