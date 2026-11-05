// The composer's connector chips are built from the catalogue minus the tools behind a rollout, so the shared
// platform's email_draft and deck_create never join a chip (the server offers them per request, to admitted people).
import { describe, expect, it } from 'vitest';
import { CHAT_CONNECTORS } from './chatConnectors';
import { TOOL_CATALOG } from '../toolCatalog';

const ROLLOUT = TOOL_CATALOG.filter((t) => t.rollout).map((t) => t.name);

describe('CHAT_CONNECTORS', () => {
  it('the rollout tools exist in the catalogue', () => {
    expect(ROLLOUT).toEqual(expect.arrayContaining(['email_draft', 'deck_create']));
  });

  it('no connector lists email_draft, deck_create or any other rollout tool', () => {
    for (const c of CHAT_CONNECTORS) {
      expect(c.toolNames).not.toContain('email_draft');
      expect(c.toolNames).not.toContain('deck_create');
      for (const name of ROLLOUT) expect(c.toolNames).not.toContain(name);
    }
  });

  it("each chip's tools and '+N more' count are its category's tools without a rollout", () => {
    for (const c of CHAT_CONNECTORS) {
      const tools = TOOL_CATALOG.filter((t) => t.category === c.category && !t.rollout);
      expect(c.toolNames).toEqual(tools.map((t) => t.name));
      if (tools.length > 4) expect(c.description).toContain(`, +${tools.length - 4} more.`);
    }
  });
});
