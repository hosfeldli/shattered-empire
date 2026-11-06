# Shattered Empires game server for Cloud Run: the authoritative simulation, the API and the download page.
# The game client is not part of this image: it ships inside the desktop app.
FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --chown=node:node server ./server
USER node
# Verify the runtime user can load the simulation before deploying the image.
RUN node --input-type=module -e "await import('./server/sim/game.js')"
EXPOSE 8080
CMD ["node", "server/index.js"]
