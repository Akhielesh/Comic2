// Cover intro (reader.md §6.1; decisions-final #11: immersive only, once per session per comic).
// The room fades up from black, the closed book rises onto the desk, the title writes itself in, and
// a hint invites the first turn. Any input skips straight to reading — a tap or swipe opens the cover
// with the hardcover turn. Reduced motion: a still composition with a short fade.

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

export interface CoverIntroProps {
  title: string;
  logline?: string;
  author?: string;
  reduced: boolean;
  rtl: boolean;
  /** The book wrapper to raise (WAAPI; no React render per frame). */
  bookEl: HTMLElement | null;
  /** Open the book (tap / swipe / key) — the cover turns. */
  onOpen(): void;
}

const HOUSE: [number, number, number, number] = [0.2, 0.7, 0.2, 1];

export const CoverIntro: React.FC<CoverIntroProps> = ({ title, logline, author, reduced, rtl, bookEl, onOpen }) => {
  const [hint, setHint] = useState(false);

  useEffect(() => {
    if (!bookEl || typeof bookEl.animate !== 'function') return;
    const anim = reduced
      ? bookEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' })
      : bookEl.animate(
          [
            { opacity: 0, transform: 'perspective(1400px) translateY(24px) rotateX(8deg) scale(0.94)' },
            { opacity: 1, transform: 'perspective(1400px) translateY(0) rotateX(0deg) scale(1)' }
          ],
          { duration: 700, delay: 120, easing: `cubic-bezier(${HOUSE.join(',')})`, fill: 'backwards' }
        );
    return () => anim.cancel();
  }, [bookEl, reduced]);

  useEffect(() => {
    const t = setTimeout(() => setHint(true), reduced ? 300 : 1400);
    return () => clearTimeout(t);
  }, [reduced]);

  // One "the cover wants to open" nudge once the title has landed.
  useEffect(() => {
    if (reduced || !hint || !bookEl || typeof bookEl.animate !== 'function') return;
    const a = bookEl.animate(
      [
        { transform: 'perspective(1400px) rotateY(0deg)' },
        { transform: `perspective(1400px) rotateY(${rtl ? 5 : -5}deg)` },
        { transform: 'perspective(1400px) rotateY(0deg)' }
      ],
      { duration: 900, easing: 'cubic-bezier(0.38,0.02,0.18,1)' }
    );
    return () => a.cancel();
  }, [hint, reduced, bookEl, rtl]);

  const letters = Array.from(title || '');
  return (
    <>
      {/* The room fades up from black. */}
      {!reduced && (
        <motion.div aria-hidden className="pointer-events-none absolute inset-0 z-[30] bg-black" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 0.3, ease: 'linear' }} />
      )}
      <button
        type="button"
        data-testid="cover-intro"
        aria-label={`Open ${title || 'the comic'}`}
        className="absolute inset-0 z-[31] cursor-pointer bg-transparent outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-[var(--ds-accent)]"
        onClick={onOpen}
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[32] flex flex-col items-center gap-2 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-6 pb-[max(20px,var(--sa-bottom))] pt-16 text-center text-white">
        <h1 className="max-w-[min(760px,100%)] [overflow-wrap:anywhere]" style={{ fontFamily: 'Bangers, ui-sans-serif, system-ui', fontSize: 'clamp(30px, 6vmin, 64px)', letterSpacing: '0.03em', lineHeight: 1.05 }}>
          {reduced ? (
            title
          ) : (
            <span aria-label={title}>
              {letters.map((ch, i) => (
                <motion.span
                  key={i}
                  aria-hidden
                  className="inline-block whitespace-pre"
                  initial={{ opacity: 0, y: '0.35em' }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.6 + i * 0.024, duration: 0.32, ease: HOUSE }}
                >
                  {ch}
                </motion.span>
              ))}
            </span>
          )}
        </h1>
        {(logline || author) && (
          <motion.div
            className="max-w-[min(620px,100%)] space-y-1"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: reduced ? 0 : 0.6 + letters.length * 0.024 + 0.1, duration: reduced ? 0.2 : 0.24 }}
          >
            {logline && <p className="text-[14px] leading-snug text-white/85 [overflow-wrap:anywhere]">{logline}</p>}
            {author && <p className="text-[12px] text-white/70">by {author}</p>}
          </motion.div>
        )}
        <motion.p
          className="mt-1 rounded-full bg-white/15 px-4 py-2 text-[13px] font-medium backdrop-blur-md"
          initial={{ opacity: 0, y: 6 }}
          animate={hint ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
          transition={{ duration: reduced ? 0.15 : 0.3 }}
          aria-live="polite"
        >
          {hint ? 'Swipe or tap to open' : ''}
        </motion.p>
      </div>
    </>
  );
};

export default CoverIntro;
