#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${1:-http://localhost:7071}"
ORIGIN="${2:-https://unknown.example.com}"

echo "Checking CORS rejection for origin: ${ORIGIN}"

curl -s -o /tmp/cors_check_body.txt -D /tmp/cors_check_headers.txt \
  "${API_BASE_URL}/api/system/status" \
  -H "Origin: ${ORIGIN}" >/dev/null

STATUS_LINE="$(head -n 1 /tmp/cors_check_headers.txt)"
echo "Response: ${STATUS_LINE}"
cat /tmp/cors_check_body.txt
