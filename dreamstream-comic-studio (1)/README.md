<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

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

### API Keys (BYOK)
This app is configured for public deployment with **Bring Your Own Key**:
- Add your Gemini API key in Settings (stored in localStorage).
- Add your Pixazo Flux key in Settings (stored in localStorage).

Server-side keys are optional and **never** embedded into the client bundle.
