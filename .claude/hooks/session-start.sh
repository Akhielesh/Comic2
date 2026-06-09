#!/bin/bash
# Claude Code on the web — SessionStart hook for DreamStream Comic Studio.
#
# Installs npm dependencies so typecheck / build / tests work the moment a
# session starts, writes safe placeholder env vars for the few values that are
# read at IMPORT time (so tests/linters/builds run out of the box), and flags any
# required env vars that are unset (names only — never prints secret values).
# Idempotent; safe to re-run.
set -euo pipefail

# Repo root: CLAUDE_PROJECT_DIR in real sessions; derived from this script's
# location when run by hand for validation.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
APP_DIR="$PROJECT_DIR/dreamstreamcomicstudio"

# Only do heavy setup in remote (web) sessions; local dev manages its own env.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

echo "[session-start] Installing npm dependencies in dreamstreamcomicstudio ..."
cd "$APP_DIR"
npm install --no-audit --no-fund

# Test/build placeholders. The Supabase client is constructed at MODULE IMPORT
# (services/supabase.ts → createClient), which throws "supabaseUrl is required" when
# the URL/key are unset — that crashes `npm test`, `typecheck` and `build` even though
# none of them touch a real database. Write obviously-fake placeholders for ONLY those
# import blockers, and ONLY when they aren't already configured, so the toolchain runs
# out of the box. Real secrets are still set via environment settings and are never
# overwritten here.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  applied=()
  set_placeholder() {
    local key="$1" val="$2"
    if [ -z "${!key:-}" ]; then
      echo "export ${key}=\"${val}\"" >> "$CLAUDE_ENV_FILE"
      applied+=("$key")
    fi
  }
  set_placeholder VITE_SUPABASE_URL "https://placeholder.supabase.co"
  set_placeholder VITE_SUPABASE_ANON_KEY "placeholder-anon-key"
  set_placeholder SUPABASE_URL "https://placeholder.supabase.co"
  set_placeholder SUPABASE_ANON_KEY "placeholder-anon-key"
  if [ "${#applied[@]}" -gt 0 ]; then
    echo "[session-start] Applied test/build placeholders so the toolchain runs"
    echo "                (fake values; set real ones in environment settings): ${applied[*]}"
  fi
fi

# Surface required env vars that are unset (names only, never values). Only
# considers keys with NO default in .env.example (i.e. "KEY=" with empty value),
# since those are the ones that genuinely must be configured.
if [ -f "$APP_DIR/.env.example" ]; then
  missing=()
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    [ -z "${!key:-}" ] && missing+=("$key")
  done < <(grep -vE '^\s*#' "$APP_DIR/.env.example" | sed -nE 's/^([A-Za-z_][A-Za-z0-9_]*)=[[:space:]]*$/\1/p' | sort -u)
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "[session-start] ${#missing[@]} required env var(s) are unset"
    echo "                (configure in the environment settings; values are never printed):"
    printf '  - %s\n' "${missing[@]}"
  fi
fi

echo "[session-start] Ready."
