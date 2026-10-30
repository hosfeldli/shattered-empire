# Shattered Empires game server (simulation + static client) for Cloud Run.
FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY client ./client
USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
