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

# Cap the V8 heap so the JS old-space can't lazily balloon and inflate the Railway
# memory bill. This is a safe default for the single always-on instance; override it
# with a Railway service variable of the same name if you scale the box up.
ENV NODE_OPTIONS="--max-old-space-size=512"

# Start the server
CMD ["npm", "run", "start:server"]
