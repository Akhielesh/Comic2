// Guard (Q-SETTLE): every card this client can show offers its choices only while it is the newest ask, so every card
// type the conversation renders (the built-in ones and every feature card) must have a settle rule in
// shared/comic/settle.ts CARD_SETTLE_RULES. A new chip-bearing card type registered without one fails here, and a
// card type added to the Card union without one fails shared/comic/settle.turns.test.ts (and does not compile).

import { describe, expect, it } from 'vitest';
import { CARD_SETTLE_RULES } from '../../../shared/comic/settle';
import { registeredCardTypes } from '../features';
import { CARD_TYPES } from './cards/CardRenderer';

describe('every card the conversation renders has a settle rule', () => {
  it('built-in cards', () => {
    const missing = CARD_TYPES.filter((t) => !Object.prototype.hasOwnProperty.call(CARD_SETTLE_RULES, t));
    expect(missing).toEqual([]);
  });

  it('feature cards (the registry)', () => {
    const types = registeredCardTypes();
    expect(types.length).toBeGreaterThan(5);
    const missing = types.filter((t) => !Object.prototype.hasOwnProperty.call(CARD_SETTLE_RULES, t));
    expect(missing).toEqual([]);
  });
});
