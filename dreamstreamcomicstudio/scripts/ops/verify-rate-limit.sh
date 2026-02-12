#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${1:-http://localhost:7071}"
COUNT="${2:-300}"
TARGET_PATH="${3:-/api/system/status}"

echo "Sending ${COUNT} requests to ${API_BASE_URL}${TARGET_PATH}"

for i in $(seq 1 "${COUNT}"); do
  code="$(curl -s -o /dev/null -w "%{http_code}" "${API_BASE_URL}${TARGET_PATH}")"
  printf "%s\n" "${code}"
done | sort | uniq -c
