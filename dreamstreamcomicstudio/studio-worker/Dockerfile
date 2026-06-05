# DreamStream Studio container image.
#
# Node-only to start (smallest image / fastest cold start; covers React/Vite/Next/
# Express/static — the vast majority of what the AI builds). Built on the Cloudflare
# Sandbox base image, which already ships Node + npm + a Linux toolchain.
#
# Pin the tag to match the @cloudflare/sandbox version you install (check the SDK's
# docs/release notes — the base image and the npm package version move together).
FROM docker.io/cloudflare/sandbox:0.4.3

WORKDIR /workspace

# To make cold starts faster later, pre-install global tooling and warm a dependency
# cache here, e.g.:
#   RUN npm install -g pnpm
#   COPY templates/vite-react/package*.json ./ && RUN npm install   # pre-warmed cache
EXPOSE 3001
