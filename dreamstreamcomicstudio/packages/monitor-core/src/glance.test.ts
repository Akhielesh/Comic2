// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CAN,
  CAN_ALL,
  clipText,
  coarseGlance,
  composeGlance,
  dbBand,
  GLANCE_MAX_BYTES,
  glanceBytes,
  glanceCan,
  glanceEtag,
  glanceFacts,
  glanceNotModified,
  parseGlance,
  pickAlert,
  withSource,
  type GlanceFacts,
  type GlanceRoomInput,
  type GlanceRoomState,
  type GlanceV1,
  type GlanceViewer,
} from './glance';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/glance/${name}`, import.meta.url), 'utf8')) as T;

interface ComposeCase {
  name: string;
  state: GlanceRoomState;
  viewer: GlanceViewer;
  glance: GlanceV1;
  json: string;
  bytes: number;
  etag: string;
}

describe('golden fixtures: compose', () => {
  const { cases } = fixture<{ cases: ComposeCase[] }>('compose.json');

  it('has the cases the contract promises', () => {
    expect(cases.map((c) => c.name)).toEqual(
      expect.arrayContaining(['calm-asleep-parent', 'crying-open-on-duty', 'crying-open-push', 'acked-viewer', 'guest-caregiver', 'watch-grant-narrows-parent', 'long-names-clipped-worst-case']),
    );
  });

  for (const c of cases) {
    it(`${c.name}: composes to the exact JSON, under 512 B, and decodes back`, () => {
      const g = composeGlance(c.state, c.viewer);
      expect(g).toEqual(c.glance);
      expect(JSON.stringify(g)).toBe(c.json);
      expect(glanceBytes(g)).toBe(c.bytes);
      expect(new TextEncoder().encode(c.json).length).toBe(c.bytes);
      expect(c.bytes).toBeLessThanOrEqual(GLANCE_MAX_BYTES);
      expect(glanceEtag(g)).toBe(c.etag);
      expect(parseGlance(JSON.parse(c.json))).toEqual(g);
    });
  }

  it('push payloads never carry the nursery name; everything else is the same', () => {
    const app = cases.find((c) => c.name === 'crying-open-on-duty')!.glance;
    const push = cases.find((c) => c.name === 'crying-open-push')!.glance;
    expect(push.nm).toBeUndefined();
    expect({ ...push, nm: app.nm }).toEqual(app);
  });
});

describe('golden fixtures: facts and decode', () => {
  it('glanceFacts matches every case', () => {
    const { cases } = fixture<{ cases: { name: string; now: number; room: GlanceRoomInput; facts: GlanceFacts }[] }>('facts.json');
    for (const c of cases) expect(glanceFacts(c.room, c.now), c.name).toEqual(c.facts);
  });

  it('decoders accept every valid glance and reject every invalid one', () => {
    const { valid, invalid } = fixture<{ valid: { name: string; json: string }[]; invalid: { name: string; json: string }[] }>('decode.json');
    for (const v of valid) expect(parseGlance(JSON.parse(v.json)), v.name).not.toBeNull();
    for (const v of invalid) expect(parseGlance(JSON.parse(v.json)), v.name).toBeNull();
  });

  it('absent and null optionals decode alike; unknown fields are dropped', () => {
    const { valid } = fixture<{ valid: { name: string; json: string }[] }>('decode.json');
    const nulls = parseGlance(JSON.parse(valid.find((v) => v.name === 'nulls-mean-none')!.json))!;
    expect(nulls.sl).toBeUndefined();
    expect(nulls.al).toBeUndefined();
    expect(nulls.cam).toEqual({ on: 1, ls: 2 });
    const extra = parseGlance(JSON.parse(valid.find((v) => v.name === 'unknown-fields-ignored')!.json))!;
    expect(extra).not.toHaveProperty('x');
    expect(extra.cam).not.toHaveProperty('future');
    expect(extra.src).toBe('lan');
  });
});

describe('can: what each device may do', () => {
  it('follows the roles MonitorRoom enforces', () => {
    expect(glanceCan({ role: 'parent' })).toBe(CAN_ALL);
    expect(glanceCan({ role: 'caregiver' })).toBe(CAN_ALL);
    expect(glanceCan({ role: 'viewer' })).toBe(CAN.listen | CAN.peek);
    expect(glanceCan({ role: 'owner' as never })).toBe(CAN.listen | CAN.peek); // unknown → least
  });

  it('guests: least privilege, never duty or logging', () => {
    expect(glanceCan({ role: 'viewer', guest: true })).toBe(CAN.listen | CAN.peek);
    expect(glanceCan({ role: 'caregiver', guest: true })).toBe(CAN.ack | CAN.soothe | CAN.listen | CAN.talk | CAN.peek);
    expect(glanceCan({ role: 'parent', guest: true }) & (CAN.duty | CAN.log)).toBe(0);
  });

  it('a device grant only narrows, never widens', () => {
    expect(glanceCan({ role: 'parent', deviceCan: CAN.ack | CAN.listen })).toBe(CAN.ack | CAN.listen);
    expect(glanceCan({ role: 'viewer', deviceCan: CAN_ALL })).toBe(CAN.listen | CAN.peek);
    expect(glanceCan({ role: 'parent', deviceCan: 0xffff })).toBe(CAN_ALL);
    expect(glanceCan({ role: 'parent', deviceCan: 0 })).toBe(0);
  });
});

const T = Date.UTC(2026, 9, 22, 2, 47);
const facts = (over: Partial<GlanceFacts> = {}): GlanceFacts => ({
  nm: 'Nursery',
  m: 'calm',
  ms: T - 60_000,
  sl: null,
  db: 40,
  cam: { on: 1, bat: 80, chg: true, pz: null, ls: T },
  al: null,
  du: { uid: 'u-dad', nm: 'Dad', u: T + 3_600_000 },
  so: null,
  tk: null,
  ...over,
});
const room = (f: GlanceFacts, q = 5): GlanceRoomState => ({ nid: 'n1', q, at: T, facts: f });

describe('composeGlance', () => {
  it('works out who is on duty per device', () => {
    expect(composeGlance(room(facts()), { uid: 'u-dad', role: 'caregiver' }).du).toEqual({ nm: 'Dad', me: true, u: T + 3_600_000 });
    expect(composeGlance(room(facts()), { uid: 'u-mom', role: 'parent' }).du?.me).toBe(false);
    expect(composeGlance(room(facts()), { role: 'viewer', guest: true }).du?.me).toBe(false);
  });

  it('leaves out what is unknown rather than sending nulls', () => {
    const g = composeGlance(room(facts({ db: null, cam: { on: 0, bat: null, chg: null, pz: null, ls: 0 }, du: null })), { role: 'parent' });
    expect(g).not.toHaveProperty('db');
    expect(g).not.toHaveProperty('dbb');
    expect(g).not.toHaveProperty('du');
    expect(g.cam).toEqual({ on: 0, ls: 0 });
  });

  it('uses the published dB band (hysteresis) over the raw one', () => {
    expect(composeGlance({ ...room(facts({ db: 56 })), dbb: 1 }, { role: 'parent' }).dbb).toBe(1);
    expect(composeGlance(room(facts({ db: 56 })), { role: 'parent' }).dbb).toBe(2);
    expect([dbBand(39.9), dbBand(40), dbBand(54), dbBand(55), dbBand(69), dbBand(70), dbBand(null)]).toEqual([0, 1, 1, 2, 2, 3, null]);
  });

  it('never exceeds 512 bytes, whatever people type (seeded fuzz)', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const glyphs = ['a', 'Ж', '日', '👶', '🏳️‍🌈', ' ', '"', '\\', '\n', '\u0007', '…'];
    const text = (n: number) => Array.from({ length: n }, () => glyphs[Math.floor(rnd() * glyphs.length)]).join('');
    for (let i = 0; i < 300; i++) {
      const long = () => text(Math.floor(rnd() * 80));
      const f = facts({
        nm: long(),
        m: 'crying',
        sl: { p: 'settling', s: T, min: 9999, w: 99 },
        db: 120,
        cam: { on: 9, bat: 100, chg: false, pz: 'interrupted', ls: T },
        al: { id: 'abcdefghijkl', k: long(), sev: 'urgent', at: T, st: 'acked', by: long() },
        du: { uid: 'u', nm: long(), u: T },
        so: long(),
        tk: long(),
      });
      const g = composeGlance({ nid: '7d0c2a8e-5b1f-4c3a-9e6d-1a2b3c4d5e6f', q: Number.MAX_SAFE_INTEGER, at: T, facts: f }, { uid: 'u', role: 'parent' });
      expect(glanceBytes(g)).toBeLessThanOrEqual(GLANCE_MAX_BYTES);
      expect(parseGlance(JSON.parse(JSON.stringify(g)))).toEqual(g);
      expect(g.al?.id).toBe('abcdefghijkl'); // ids are never shortened
    }
  });

  it('tidies text: control characters out, single spaces, an ellipsis when cut', () => {
    expect(clipText('  Mom\n\t is\u0000 here ', 24)).toBe('Mom is here');
    expect(clipText('Grandma Josephine', 8)).toBe('Grandma…');
    expect(clipText('👶👶👶👶', 3)).toBe('👶👶…');
  });

  it('the Live Activity fallback keeps no names and no ids', () => {
    const g = composeGlance(room(facts({ m: 'crying', al: { id: 'i9', k: 'cry', sev: 'urgent', at: T, st: 'open', by: null }, sl: { p: 'awake', s: T, min: 3, w: 1 } })), { role: 'parent' });
    const c = coarseGlance(g);
    expect(c).toEqual({ m: 'crying', ms: T - 60_000, sl: { p: 'awake' }, al: { st: 'open' } });
    expect(JSON.stringify(c)).not.toMatch(/i9|Nursery|Dad/);
  });

  it('marks the source on the client only', () => {
    const g = composeGlance(room(facts()), { role: 'parent' });
    expect(g.src).toBeUndefined();
    expect(withSource(g, 'lan').src).toBe('lan');
  });
});

describe('glanceFacts edge cases', () => {
  it('a camera state this contract does not know reads as waiting, never as a broken glance', () => {
    const f = glanceFacts({ name: 'N', cams: [{ online: true, at: T, since: T, st: { state: 'teething' as never } }] }, T);
    expect(f.m).toBe('unknown');
    expect(parseGlance(composeGlance(room(f), { role: 'parent' }))).not.toBeNull();
  });

  it('a mood can’t start in the future, and battery stays within 0–100', () => {
    const f = glanceFacts({ name: 'N', cams: [{ online: true, at: T, since: T + 60_000, st: { state: 'calm', battery: 140 } }] }, T);
    expect(f.ms).toBe(T);
    expect(f.cam.bat).toBe(100);
  });
});

describe('ETag and 304', () => {
  const g = composeGlance(room(facts(), 812), { uid: 'u-dad', role: 'caregiver' });

  it('names q, the device caps and whether this device is on duty', () => {
    expect(glanceEtag(g)).toBe('"812.127.d"');
    expect(glanceEtag(composeGlance(room(facts(), 812), { uid: 'u-mom', role: 'viewer' }))).toBe('"812.20"');
  });

  it('answers If-None-Match the way HTTP does', () => {
    expect(glanceNotModified('"812.127.d"', g)).toBe(true);
    expect(glanceNotModified('W/"812.127.d"', g)).toBe(true);
    expect(glanceNotModified('"811.127.d", "812.127.d"', g)).toBe(true);
    expect(glanceNotModified('*', g)).toBe(true);
    expect(glanceNotModified('"811.127.d"', g)).toBe(false);
    expect(glanceNotModified('"812.127"', g)).toBe(false); // went on duty: a new glance for this device
    expect(glanceNotModified(null, g)).toBe(false);
  });
});

describe('pickAlert', () => {
  it('shows the one that still needs a person first', () => {
    const a = pickAlert(
      [
        { id: 'acked-urgent', at: T - 5, kind: 'cry', sev: 'urgent', status: 'acked', ack_by: 'Dad' },
        { id: 'open-warn', at: T - 9, kind: 'moved', sev: 'warn', status: 'open' },
        { id: 'open-urgent-old', at: T - 20, kind: 'zone', sev: 'urgent', status: 'open' },
        { id: 'open-urgent-new', at: T - 1, kind: 'zone', sev: 'urgent', status: 'open' },
      ],
      T,
    );
    expect(a?.id).toBe('open-urgent-new');
    expect(a?.by).toBeNull();
    expect(pickAlert([{ id: 'x', at: T, kind: 'cry', sev: 'urgent', status: 'acked', ack_by: 'Mom' }], T)).toMatchObject({ st: 'acked', by: 'Mom' });
    expect(pickAlert([], T)).toBeNull();
  });
});
