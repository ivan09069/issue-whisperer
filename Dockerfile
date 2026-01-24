FROM node:20-slim

# Install Python for analyzer
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps
COPY package.json ./
RUN npm install --omit=dev

# Install Python deps
COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt

# Copy app
COPY . .

EXPOSE 3000

CMD ["node", "app.js"]
