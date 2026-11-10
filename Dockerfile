FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:widget && pnpm build:server

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 FK_DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8787/diag').then(async r=>{const d=await r.json();process.exit(r.ok&&d.schema?.ok?0:1)}).catch(()=>process.exit(1))"
CMD ["node", "scripts/server.mjs"]
