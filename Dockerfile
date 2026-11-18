# TSN Ads MCP Server container, for gz-server (Unraid) with Tailscale Funnel.
# The server code is unchanged; this file only packages it.
FROM node:22-bookworm-slim

# ca-certificates: needed for HTTPS calls to tsncommunications.ai and by
# Unraid's Tailscale hook, which installs the Tailscale client at startup.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production \
    PORT=8787 \
    MCP_AUTH_MODE=path

EXPOSE 8787
CMD ["node", "src/server.js"]
