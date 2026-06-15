FROM node:18-slim

WORKDIR /app

COPY package*.json ./

RUN npm ci

# 1. This step installs the native dumb-init package directly into the OS
RUN apt-get update && apt-get install -y dumb-init --no-install-recommends && rm -rf /var/lib/apt/lists/*

RUN npx playwright install --with-deps --only-shell chromium

COPY . .

EXPOSE 3000

# 2. Execute dumb-init natively without npx
CMD ["dumb-init", "node", "server.js"]