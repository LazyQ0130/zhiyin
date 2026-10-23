FROM node:24.16.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24.16.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV APP_HOST=0.0.0.0
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.local ./.local
COPY --from=build --chown=node:node /app/scripts/start.mjs ./scripts/start.mjs
COPY --from=build --chown=node:node /app/src/generated ./src/generated
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts /app/next.config.ts ./
USER node
EXPOSE 3000
CMD ["node", "scripts/start.mjs"]
