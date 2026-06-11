import { describe, it, expect } from 'vitest';
import { isTripIntent, tripGuidanceBlock } from './chat.js';

describe('trip guidance', () => {
  it('fires on trip-planning asks', () => {
    expect(isTripIntent('plan a 2 day trip to nyc from fairfax')).toBe(true);
    expect(isTripIntent('weekend in Rome with kids')).toBe(true);
    expect(isTripIntent('flights to Tokyo in July')).toBe(true);
    const block = tripGuidanceBlock('plan a trip to NYC');
    expect(block).toContain('TRIP PLANNING MODE');
    expect(block).toContain('ask_user');
    expect(block).toContain('ONE plan_trip itinerary');
  });

  it('stays quiet on non-travel chat', () => {
    expect(isTripIntent('explain recursion for my exam')).toBe(false);
    expect(isTripIntent('what is the capital of France')).toBe(false);
    expect(tripGuidanceBlock('fix my code')).toBe('');
  });
});
