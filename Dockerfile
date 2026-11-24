FROM node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/patch-meshcore-decoder.js ./scripts/patch-meshcore-decoder.js

RUN npm ci --omit=dev --no-audit --fund=false

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY regions ./regions
COPY region-scopes.example.yml ./
COPY README.md HOWTO.md ENVIRONMENT.md AGENTS.md CHANGES.md LICENSE ./
COPY LICENSES ./LICENSES

ENV NODE_ENV=production
EXPOSE 3090

CMD ["node", "server.js"]
