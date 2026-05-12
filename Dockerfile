FROM node:20-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV PORT=8080

# install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund --prefer-offline

# copy app
COPY . .

# create non-root user and set ownership
RUN addgroup -S appgroup && adduser -S appuser -G appgroup && chown -R appuser:appgroup /usr/src/app
USER appuser

EXPOSE 8080

CMD ["node", "server.js"]
