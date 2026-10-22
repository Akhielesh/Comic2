// "This is what people see before they tap": a neutral chat-bubble mock of the link preview
// (the real OG image, title, description, domain). Styled like a generic messenger — never an
// imitation of any brand. Light/dark bubble toggle. Also used as a Gallery demo.

import React, { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { cx } from '../conversation/ui';

export interface LinkPreviewMockProps {
  title: string;
  description?: string;
  imageUrl?: string;
  url: string;
  className?: string;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const LinkPreviewMock: React.FC<LinkPreviewMockProps> = ({ title, description, imageUrl, url, className }) => {
  const [dark, setDark] = useState(false);
  const [broken, setBroken] = useState(false);
  return (
    <figure className={cx('m-0 min-w-0', className)}>
      <div className={cx('rounded-2xl p-3 transition-colors', dark ? 'bg-[#1f2328]' : 'bg-[#e9eef3]')}>
        {/* Neutral bubble colours (not any messenger's brand palette); the mock simulates a chat app
            in light or dark, independent of the studio theme, so it uses fixed neutral greys. */}
        <div className={cx('ml-auto max-w-[340px] overflow-hidden rounded-2xl rounded-br-md shadow-sm', dark ? 'bg-[#2d333b] text-white' : 'bg-white text-[#1f2328]')}>
          <div className={cx('m-1 overflow-hidden rounded-xl', dark ? 'bg-black/25' : 'bg-black/5')}>
            <div className="relative aspect-[1200/630] w-full">
              {imageUrl && !broken ? (
                <img src={imageUrl} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="absolute inset-0 h-full w-full object-cover" />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center opacity-60">
                  <ImageOff className="h-6 w-6" aria-hidden />
                </div>
              )}
            </div>
            <div className="min-w-0 px-2.5 py-2">
              <div className="truncate text-[13px] font-semibold">{title}</div>
              {description && <div className="mt-0.5 line-clamp-2 text-[12px] opacity-80">{description}</div>}
              <div className="mt-1 truncate text-[11px] opacity-60">{hostOf(url)}</div>
            </div>
          </div>
          <div className="truncate px-3 pb-2 text-[12px] underline opacity-90">{url}</div>
        </div>
      </div>
      <figcaption className="mt-2 flex items-center justify-between gap-2 text-[12px] text-[var(--ds-muted)]">
        <span className="min-w-0">This is what people see before they tap.</span>
        <button
          type="button"
          onClick={() => setDark((d) => !d)}
          aria-pressed={dark}
          className="min-h-[44px] shrink-0 rounded-lg px-2 font-medium hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
        >
          {dark ? 'Light chat' : 'Dark chat'}
        </button>
      </figcaption>
    </figure>
  );
};

export default LinkPreviewMock;
