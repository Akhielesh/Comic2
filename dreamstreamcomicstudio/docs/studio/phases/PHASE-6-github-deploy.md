# Phase 6 — GitHub sync + one-click deploy

**Status:** 📋 planned · **Depends on:** Phase 5 · **Effort:** 3–5 days · **See:** [07-INTEGRATIONS.md](../07-INTEGRATIONS.md)

## Goal
Ship what you built: connect a GitHub repo (two-way), and deploy to a public URL in one click.

## Tasks — GitHub
1. GitHub OAuth/App connect; store token encrypted (`services/crypto.ts` / `user_api_keys`).
2. `POST /api/studio/github/connect|repos|push|pull`:
   - push: create/select repo → commit `studio_files` tree → branch + optional PR.
   - pull: fetch tree → update `studio_files` → new `studio_version`.
3. `GitHubMenu.tsx` — connect, repo picker, commit, open PR, sync status.

## Tasks — Deploy
1. `POST /api/studio/deploy` — build the project + publish to **Cloudflare Pages/Workers**;
   write a `studio_deployments` row + set `studio_projects.deploy_url`.
2. `DeployMenu.tsx` — target, build status (queued→building→live→failed), public URL, redeploy.
3. Later targets: Vercel/Netlify (token); "export .zip / push to GitHub".

## Acceptance criteria
- Connect a repo, push the project, see the commit on GitHub; pull reflects remote changes.
- One-click deploy produces a working public URL shown in the UI and saved to the project.
- Tokens stored encrypted; RLS respected; failures surface clearly.
- Client + server typecheck; tests for the GitHub client + deploy job.

## Files
- new: `server/src/routes/studioGithub.ts`, `server/src/services/studioDeploy.ts`,
  `components/chat/studio/{GitHubMenu,DeployMenu}.tsx`
- edit: `server/src/routes/studio.ts`, `StudioShell.tsx`, data model (deploy/repo fields)
