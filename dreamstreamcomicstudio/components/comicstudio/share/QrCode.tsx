// QR code for a share link (uqr, MIT, zero deps → inline SVG; error correction M, quiet zone 4).
// The SVG is drawn from the module matrix as one path; "Download PNG" rasterizes it on a canvas.

import React, { useMemo } from 'react';
import { Download } from 'lucide-react';
import { encode } from 'uqr';
import { fileNameFor } from './shareModel';
import { cx } from '../conversation/ui';

export interface QrCodeProps {
  value: string;
  /** Rendered size in CSS px (default 192). */
  size?: number;
  title?: string;
  className?: string;
  /** Show the "Download PNG" button. */
  downloadable?: boolean;
}

/** The module matrix (quiet zone included) — exported for the round-trip test. */
export function qrMatrix(value: string): boolean[][] {
  return encode(value, { ecc: 'M', border: 4 }).data;
}

function pathFor(matrix: boolean[][]): string {
  let d = '';
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
    }
  });
  return d;
}

async function downloadPng(matrix: boolean[][], name: string): Promise<void> {
  const scale = 12;
  const n = matrix.length;
  const canvas = document.createElement('canvas');
  canvas.width = n * scale;
  canvas.height = n * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  matrix.forEach((row, y) => row.forEach((on, x) => on && ctx.fillRect(x * scale, y * scale, scale, scale)));
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.click();
}

export const QrCode: React.FC<QrCodeProps> = ({ value, size = 192, title, className, downloadable }) => {
  const matrix = useMemo(() => qrMatrix(value), [value]);
  const n = matrix.length;
  return (
    <div className={cx('flex flex-col items-center gap-2', className)}>
      <svg
        role="img"
        aria-label={`QR code for ${value}`}
        viewBox={`0 0 ${n} ${n}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
        className="max-w-full rounded-xl bg-white"
        data-qr-size={n}
      >
        <rect width={n} height={n} fill="#ffffff" />
        <path d={pathFor(matrix)} fill="#000000" />
      </svg>
      {downloadable && (
        <button
          type="button"
          onClick={() => void downloadPng(matrix, fileNameFor(title || 'comic-qr', 'png'))}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
        >
          <Download className="h-4 w-4" aria-hidden /> Download PNG
        </button>
      )}
    </div>
  );
};

export default QrCode;
