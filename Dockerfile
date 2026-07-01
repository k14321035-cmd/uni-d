FROM node:20-alpine

# Install Python and FFmpeg (required for yt-dlp merging)
RUN apk add --no-cache python3 py3-pip ffmpeg curl

# Install yt-dlp via pip (the recommended way on Linux)
RUN pip install --no-cache-dir -U yt-dlp --break-system-packages

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the app
COPY . .

# Build the frontend and backend
RUN npm run build

# Start the server
EXPOSE 3000
CMD ["npm", "start"]
