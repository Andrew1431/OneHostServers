# Build context is the REPO ROOT (workspace deps resolve across packages):
#   docker build -f apps/interactions/Dockerfile -t <image> .
#
# No compile step — internal packages run from src via tsx (SHORTCUTS #9). The
# image just installs the workspace and runs the app.
FROM node:24-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

ENV PORT=8080
EXPOSE 8080
CMD ["pnpm", "--filter", "@onehost/interactions", "start"]
