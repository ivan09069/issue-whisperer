FROM node:20-slim

# Install Python for analyzer
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps
COPY package*.json ./
RUN npm ci --only=production

# Install Python deps
COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt

# Copy app
COPY . .

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1))"

EXPOSE 3000

CMD ["node", "app.js"]
