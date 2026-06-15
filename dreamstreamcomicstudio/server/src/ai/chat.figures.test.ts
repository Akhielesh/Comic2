import { describe, it, expect } from 'vitest';
import { detectUnsourcedFigures } from './chat.js';
import type { ChatToolEvent } from './chat.js';

const okTool: ChatToolEvent[] = [{ tool: 'get_stock', ok: true }];
const failTool: ChatToolEvent[] = [{ tool: 'web_search', ok: false }];
const cite = [{ url: 'https://reuters.com/x' }];

describe('detectUnsourcedFigures — fires on an unsourced money claim', () => {
  it('flags a currency figure with no successful tool and no citation', () => {
    expect(detectUnsourcedFigures('NVDA trades at $214.50 today.', [], [])).toBe(true);
    expect(detectUnsourcedFigures('The minimum wage is $7.25 an hour.', failTool, [])).toBe(true);
    expect(detectUnsourcedFigures('It costs about 50 USD.', [], [])).toBe(true);
    expect(detectUnsourcedFigures('€3,000 for the flight.', [], [])).toBe(true);
  });
});

describe('detectUnsourcedFigures — never fires when grounded', () => {
  it('a successful tool makes it grounded', () => {
    expect(detectUnsourcedFigures('NVDA is $214.50.', okTool, [])).toBe(false);
  });
  it('a citation makes it grounded', () => {
    expect(detectUnsourcedFigures('NVDA is $214.50.', [], cite)).toBe(false);
  });
});

describe('detectUnsourcedFigures — never fires on legitimate general knowledge', () => {
  const cases = [
    'Water boils at 100°C at sea level.',
    '2 + 2 = 4.',
    'The speed of light is 299,792,458 m/s.',
    'World War II ended in 1945.',
    'The interest rate rose to 5%.',
    'Unemployment fell to 3.4% last month.',
    'A right angle is 90 degrees.',
    'The population is about 8 billion.',
    'The marathon is 26.2 miles.',
    ''
  ];
  for (const text of cases) {
    it(`does not flag: ${JSON.stringify(text)}`, () => {
      expect(detectUnsourcedFigures(text, [], [])).toBe(false);
    });
  }
});
