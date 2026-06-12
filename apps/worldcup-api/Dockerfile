FROM node:24-alpine AS build

WORKDIR /app/services/worldcup
ENV CI=true

COPY services/worldcup/package.json services/worldcup/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false

COPY services/worldcup ./
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine

WORKDIR /app/services/worldcup
ENV NODE_ENV=production
ENV PORT=3001

COPY --from=build /app/services/worldcup/package.json ./package.json
COPY --from=build /app/services/worldcup/node_modules ./node_modules
COPY --from=build /app/services/worldcup/dist ./dist
COPY --from=build /app/services/worldcup/docs ./docs

EXPOSE 3001
CMD ["node", "dist/main"]
