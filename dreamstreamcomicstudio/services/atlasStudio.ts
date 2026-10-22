/**
 * Atlas Studio — DreamStream's search-everything workspace, a separate app with its own
 * accounts and UI at its own subdomain (repo Akhielesh/AtlasD, Worker `atlas-studio`).
 * DreamStream only links to it.
 */
export const ATLAS_STUDIO_URL = 'https://atlas.dreamstreamstudio.ai';

/** The sources Atlas Studio connects today (its public beta set) — keep in step with AtlasD lib/shared/beta-policy.ts. */
export const ATLAS_STUDIO_SOURCES = ['Google Drive', 'Gmail', 'OneDrive', 'Outlook', 'Dropbox', 'Box', 'Notion', 'Slack'] as const;

export function openAtlasStudio(): void {
  window.location.href = ATLAS_STUDIO_URL;
}
