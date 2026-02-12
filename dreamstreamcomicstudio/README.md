<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# DreamStream Comic Studio

This repo contains a Vite frontend and an Express backend for AI-assisted comic creation.

View your app in AI Studio: https://ai.studio/apps/drive/1d-B3sVO_Hn-GiGYMPPzQ9Xz2mIOgkW5e

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Copy `.env.example` to `.env.local` (optional if you plan to use BYOK in the UI):
   `cp .env.example .env.local`
3. Start the backend API:
   `npm run dev:server`
4. Start the Vite client:
   `npm run dev`

## Production Hardening and Deployment

Production artifacts are in:

1. `docs/production/README.md`
2. `docs/production/part1-hardening.md`
3. `docs/production/deployment-runbook.md`
4. `docs/production/go-live-checklist.md`
5. `docs/production/alerting-thresholds.md`
6. `docs/production/scaling-and-cost.md`
7. `docs/production/load-test-plan.md`
8. `docs/production/supabase-auth-checklist.md`

## Verification Commands

Run these before each deploy:

1. `npm run typecheck`
2. `npm run build`
3. `npm run build:server`

Optional operational checks:

1. `scripts/ops/verify-cors.sh`
2. `scripts/ops/verify-rate-limit.sh`

### API Keys (BYOK)
This app is configured for public deployment with **Bring Your Own Key**:

- Add your Gemini API key in Settings (stored in localStorage).
- Add your Pixazo Flux key in Settings (stored in localStorage).

Server-side keys are optional and **never** embedded into the client bundle.
