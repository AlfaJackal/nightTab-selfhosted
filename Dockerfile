# syntax=docker/dockerfile:1

# build the web app
# the bundle is plain JavaScript, so build it once on the native platform
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY webpack.common.js webpack.prod.js ./
COPY src ./src
RUN npm run build

# sync server plus the built app, no node_modules needed at runtime
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIR=/app/web
WORKDIR /app
COPY server ./server
COPY --from=build /app/dist/web ./web
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server/index.js"]
