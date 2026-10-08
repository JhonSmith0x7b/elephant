# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
# tsx runs the migration and sync worker; it currently lives in devDependencies.
RUN npm ci --include=dev --no-audit --no-fund

FROM base AS build
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
# No database connection or application secrets are needed at build time.
RUN npm run build -- --webpack && rm -rf .next/cache

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.json /app/next-env.d.ts /app/next.config.ts ./
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
USER node
EXPOSE 3000
# Compose runs the same image separately for web, worker and one-shot migrations.
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
