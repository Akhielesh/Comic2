// The public reader's cover card (reader.md §2.1, sharing.md §7.2): the cover on the reading-room
// colour, the title, logline, "by …", page count and reading direction, then **Read** (the immersive
// reader with its cover intro — the click is the gesture fullscreen needs) and **Guided** (panel by
// panel). It paints instantly from the server-injected boot card, before the comic itself arrives.
// The room is the same in both themes (like the immersive reader), so its ink is fixed white.

import React from 'react';
import { BookOpen, Rows3, ScanEye, Sparkles } from 'lucide-react';
import type { ContentRating } from '../../../shared/comic/safety';
import { RatingBadge } from '../safety/RatingBadge';

export interface ReaderCoverCardProps {
  title: string;
  logline?: string;
  /** Public creator name (only when the author chose to show it). */
  creator?: string;
  coverUrl?: string;
  /** Cover width / height. */
  aspect?: number;
  pageCount?: number;
  kindLabel?: string;
  rtl?: boolean;
  rating?: ContentRating;
  /** #rrggbb from the share card: tints the room. */
  themeColor?: string;
  /** The comic is still on its way (buttons wait, the cover already shows). */
  loading?: boolean;
  onRead(): void;
  onGuided?(): void;
  /** Read inline, on this page (no full screen). */
  onReadHere?(): void;
  /** Footer call to action (hidden in embeds). */
  cta?: { label: string; href: string };
  labels?: { read?: string; guided?: string; readHere?: string; readsRightToLeft?: string };
  /** The cover image failed (expired link). */
  onCoverError?(): void;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

const roomBackground = (themeColor?: string): string => {
  if (!themeColor || !HEX.test(themeColor)) return 'radial-gradient(120% 90% at 50% 30%, rgba(217,119,87,0.16), transparent 70%), var(--ds-reader-room)';
  const r = parseInt(themeColor.slice(1, 3), 16);
  const g = parseInt(themeColor.slice(3, 5), 16);
  const b = parseInt(themeColor.slice(5, 7), 16);
  return `radial-gradient(120% 90% at 50% 30%, rgba(${r},${g},${b},0.28), transparent 70%), var(--ds-reader-room)`;
};

const BTN =
  'press inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-[14px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-reader-room)] disabled:cursor-wait disabled:opacity-60 touch-manipulation';

export const ReaderCoverCard: React.FC<ReaderCoverCardProps> = ({
  title,
  logline,
  creator,
  coverUrl,
  aspect,
  pageCount,
  kindLabel,
  rtl,
  rating,
  themeColor,
  loading,
  onRead,
  onGuided,
  onReadHere,
  cta,
  labels,
  onCoverError
}) => {
  const a = aspect && Number.isFinite(aspect) && aspect > 0.2 && aspect < 5 ? aspect : 2 / 3;
  const meta = [
    creator ? `by ${creator}` : null,
    kindLabel || null,
    typeof pageCount === 'number' && pageCount > 0 ? `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : null,
    rtl ? labels?.readsRightToLeft || 'Reads right to left' : null
  ].filter(Boolean) as string[];
  return (
    <section
      data-testid="reader-cover-card"
      aria-label={title}
      className="relative flex min-h-full w-full flex-col items-center justify-center overflow-hidden px-4 py-6 text-white"
      style={{ background: roomBackground(themeColor) }}
    >
      <div className="flex w-full max-w-[min(100%,34rem)] flex-col items-center gap-4">
        <div
          className="relative overflow-hidden rounded-[6px] bg-white/5 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
          // Fits the room: never taller than ~52% of the viewport, never wider than the column.
          style={{ aspectRatio: String(a), width: `min(100%, calc(52dvh * ${a.toFixed(4)}), 22rem)` }}
        >
          {coverUrl ? (
            <img src={coverUrl} alt={`Cover of ${title}`} className="absolute inset-0 h-full w-full object-cover" decoding="async" onError={onCoverError} />
          ) : (
            <div className="studio-shimmer absolute inset-0" role="img" aria-label={loading ? 'Loading cover' : `Cover of ${title}`} />
          )}
        </div>
        <div className="flex w-full min-w-0 flex-col items-center gap-1.5 text-center">
          <h1 className="max-w-full text-[22px] font-semibold leading-tight tracking-tight [overflow-wrap:anywhere] sm:text-[26px]">{title}</h1>
          {logline && <p className="line-clamp-3 max-w-full text-[14px] leading-snug text-white/75 [overflow-wrap:anywhere]">{logline}</p>}
          {(meta.length > 0 || rating) && (
            <div className="flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[12px] text-white/70">
              {rating && <RatingBadge rating={rating} />}
              {meta.map((m, i) => (
                <span key={m} className="inline-flex min-w-0 items-center gap-2">
                  {i > 0 || rating ? <span aria-hidden>·</span> : null}
                  <span className="min-w-0 truncate">{m}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
          <button type="button" onClick={onRead} disabled={loading} aria-busy={loading || undefined} className={`${BTN} bg-[var(--ds-accent)] text-white hover:bg-[var(--ds-accent-hover)]`}>
            <BookOpen className="h-4 w-4" aria-hidden /> {loading ? 'Opening…' : labels?.read || 'Read'}
          </button>
          {onGuided && (
            <button type="button" onClick={onGuided} disabled={loading} className={`${BTN} bg-white/15 text-white hover:bg-white/25`}>
              <ScanEye className="h-4 w-4" aria-hidden /> {labels?.guided || 'Guided View'}
            </button>
          )}
        </div>
        {onReadHere && (
          <button
            type="button"
            onClick={onReadHere}
            disabled={loading}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[13px] text-white/75 underline-offset-4 outline-none hover:text-white hover:underline focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] disabled:opacity-50"
          >
            <Rows3 className="h-3.5 w-3.5" aria-hidden /> {labels?.readHere || 'Read on this page'}
          </button>
        )}
      </div>
      {cta && (
        <a
          href={cta.href}
          className="mt-6 inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full px-3 text-[12px] text-white/60 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]"
          style={{ marginBottom: 'var(--sa-bottom)' }}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{cta.label}</span>
        </a>
      )}
    </section>
  );
};

export default ReaderCoverCard;
