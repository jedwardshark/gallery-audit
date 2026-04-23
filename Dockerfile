# Playwright base image ships with Chromium + all system dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# Install Node dependencies (cached layer — only reruns when package.json changes)
COPY package*.json ./
RUN npm ci

# Copy application code and committed data
COPY . .

# Render (and most cloud platforms) inject PORT via environment variable
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
