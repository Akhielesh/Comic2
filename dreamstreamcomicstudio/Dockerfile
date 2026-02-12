FROM node:20-slim

WORKDIR /app

# Copy root package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the backend server
RUN npm run build:server

# Expose the API port
EXPOSE 7071

# Start the server
CMD ["npm", "run", "start:server"]
