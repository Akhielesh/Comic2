// matchChoices moved to shared/comic/settle.ts (PROGRAM3 SETTLE-0; settle.md §5.7) so the client's pending "picked"
// and the server's recorded answer agree. Until the S2b integration switches director.ts to settle.matchChoices
// (wave note), its own pickedChoices must give the same ids: this pins both, through recordOptionAnswer's text match.

import { describe, expect, it } from 'vitest';
import type { Card } from '../../../shared/comic/doc.js';
import { matchChoices } from '../../../shared/comic/settle.js';
import { recordOptionAnswer } from './director.js';
import { newSession, plannedDoc } from './orchestrator.fakes.js';

type OptionsCard = Extract<Card, { type: 'options' }>;

const card = (multi: boolean): OptionsCard => ({
  type: 'options',
  id: 'q',
  question: 'Which look?',
  allowCustom: true,
  ...(multi ? { multi: true } : {}),
  choices: [
    { id: 'c1', label: 'Noir ink' },
    { id: 'c2', label: 'Crayon', reply: 'Crayon, the kid-drawn one' },
    { id: 'c3', label: 'Bright cartoon' }
  ]
});

const TEXTS = [
  'Noir ink', '  noir   INK ', 'Noir ink, please', 'Noir ink!', 'Crayon', 'Crayon, the kid-drawn one', 'crayon, the KID-drawn one',
  'Noir ink and Crayon', 'Noir ink, Crayon and Bright cartoon', 'Noir ink, Pastel', 'Noir', 'make it longer', ''
];

/** What the director records today for this text (its private pickedChoices, through the text match). */
const recorded = (c: OptionsCard, text: string): string[] => {
  const doc = plannedDoc();
  doc.conversation = [{ id: 'a1', role: 'assistant', text: 'Pick one', at: 1, cards: [c] }];
  const session = newSession(doc);
  recordOptionAnswer(session, text);
  const after = session.doc.conversation[0].cards![0] as OptionsCard;
  return after.answered ?? [];
};

describe('settle.matchChoices equals the director’s pickedChoices (courtesy match off)', () => {
  for (const multi of [false, true]) {
    it.each(TEXTS)(`${multi ? 'multi' : 'single'}: %j`, (text) => {
      expect(matchChoices(card(multi), text)).toEqual(recorded(card(multi), text));
    });
  }
});
