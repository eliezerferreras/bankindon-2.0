# syntax=docker/dockerfile:1.7
# =============================================================================
# Bankindon · imagen de producción
# =============================================================================
# Multi-stage: las dependencias de compilación (TypeScript, Vite, tsx) no
# llegan a la imagen final, que solo contiene Node, dependencias de producción
# y artefactos compilados. Resultado: imagen más pequeña y menos superficie de
# ataque.
# =============================================================================

ARG NODE_VERSION=22-bookworm-slim

# --- 1. Base común -----------------------------------------------------------
FROM node:${NODE_VERSION} AS base
WORKDIR /app
ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
# `tini` como PID 1: reenvía SIGTERM al proceso Node para que el apagado
# ordenado (drenado de conexiones + cierre del pool) funcione de verdad.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

# --- 2. Dependencias ---------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# --- 3. Compilación ----------------------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.app.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY database ./database
# `tsc -b` comprueba tipos de web y servidor; `vite build` emite dist/web.
RUN npm run build

# --- 4. Dependencias de producción ------------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- 5. Imagen final ---------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/database ./database
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && chown -R node:node /app

# Nunca ejecutar como root: si el proceso se ve comprometido, el daño queda
# limitado a los permisos del usuario `node`.
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
CMD ["node","server/dist/index.js"]
