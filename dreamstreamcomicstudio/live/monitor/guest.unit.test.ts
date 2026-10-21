// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { passcodeProblem as serverRule } from '../../live-worker/src/monitorGuests';
import { passcodeProblem, shareLink, suggestPasscode } from './guest';

describe('guest passcodes', () => {
  it('the app hints exactly what the nursery’s room will enforce', () => {
    const samples = ['short', '1234567', '12345678', 'aaaaaaaa', 'password1', 'qwertyuiop', 'abcdefghij', 'lowercaseonly', 'shortone', 'Aria2024!', 'aria-loves-you', 'blue-otter-42', 'Nursery#1', 'x'.repeat(130), 'Sunny day 7'];
    for (const p of samples) expect(passcodeProblem(p, ['Aria', 'Nursery'])).toBe(serverRule(p, ['Aria', 'Nursery']));
  });

  it('suggests passphrases the room accepts', () => {
    for (let i = 0; i < 50; i++) {
      const p = suggestPasscode();
      expect(p).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d\d$/);
      expect(serverRule(p, ['Aria'])).toBeNull();
    }
  });

  it('builds the join link with the code in the fragment (never sent to a server)', () => {
    expect(shareLink('11111111-2222-4333-8444-555555555555', 'abc_DEF-123')).toMatch(/\/live#\/monitor\/join\/11111111-2222-4333-8444-555555555555\/abc_DEF-123$/);
  });
});
