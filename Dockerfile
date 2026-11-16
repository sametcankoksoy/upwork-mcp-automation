FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install system dependencies: Node.js 20, Google Chrome Stable, Xvfb, FFmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    curl \
    gnupg \
    ca-certificates \
    xvfb \
    ffmpeg \
    libnss3 \
    libxss1 \
    libasound2 \
    libgbm1 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    fonts-liberation \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && (dpkg -i /tmp/chrome.deb || apt-get install -fy) \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python packages
RUN pip install --no-cache-dir seleniumbase opencv-python-headless numpy

# Install Node.js dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application files
COPY . .

ENV NODE_ENV=production
ENV PORT=3050

EXPOSE 3050

CMD ["node", "src/server.js"]
