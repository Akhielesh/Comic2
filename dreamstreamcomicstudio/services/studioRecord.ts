// Client-side screen recording of the live preview → a downloadable .webm/.mp4.
// No server, no data egress: uses the browser's getDisplayMedia + MediaRecorder; the user picks
// the tab/window to capture and the file is written locally. No-op (returns null) outside a
// capable browser, so it's safe to import anywhere.

export interface ActiveRecording { stop: () => void; }

export const screenRecordingSupported = (): boolean =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices &&
  typeof navigator.mediaDevices.getDisplayMedia === 'function' &&
  typeof (globalThis as { MediaRecorder?: unknown }).MediaRecorder !== 'undefined';

const pickMime = (): string => {
  const MR = (globalThis as { MediaRecorder?: { isTypeSupported?: (m: string) => boolean } }).MediaRecorder;
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
    try { if (MR?.isTypeSupported?.(m)) return m; } catch { /* ignore */ }
  }
  return 'video/webm';
};

const downloadBlob = (blob: Blob, filename: string): void => {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch { /* best-effort */ }
};

const slug = (s: string): string =>
  (s || 'preview').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'preview';

/**
 * Start recording the screen/tab. Resolves with a handle whose `stop()` finalizes the recording and
 * downloads the video. Returns null if unsupported or the user denies the picker.
 */
export const startPreviewRecording = async (title = 'preview'): Promise<ActiveRecording | null> => {
  if (!screenRecordingSupported()) return null;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 } as MediaTrackConstraints, audio: false });
  } catch {
    return null; // user cancelled the share picker
  }
  const mime = pickMime();
  const Rec = (globalThis as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder;
  const rec = new Rec(stream, { mimeType: mime });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    downloadBlob(new Blob(chunks, { type: mime }), `${slug(title)}.${ext}`);
  };
  // If the user stops sharing via the browser's own control, finalize cleanly.
  stream.getVideoTracks()[0]?.addEventListener('ended', () => { try { rec.stop(); } catch { /* ignore */ } });
  rec.start();
  return { stop: () => { try { rec.stop(); } catch { /* ignore */ } } };
};
