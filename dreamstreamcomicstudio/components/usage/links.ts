// Links into the account's own pages, shared by the usage meter and the studios. A plain module (no
// component), so a controller hook can import a link without pulling a UI component into its graph.

/** Deep link into Settings → API keys (App.tsx restores ?view=settings&tab=settings). */
export const API_KEYS_HREF = '/?view=settings&tab=settings';
