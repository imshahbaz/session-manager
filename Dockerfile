FROM node:18-slim

# Install minimal OS dependencies required for Chromium to run headlessly
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    dumb-init \
    libglib2.0-0 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxcb1 \
    libxkbcommon0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libgbm1 \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Installs dependencies AND instructs playwright to only download the minimal Chromium binary
RUN npm ci
RUN npx playwright install chromium

COPY . .

EXPOSE 3000

# Using dumb-init handles PID 1 issues to avoid Chromium process zombies leaking RAM over time
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]