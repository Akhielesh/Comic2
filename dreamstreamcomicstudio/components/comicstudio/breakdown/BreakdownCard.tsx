// Page breakdown card: cover + every page wireframe, panel counts and cost (contract §13.3;
// owner P1-BOOKMODEL; decisions-final #3). Wave 0 (P0-C) stub: renders nothing, and it is not
// registered as a card yet (breakdown/index.ts registers it in wave 1).

import type React from 'react';
import type { Card } from '../../../shared/comic/doc';
import type { CardProps } from '../extensions';

export type BreakdownCardData = Extract<Card, { type: 'breakdown' }>;

export type BreakdownCardProps = CardProps<BreakdownCardData> & { compact?: boolean };

export const BreakdownCard: React.FC<BreakdownCardProps> = () => null;

export default BreakdownCard;
