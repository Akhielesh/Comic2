import React from 'react';
import { cn } from '../../lib/utils';
import { DENSITY, FOCUS_RING, INK, MUTED, RADIUS_CONTROL } from '../chat/studioDesign';

interface BrandLockupProps {
  onClick?: () => void;
  clickable?: boolean;
  className?: string;
  /** The mark before the name (default: the DreamStream app icon, BRAND_MARK_SRC). */
  mark?: React.ReactNode;
  /** The name, semibold ink (default "DreamStream"). */
  name?: string;
  /** The muted word after it (default "Studio"). */
  suffix?: string;
  /** The home button's accessible name (default "DreamStream Studio, home"). */
  label?: string;
  /** Show the suffix at every width (a product lockup such as "Comic Studio", one line). Default: DS-2's rule. */
  suffixAlways?: boolean;
}

/** The DreamStream mark: the checked-in app icon (public/stream-studio.svg, the source of every app icon). */
export const BRAND_MARK_SRC = '/stream-studio.svg';

/**
 * The brand lockup in the Atlas header (Atlas AtlasLogo): the mark — the one place the brand colour stays,
 * drawn from its checked-in SVG, never re-spelled — then the name in the body face, semibold, and "Studio"
 * in the muted ink. As a button it is the home link: 44 px tall under a coarse pointer, the ink focus ring.
 */
export const BrandLockup: React.FC<BrandLockupProps> = ({
  onClick,
  clickable = true,
  className = '',
  mark,
  name = 'DreamStream',
  suffix = 'Studio',
  label = 'DreamStream Studio, home',
  suffixAlways = false
}) => {
  const content = (
    <>
      {mark ?? <img src={BRAND_MARK_SRC} alt="" width={28} height={28} draggable={false} className="size-7 shrink-0 select-none" />}
      <span className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap leading-none">
        <span className={cn('text-[length:var(--ds-text-md)] font-semibold tracking-[-0.01em]', INK)}>{name}</span>
        {/* A real space between the two words: the flex gap draws it, but the text a screen reader and axe compare
            with the button's aria-label ("Comic Studio, home") must read "Comic Studio", not "ComicStudio". */}
        {' '}
        {/* DS-2's rule read `min-[380px]:inline`, which this config's raw screens compile to nothing (the suffix never
            showed); `medium` (600 px) is the first named screen with room for it beside the main site's header. */}
        <span className={cn(suffixAlways ? 'inline text-[length:var(--ds-text-md)] font-medium' : 'hidden text-[length:var(--ds-text-md)] font-medium medium:inline', MUTED)}>{suffix}</span>
      </span>
    </>
  );

  if (clickable) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        data-slot="brand-lockup"
        className={`${cn(
          '-ml-1 flex min-w-0 items-center gap-2 px-1 py-1 transition-opacity duration-[var(--ds-motion-fast)] hover:opacity-80',
          RADIUS_CONTROL,
          DENSITY.coarse,
          className
        )} ${FOCUS_RING}`}
      >
        {content}
      </button>
    );
  }

  return (
    <div data-slot="brand-lockup" className={cn('flex min-w-0 items-center gap-2', className)}>
      {content}
    </div>
  );
};
