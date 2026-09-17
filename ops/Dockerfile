FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/server-dist ./server-dist
COPY --from=build /app/server/migrations ./server/migrations
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "server-dist/server/src/main.js"]
