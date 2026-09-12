# node:22-slim
FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/patch-meshcore-decoder.js ./scripts/patch-meshcore-decoder.js

RUN npm ci --omit=dev --no-audit --fund=false

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY regions ./regions
COPY README.md HOWTO.md ENVIRONMENT.md AGENTS.md CHANGES.md ./

ENV NODE_ENV=production
EXPOSE 3090

CMD ["node", "server.js"]
