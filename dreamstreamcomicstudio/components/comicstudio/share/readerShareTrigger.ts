// The face of the reader's Share button, in one place: ReaderShare's trigger, and the stand-in ShareButton shows while
// ReaderShare's chunk loads (so the button does not move or change when the menu's code arrives). A 44 px ghost button:
// an icon-only 44 × 44 slot when compact, else 44 px tall with its label.

import { cn } from '../../../lib/utils';
import { buttonClasses } from '../../ds/Button';

export const readerShareTriggerClass = (compact?: boolean, className?: string): string =>
  buttonClasses({ variant: 'ghost', size: compact ? 'icon' : 'default', className: cn('text-[var(--ds-ink)] touch-manipulation', compact ? 'size-11' : 'h-11 px-3', className) });
