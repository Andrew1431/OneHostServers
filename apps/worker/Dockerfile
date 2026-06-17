# Build context is the REPO ROOT (workspace deps resolve across packages):
#   docker build -f apps/worker/Dockerfile -t <image> .
#
# No compile step — internal packages run from src via tsx (SHORTCUTS #9). On
# Cloud Run the attached service account supplies GCP credentials (ADC); no key
# file is baked in.
FROM node:24-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

ENV PORT=8080
EXPOSE 8080
CMD ["pnpm", "--filter", "@onehost/worker", "start"]
