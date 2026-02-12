type LegacyNavigator = Navigator & {
  msSaveOrOpenBlob?: (blob: Blob, defaultName?: string) => boolean;
};

const ensureExtension = (name: string, mimeType?: string) => {
  const trimmed = (name || '').trim();
  if (!trimmed) return 'download.bin';
  if (trimmed.includes('.')) return trimmed;

  if (!mimeType) return `${trimmed}.bin`;
  if (mimeType.includes('pdf')) return `${trimmed}.pdf`;
  if (mimeType.includes('zip')) return `${trimmed}.zip`;
  if (mimeType.includes('json')) return `${trimmed}.json`;
  if (mimeType.includes('html')) return `${trimmed}.html`;
  if (mimeType.includes('png')) return `${trimmed}.png`;
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return `${trimmed}.jpg`;
  if (mimeType.includes('webp')) return `${trimmed}.webp`;
  return `${trimmed}.bin`;
};

export const downloadBlob = (blob: Blob, filename: string) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const safeFilename = ensureExtension(filename, blob.type);

  const nav = window.navigator as LegacyNavigator;
  if (typeof nav.msSaveOrOpenBlob === 'function') {
    nav.msSaveOrOpenBlob(blob, safeFilename);
    return;
  }

  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFilename;
  link.setAttribute('download', safeFilename);
  if (blob.type) link.type = blob.type;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  // Dispatching a MouseEvent is more reliable across Chromium variants.
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

  // Keep blob URLs alive longer; early revocation can produce broken downloads on some Chromium builds.
  window.setTimeout(() => {
    window.URL.revokeObjectURL(url);
    link.remove();
  }, 10 * 60 * 1000);
};
