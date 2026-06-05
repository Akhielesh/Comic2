# DreamStream Studio container image.
#
# Node-only to start (smallest image / fastest cold start; covers React/Vite/Next/
# Express/static — the vast majority of what the AI builds). Built on the Cloudflare
# Sandbox base image, which already ships Node + npm + a Linux toolchain.
#
# The base image tag MUST match the @cloudflare/sandbox npm version (package.json) — they
# move together. Pinned to 0.4.18 (verified: the worker typechecks against this SDK).
FROM docker.io/cloudflare/sandbox:0.4.18

WORKDIR /workspace

# To make cold starts faster later, pre-install global tooling and warm a dependency
# cache here, e.g.:
#   RUN npm install -g pnpm
#   COPY templates/vite-react/package*.json ./ && RUN npm install   # pre-warmed cache
EXPOSE 3001
