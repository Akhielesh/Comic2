// Bridge between the chat and the dedicated, cross-origin-isolated Code Studio tab.
// The artifact is too big for a URL, so we stash it in localStorage under a one-shot
// id and open /studio.html?id=… ; the Studio reads it once and clears it.

import JSZip from 'jszip';
import type { CodeStudioArtifact } from '../apiTypes';

const PREFIX = 'dreamstream_studio_payload:';

/** Stash the project and open the full WebContainer Studio in a new tab. */
export const openInStudio = (artifact: CodeStudioArtifact): void => {
  const id = (crypto.randomUUID?.() || String(Date.now()));
  try {
    localStorage.setItem(PREFIX + id, JSON.stringify(artifact));
  } catch {
    /* quota — fall through; the Studio will show an empty state */
  }
  window.open(`/studio.html?id=${id}`, '_blank', 'noopener');
};

/** Read (and consume) the handed-off project inside the Studio tab. */
export const readStudioPayload = (): CodeStudioArtifact | null => {
  const id = new URLSearchParams(window.location.search).get('id');
  if (!id) return null;
  const raw = localStorage.getItem(PREFIX + id);
  if (raw) localStorage.removeItem(PREFIX + id);
  try {
    return raw ? (JSON.parse(raw) as CodeStudioArtifact) : null;
  } catch {
    return null;
  }
};

/** Download the project as a .zip (used from both the chat card and the Studio). */
export const downloadProjectZip = async (
  title: string,
  files: Record<string, string>
): Promise<void> => {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path.replace(/^\/+/, ''), content);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(title || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app'}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** Convenience: zip straight from an artifact's own file list. */
export const downloadArtifactZip = (artifact: CodeStudioArtifact): Promise<void> => {
  const files: Record<string, string> = {};
  for (const f of artifact.files) files[f.path] = f.content;
  return downloadProjectZip(artifact.title, files);
};
