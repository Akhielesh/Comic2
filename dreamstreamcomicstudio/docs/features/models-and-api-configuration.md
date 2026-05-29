# Models & API Configuration

How users bring keys, choose models, and how those choices reach generation.

## API Configuration (`components/ApiConfiguration.tsx`)

- Compact **accordion** — one collapsible card per provider (OpenRouter, Gemini,
  Pixazo). Collapsed shows: provider, key count, active key + usage %. Click to expand.
- Per provider: add multiple keys (label + key + optional monthly limit), pick the
  **active** key, edit, delete. Usage meters per key.
- Backed by `services/apiKeys.ts` (localStorage, one active per provider, per-key
  monthly limit + usage, monthly reset). The active key is sent on every request by
  `services/apiClient.ts`; an over-limit active key blocks generation (see ADR 0003).

## Model Library (`components/ModelLibrary.tsx`)

- **Live** catalog from OpenRouter via `/api/models/catalog` → `services/modelCatalog.ts`
  (`fetchModelCatalog`). Free models are flagged from live pricing, so models OpenRouter
  makes free appear automatically. Filters: All / Free / Image / Text / Reference-capable
  + search.
- Each model is annotated (server: `server/src/ai/catalogAnnotations.ts`) with cost band,
  roles, "what's possible", drawbacks, and an editorial note; the detail modal also shows
  real pricing (input/output $/Mtok, $/image).
- **Use this model** (card + detail + compare): a quick inline confirm sets the model as
  your Image or Text choice (slot derived from whether it outputs images).
- **Compare up to 5**: select models into the compare tray, open a side-by-side table
  (cost, capabilities, context, pricing, roles, best-for / watch-out), and pick from there.

## Model selection (`services/modelSelection.ts`)

- Stores `{ mode, imageModel, textModel }` (concrete OpenRouter ids; null = server default).
- `getSelectedImageModel()` is sent by `services/geminiService.ts` to
  `/api/image/openrouter` so the user's chosen image model is used. Text selection is
  stored for the OpenRouter text route / assistant (the Gemini text pipeline migration is
  a separate step — ADR 0001).
- A `Default` / `Free` / `Specific` mode is exposed; "Free" + the library's Free filter let
  a user run on free models when OpenRouter offers them.

## Flow

1. Settings → API Configuration: add a key (e.g. OpenRouter), mark it active.
2. Model Library: filter Free (or any), **Use this model** for image/text, or Compare first.
3. Generate: `apiClient` sends the active key; the image path sends the selected image
   model and records real cost against the active key.
