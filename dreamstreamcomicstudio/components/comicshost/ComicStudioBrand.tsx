import React from 'react';
import { cn } from '../../lib/utils';
import { BrandLockup } from '../layout/BrandLockup';

/** The suite's canonical mark and the product name share one home action. */
export function ComicStudioBrand({ onHome, className }: { onHome(): void; className?: string }) {
  return <BrandLockup
    className={cn('comic-suite-lockup', className)}
    suffix="Comic Studio"
    suffixAlways
    label="DreamStream Comic Studio, home"
    onClick={onHome}
  />;
}
