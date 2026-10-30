// Cover intro (reader.md §6.1; decisions-final #11: immersive only, once per session per comic).
// The room fades up from black, the closed book rises onto the desk, the title writes itself in, and
// a hint invites the first turn. Any input skips straight to reading — a tap or swipe opens the cover
// with the hardcover turn. Reduced motion: a still composition with a short fade.

import React, { useEffect, useRef, useState } from 'react';
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

/** Scripts whose letters must stay together to shape (Telugu, Devanagari, Arabic, CJK, emoji…). */
// eslint-disable-next-line no-control-regex
const COMPLEX_SCRIPT = /[^\u0000-\u024F\u1E00-\u1EFF\u2000-\u206F\u20A0-\u20CF]/;

/**
 * The title as reveal units: words (kept whole — a line never breaks inside one unless it is wider than
 * the screen) made of letters. Complex scripts reveal word by word: splitting a Telugu or Hindi word
 * into code points would break its shaping (vowel signs on dotted circles, broken conjuncts).
 */
export const titleUnits = (title: string): { word: string; letters: string[] | null }[] => {
  const t = (title || '').normalize('NFC');
  const complex = COMPLEX_SCRIPT.test(t);
  return t
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ({ word, letters: complex ? null : Array.from(word) }));
};

export const CoverIntro: React.FC<CoverIntroProps> = ({ title, logline, author, reduced, rtl, bookEl, onOpen }) => {
  const [hint, setHint] = useState(false);
  // Opens once: a swipe (pointer up after travel) and the click that may follow must not turn twice.
  const opened = useRef(false);
  const down = useRef<{ x: number; y: number } | null>(null);
  const open = () => {
    if (opened.current) return;
    opened.current = true;
    onOpen();
  };

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

  const units = titleUnits(title);
  // Stagger: 24 ms per letter (Latin), 90 ms per word for scripts revealed word by word.
  let order = 0;
  const timed = units.map((u) => {
    const start = order;
    order += u.letters ? u.letters.length : 4;
    return { ...u, start };
  });
  const revealMs = order * 24;
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
        className="absolute inset-0 z-[31] cursor-pointer touch-none bg-transparent outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-[var(--ds-accent)]"
        onPointerDown={(e) => {
          down.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          // "Swipe or tap to open": a swipe never produces a click, so it opens here.
          const d = down.current;
          down.current = null;
          if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 24) open();
        }}
        onClick={open}
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[32] flex flex-col items-center gap-2 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-6 pb-[max(20px,var(--sa-bottom))] pt-16 text-center text-white">
        <h1 className="max-w-[min(760px,100%)] [overflow-wrap:anywhere]" style={{ fontFamily: 'Bangers, ui-sans-serif, system-ui', fontSize: 'clamp(30px, 6vmin, 64px)', letterSpacing: '0.03em', lineHeight: 1.05 }}>
          {reduced ? (
            title
          ) : (
            <>
              <span className="sr-only">{title}</span>
              <span aria-hidden>
                {timed.map((u, wi) => (
                  <React.Fragment key={wi}>
                    {wi > 0 && ' '}
                    {u.letters ? (
                      <span className="inline-flex max-w-full flex-wrap justify-center">
                        {u.letters.map((ch, i) => (
                          <motion.span
                            key={i}
                            className="inline-block whitespace-pre"
                            initial={{ opacity: 0, y: '0.35em' }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.6 + (u.start + i) * 0.024, duration: 0.32, ease: HOUSE }}
                          >
                            {ch}
                          </motion.span>
                        ))}
                      </span>
                    ) : (
                      <motion.span
                        className="inline-block max-w-full [overflow-wrap:anywhere]"
                        initial={{ opacity: 0, y: '0.35em' }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.6 + u.start * 0.024, duration: 0.4, ease: HOUSE }}
                      >
                        {u.word}
                      </motion.span>
                    )}
                  </React.Fragment>
                ))}
              </span>
            </>
          )}
        </h1>
        {(logline || author) && (
          <motion.div
            className="max-w-[min(620px,100%)] space-y-1"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: reduced ? 0 : 0.6 + revealMs / 1000 + 0.1, duration: reduced ? 0.2 : 0.24 }}
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
