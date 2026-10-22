// The share link as a QR code, drawn on this device (live/monitor/qr.ts) —
// never by an online QR service, which would see the link's secret part.
// Always black on a white tile with the standard 4-module quiet zone, in both
// themes: phone cameras read dark-on-light codes far more reliably.
import React, { useMemo } from 'react';
import { encodeQr, qrPath } from '../../monitor/qr';

export function QrCode({ text, size = 168, label = 'QR code for the share link' }: { text: string; size?: number; label?: string }) {
  const qr = useMemo(() => {
    try {
      return encodeQr(text);
    } catch {
      return null; // longer than a version-10 code holds — the link is shown as text anyway
    }
  }, [text]);
  if (!qr) return null;
  const n = qr.size + 8;
  // A whole number of pixels per module: even, sharp squares read far better from a screen.
  const px = Math.max(2, Math.round(size / n)) * n;
  return (
    <svg className="qr-svg" viewBox={`0 0 ${n} ${n}`} width={px} height={px} role="img" aria-label={label} shapeRendering="crispEdges" data-version={qr.version}>
      <rect width={n} height={n} fill="#fff" />
      <path d={qrPath(qr, 4)} fill="#000" />
    </svg>
  );
}
