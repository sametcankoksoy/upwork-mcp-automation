FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install Python 3, pip, Google Chrome, Xvfb, FFmpeg and GUI libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    curl \
    gnupg \
    ca-certificates \
    python3 \
    python3-pip \
    xvfb \
    ffmpeg \
    libnss3 \
    libxss1 \
    libasound2 \
    libgbm1 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    fonts-liberation \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && (dpkg -i /tmp/chrome.deb || apt-get install -fy) \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python packages
RUN pip3 install --no-cache-dir --break-system-packages seleniumbase opencv-python-headless numpy

# Install Node.js dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy all application files
COPY . .

ENV NODE_ENV=production
ENV PORT=3050

EXPOSE 3050

CMD ["node", "src/server.js"]
