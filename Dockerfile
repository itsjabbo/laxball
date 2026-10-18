# Multi-arch base image: works on Raspberry Pi (arm64 and 32-bit armv7) as well as x86 PCs.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production PORT=7777

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

EXPOSE 7777
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||7777)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server/index.js"]
