// The one lettering renderer for the board (contract §13.3; owner P1-LETTER-UI): draws
// LetterPlans from the shared engine. Wave 0 (P0-C) stub: renders nothing (BalloonLayer keeps
// drawing today's balloons until wave 2).

import type React from 'react';
import type { LetterPlan } from '../../../shared/comic/lettering/index';

export interface LetteringSvgProps {
  plans: LetterPlan[];
  /** Page aspect (w/h); the SVG viewBox is 1000 × 1000/aspect. */
  aspect: number;
  ariaHidden?: boolean;
  visibleLineIds?: ReadonlySet<string>;
  selectedLineIds?: ReadonlySet<string>;
}

export const LetteringSvg: React.FC<LetteringSvgProps> = () => null;

export default LetteringSvg;
