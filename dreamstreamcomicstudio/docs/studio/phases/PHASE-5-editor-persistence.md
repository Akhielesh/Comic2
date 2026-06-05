# Phase 5 — Editor + persistence

**Status:** 📋 planned · **Depends on:** Phase 3 · **Effort:** 3–5 days · **See:** [06-DATA-MODEL.md](../06-DATA-MODEL.md)

## Goal
"Dive into the code": a real editor + file tree, and durable, versioned projects so
nothing is lost and users can re-open / diff / restore.

## Tasks
1. **Persistence (data model):** create the migration `server/sql/studio_tables.sql`
   (`studio_projects/files/versions/runs/deployments`) with owner RLS. Server CRUD:
   `server/src/routes/studio.ts` (projects/files/versions endpoints) + `repositories`.
2. **Save on build:** first build creates a project + files + version; each successful
   agent build snapshots a new `studio_version`.
3. **Editor:** `CodeEditor.tsx` (Monaco) replacing the `<textarea>` in `studio/StudioApp.tsx`
   — syntax highlighting, multi-file, diff view; write edits into the live container (HMR)
   and persist (debounced) to `studio_files`.
4. **File tree:** `FileTree.tsx` — list, active highlight, "modified" badges, add/rename/delete.
5. **Inline AI edit:** "ask AI to change this file" → routes through the FIX stage on one file.
6. **History UI:** list versions; diff against current; restore.
7. **Re-open:** loading a project re-mounts files into a fresh container (files come from
   Supabase, so a slept/evicted container is rehydrated transparently).

## Acceptance criteria
- A project survives reload, sleep, and re-open with all files intact.
- Editing a file hot-reloads the preview and persists; versions are created on build.
- Diff + restore work; RLS prevents cross-user access (test).
- Client + server typecheck; tests for repositories + RLS.

## Files
- new: `server/sql/studio_tables.sql`, `server/src/comicforge`-style `studio` repositories,
  `components/chat/studio/{CodeEditor,FileTree,VersionHistory}.tsx`
- edit: `server/src/routes/studio.ts`, `services/studioLauncher.ts`, `StudioShell.tsx`
