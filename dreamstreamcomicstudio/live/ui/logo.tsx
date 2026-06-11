// Stream Studio brand mark — an on-air tile: rounded square, broadcast arcs
// and a live dot. One component everywhere (rail, topbars, slates) so the
// brand can't drift; the standalone asset lives at public/stream-studio.svg.
import React from 'react';

export function StreamStudioMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role="img"
      aria-label="Stream Studio"
    >
      <rect x="2" y="2" width="44" height="44" rx="12" fill="var(--accent, #c2603f)" />
      <g stroke="var(--on-accent, #fdfbf7)" strokeWidth="3.4" strokeLinecap="round" fill="none">
        <path d="M14.5 31.5a9.5 9.5 0 0 1 0-13.4" opacity=".55" />
        <path d="M33.5 18.1a9.5 9.5 0 0 1 0 13.4" opacity=".55" />
        <path d="M19.4 27.4a4.8 4.8 0 0 1 0-6.8" />
        <path d="M28.6 20.6a4.8 4.8 0 0 1 0 6.8" />
      </g>
      <circle cx="24" cy="24" r="3.6" fill="var(--on-accent, #fdfbf7)" />
    </svg>
  );
}

/** Mark + wordmark, the standard lockup for top bars and the side rail. */
export function StreamStudioLogo({ size = 26, wordmark = true, className }: { size?: number; wordmark?: boolean; className?: string }) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <StreamStudioMark size={size} />
      {wordmark && (
        <span className="logo-text" style={{ whiteSpace: 'nowrap' }}>
          Stream <span className="sub">Studio</span>
        </span>
      )}
    </span>
  );
}
