# Build context is the REPO ROOT (workspace deps resolve across packages):
#   docker build -f apps/interactions/Dockerfile -t <image> .
#
# Unlike the rest of the repo (tsx, no build step — SHORTCUTS #9), this app is
# bundled with esbuild and run on plain `node`: Discord gives us 3s to ACK, and a
# cold start under `pnpm … start` (pnpm boot + tsx transpile) ate ~1.8s of it.
FROM node:24-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @onehost/interactions build

ENV PORT=8080
EXPOSE 8080
CMD ["node", "apps/interactions/dist/index.mjs"]
