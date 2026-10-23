import { describe, expect, it } from 'vitest';

describe('#/monitor/<nursery>/invite', async () => {
  const { parseRoute } = await import('../LiveApp');
  const NID = '11111111-2222-4333-8444-555555555555';

  it('opens the nursery hub (the Invite sheet goes on top of it)', () => {
    history.replaceState(null, '', `/live.html#/monitor/${NID}/invite`);
    expect(parseRoute()).toEqual({ view: 'nursery', nid: NID });
    history.replaceState(null, '', `/live.html#/monitor/${NID}/watch`);
    expect(parseRoute()).toEqual({ view: 'monitor-watch', nid: NID });
    history.replaceState(null, '', `/live.html#/monitor/${NID}/nope`);
    expect(parseRoute()).toEqual({ view: 'dashboard' });
  });
});
