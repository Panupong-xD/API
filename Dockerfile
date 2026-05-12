FROM node:18-alpine

WORKDIR /usr/src/app

# Run in production
ENV NODE_ENV=production
ENV TOKEN_FILE=data/token.json

# Install only production deps (keep image small)
COPY package.json package-lock.json* ./
RUN npm install --production --silent --no-audit --no-fund

# Copy app
COPY . .

# Prepare data folder for token persistence
RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app
USER node

EXPOSE 3000

# Limit Node memory to avoid OOM on tiny VMs
CMD ["node", "--max-old-space-size=256", "server.js"]
