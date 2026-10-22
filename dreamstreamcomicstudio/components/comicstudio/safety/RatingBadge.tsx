// Content rating badge (contract §13.3; owner P1-SAFETY). Wave 0 (P0-C) stub: renders nothing.

import type React from 'react';
import type { ContentRating } from '../../../shared/comic/safety';

export interface RatingBadgeProps {
  rating: ContentRating;
  reason?: string;
}

export const RatingBadge: React.FC<RatingBadgeProps> = () => null;

export default RatingBadge;
