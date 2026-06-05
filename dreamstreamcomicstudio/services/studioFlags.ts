// Feature flags for the Code Studio surfaces. Dependency-free so the standalone
// /studio.html bundle can import them without pulling in the API client.

const flag = (value: unknown): boolean => String(value ?? '').toLowerCase() === 'true';

/**
 * Whether the live (Cloudflare container) Studio path is enabled in this build.
 * Off by default — the owner flips VITE_STUDIO_LIVE_ENABLED=true after deploying the
 * Studio Worker (see docs/studio/OWNER-ACTIONS.md), so production is unaffected until then.
 * Admins are never feature-gated, so the UI typically checks `isLiveStudioEnabled() || isAdmin`.
 */
export const isLiveStudioEnabled = (): boolean => flag(import.meta.env.VITE_STUDIO_LIVE_ENABLED);

/**
 * Whether the **legacy** in-browser studio engines (the WebContainer page at /studio.html
 * and the Sandpack chat side-panel) are enabled. OFF by default: Code Studio consolidates on
 * one path (the live container), so these are quarantined behind this dead flag rather than
 * deleted (Sprint 0, S0.2 — decisions D2/D3). Set VITE_LEGACY_STUDIO_ENABLED=true to revive
 * them for debugging only.
 */
export const isLegacyStudioEnabled = (): boolean => flag(import.meta.env.VITE_LEGACY_STUDIO_ENABLED);
