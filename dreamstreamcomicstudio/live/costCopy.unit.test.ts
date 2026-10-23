// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS as PRESETS } from './config';
import * as copy from './costCopy';
import {
  BROADCAST_TIP,
  approxUsd,
  CAMERA_FAMILY_LINE,
  CLOUD_COPY_DRIVE_TIP,
  CLOUD_COPY_HEAD,
  COST,
  FREE_CHIP,
  GO_LIVE_LINE,
  GO_LIVE_LINE_TIP,
  MEETING_LINE,
  MEETING_LINE_TIP,
  PATH_PILL,
  PATH_TIP,
  RELAY_OUT_MONITOR,
  TIPS,
  USAGE,
  allowanceLevel,
  callPathSuffix,
  callReceipt,
  callReceiptText,
  cloudCopyNotice,
  cloudCopySettingDesc,
  deliveryLine,
  fmtDuration,
  fmtGb,
  fmtUsdEst,
  mainPath,
  meetingDeliveryLine,
  monthName,
  nightReceiptText,
  pctOf,
  relayNotice,
  relayTip,
  resetDay,
  studioViewersLine,
} from './costCopy';

/**
 * The cost and path copy (feature doc §4.8): Stream Studio must say who pays, honestly —
 *   1. never "free" for the relay or our server;
 *   2. never "end-to-end" for the server relay (only "not end-to-end encrypted");
 *   3. dollars only inside "What this costs DreamStream (est.)", never as a charge;
 *   4. a path line before every action that uses our servers;
 *   5. never that a limit cuts the baby monitor's sound or alerts.
 */

const MIN = 60_000;
const P720 = PRESETS.find((p) => p.id === '720p')!;
const paths = (o: Partial<copy.PathTime>): copy.PathTime => ({ lan: 0, direct: 0, turn: 0, server: 0, ...o });

/** Every user string this module can produce: constants, plus each function over a spread of inputs. */
function everyString(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const [name, v] of Object.entries(copy)) if (name === name.toUpperCase() || name === 'WHO_PAYS') walk(v);
  out.push(USAGE.title('2026-10'), USAGE.resets('2026-10'), TIPS.relayNight('2 h'), COST.headline('≈ $0.06'), COST.recapHeadline('under $0.01'));
  for (const p of PRESETS) out.push(studioViewersLine(p), cloudCopySettingDesc(p, true), cloudCopySettingDesc(p, false));
  out.push(relayTip(), relayTip({ bytes: 2.1e9, limitGb: 10 }), relayTip({ bytes: 2.1e9, limitGb: 10, measured: false }));
  for (const p of ['lan', 'direct', 'turn', 'server', null] as const) out.push(callPathSuffix(p));
  for (const outgoing of [true, false]) {
    for (const t of [paths({ lan: 12 * MIN }), paths({ direct: 12 * MIN }), paths({ turn: 12 * MIN }), paths({ direct: 2 * MIN, turn: 10 * MIN })]) {
      for (const turnBytes of [0, 1.4e8]) {
        const r = callReceipt({ ms: t, turnBytes }, outgoing);
        if (r) out.push(callReceiptText(r));
      }
    }
  }
  for (const t of [
    paths({ lan: 10 * 60 * MIN }),
    paths({ direct: 10 * 60 * MIN }),
    paths({ lan: 5 * 60 * MIN, direct: 5 * 60 * MIN }),
    paths({ lan: 588 * MIN, turn: 12 * MIN }),
    paths({ direct: 500 * MIN, server: 100 * MIN }),
    paths({ server: 600 * MIN }),
  ]) {
    out.push(nightReceiptText('Last night', t), meetingDeliveryLine({ ms: t, guests: 3 }));
  }
  out.push(deliveryLine({ durMs: 62 * MIN, peakViewers: 20, storedBytes: 1.2e9, deliveredBytes: 23e9 }));
  for (const level of ['warn', 'full'] as const) {
    for (const scope of ['account', 'nursery'] as const) {
      out.push(relayNotice(level, 8.2e9, 10, '2026-10', scope)!, relayNotice(level, 10.4e9, 10, '2026-10', scope, { pictureFallback: true })!);
    }
    out.push(cloudCopyNotice(level, 8.5 * 1024 ** 3, 10 * 1024 ** 3)!);
  }
  return out.filter(Boolean);
}

/** A string's clauses: what one "·", "—", ";" or sentence says on its own. */
const clauses = (s: string) => s.split(/\s[·—]\s|[.;:](?:\s|$)|\(|\)/).map((c) => c.trim()).filter(Boolean);
const OURS = /\bour (?:relay|server|servers|storage)\b|\bthe relay\b|\bencrypted relay\b|\brelay data\b/i;

describe('formatting', () => {
  it('durations, GB (10⁹, what Cloudflare bills) and percents', () => {
    expect(fmtDuration(0)).toBe('< 1 min');
    expect(fmtDuration(12 * MIN)).toBe('12 min');
    expect(fmtDuration(59.7 * MIN)).toBe('1 h');
    expect(fmtDuration(62 * MIN)).toBe('1 h 02 m');
    expect(fmtDuration(10 * 60 * MIN)).toBe('10 h');
    expect(fmtDuration(212 * 60 * MIN)).toBe('212 h');
    expect(fmtGb(0)).toBe('0 GB');
    expect(fmtGb(5e6)).toBe('< 0.01 GB');
    expect(fmtGb(1.4e8)).toBe('0.14 GB');
    expect(fmtGb(2.1e9)).toBe('2.1 GB');
    expect(fmtGb(12.4e9)).toBe('12 GB');
    expect(pctOf(2.1, 10)).toBe(21);
    expect(pctOf(1, 0)).toBe(0);
    expect(monthName('2026-10')).toBe('October');
    expect(resetDay('2026-10')).toBe('November 1');
    expect(resetDay('2026-12')).toBe('January 1');
  });

  it('list-price estimates', () => {
    expect(fmtUsdEst(0)).toBe('$0.00');
    expect(fmtUsdEst(0.004)).toBe('under $0.01');
    expect(fmtUsdEst(0.06)).toBe('$0.06');
    expect(approxUsd(0.06)).toBe('≈ $0.06');
    expect(approxUsd(0.004)).toBe('under $0.01');
    expect(approxUsd(0)).toBe('$0.00');
  });
});

describe('rule 1 — "free" is never said of our relay or our server', () => {
  it('the path pills: Home Wi-Fi and Direct are free; the relay and our server never are', () => {
    expect(PATH_PILL).toEqual({ lan: 'Home Wi-Fi · free', direct: 'Direct · free', turn: 'Through our relay · encrypted', server: 'Through our server' });
    for (const p of ['turn', 'server'] as const) {
      expect(PATH_PILL[p]).not.toMatch(/free/i);
      expect(PATH_TIP[p]).not.toMatch(/free/i);
    }
    expect(relayTip({ bytes: 2.1e9, limitGb: 10 })).toMatch(/Relay data this month: 2\.1 GB of 10 GB\./);
    expect(relayTip({ bytes: 2.1e9, limitGb: 10, measured: false })).toMatch(/≈ 2\.1 GB/);
  });

  it('every clause that is about our relay, servers or storage leaves "free" out — at most "free for you"', () => {
    const bad: string[] = [];
    for (const s of everyString()) {
      for (const c of clauses(s)) if (OURS.test(c) && /\bfree\b(?! for you)/i.test(c)) bad.push(`${c}   ⟵ ${s}`);
    }
    expect(bad).toEqual([]);
  });

  it('receipts: free only for Home Wi-Fi and direct', () => {
    expect(callReceiptText(callReceipt({ ms: paths({ direct: 12 * MIN }), turnBytes: 0 }, true)!)).toBe('12 min · direct · free');
    expect(callReceiptText(callReceipt({ ms: paths({ lan: 12 * MIN }), turnBytes: 0 }, false)!)).toBe('12 min · Home Wi-Fi · free');
    expect(callReceiptText(callReceipt({ ms: paths({ turn: 12 * MIN }), turnBytes: 1.4e8 }, true)!)).toBe('12 min · encrypted relay · 0.14 GB of your relay data');
    expect(callReceiptText(callReceipt({ ms: paths({ turn: 12 * MIN }), turnBytes: 0 }, true)!)).toBe('12 min · encrypted relay · uses your relay data');
    // A call counts against the person who placed it (owner decision).
    expect(callReceiptText(callReceipt({ ms: paths({ turn: 12 * MIN }), turnBytes: 1.4e8 }, false)!)).toBe('12 min · encrypted relay · counts toward the caller’s relay data');
    // A call that never connected has no receipt.
    expect(callReceipt({ ms: paths({}), turnBytes: 0 }, true)).toBeNull();
    expect(callReceipt({ ms: paths({ direct: 500 }), turnBytes: 0 }, true)).toBeNull();
  });

  it('the night receipt: "Last night: 10 h · all direct · free" — and with any relay, free only next to the direct part', () => {
    expect(nightReceiptText('Last night', paths({ direct: 600 * MIN }))).toBe('Last night: 10 h · all direct · free');
    expect(nightReceiptText('Last night', paths({ lan: 600 * MIN }))).toBe('Last night: 10 h · all on Home Wi-Fi · free');
    expect(nightReceiptText('Last night', paths({ lan: 300 * MIN, direct: 300 * MIN }))).toBe('Last night: 10 h · all on Home Wi-Fi or direct · free');
    expect(nightReceiptText('Last night', paths({ direct: 588 * MIN, turn: 12 * MIN }))).toBe('Last night: 10 h · 98% direct (free) · 12 min through our relay');
    // Never rounded up to 100% while some of it went through us.
    expect(nightReceiptText('Last night', paths({ direct: 599.9 * MIN, server: 0.1 * MIN }))).toMatch(/99% direct \(free\)/);
    expect(nightReceiptText('Tonight so far', paths({ server: 120 * MIN }))).toBe('Tonight so far: 2 h · 2 h through our server');
  });

  it('the one word for a session', () => {
    expect(mainPath(paths({}))).toBeNull();
    expect(mainPath(paths({ lan: 5 }))).toBe('lan');
    expect(mainPath(paths({ lan: 5, direct: 1 }))).toBe('direct');
    expect(mainPath(paths({ direct: 50, turn: 1 }))).toBe('turn');
    expect(mainPath(paths({ direct: 50, turn: 1, server: 2 }))).toBe('server');
  });
});

describe('rule 2 — the server relay is never called end-to-end encrypted', () => {
  it('any clause about our server that says "end-to-end" says "not end-to-end"', () => {
    for (const s of everyString()) {
      for (const c of clauses(s)) if (/\bserver\b/i.test(c) && /end-to-end/i.test(c)) expect(c).toMatch(/not end-to-end/i);
    }
    expect(PATH_TIP.server).toMatch(/in memory only, never stored, not end-to-end encrypted/);
    expect(PATH_PILL.server).not.toMatch(/encrypted/i);
  });
});

describe('rule 3 — dollars only inside "What this costs DreamStream (est.)", never a charge', () => {
  it('the expander is labelled ours, an estimate at list price, with its date — and says you aren’t charged', () => {
    expect(COST.summary).toBe('What this costs DreamStream (est.)');
    expect(COST.headline(approxUsd(0.06))).toBe('≈ $0.06 this month at list price');
    expect(COST.recapHeadline(approxUsd(0.008))).toBe('under $0.01 at list price');
    expect(COST.notCharged).toMatch(/^You aren’t charged\./);
    expect(COST.checked).toMatch(/List prices checked 2026-10-22\. Estimates, not a bill\./);
  });

  it('no other copy has a $ figure, or says charge, bill, price or pay', () => {
    const notCost = everyString().filter((s) => !Object.values(COST).some((v) => v === s) && !/ at list price$/.test(s));
    for (const s of notCost) {
      expect(s).not.toMatch(/\$\d/);
      // Saying it isn't a charge is fine; anything else about charging or paying is not.
      expect(s.replace(/\b(?:aren’t|not|never) charged\b/gi, '')).not.toMatch(/\b(?:charge[ds]?|bill(?:ed)?|price[ds]?|pay|paid|cost)\b/i);
    }
  });

  it('in the app’s source, $ figures and fmtUsdEst live only in costCopy.ts and the expander', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) files.push(p);
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const p of files) {
      const rel = relative(root, p);
      if (rel === 'costCopy.ts' || rel === join('usage', 'CostExpander.tsx')) continue;
      // Code only: comments may talk about our prices.
      const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
      if (/\$\d+\.\d|fmtUsdEst\(|approxUsd\(|listValueUsd\(/.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe('rule 4 — every action that uses our servers says so before it starts', () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('Quick start: a path line on both cards', () => {
    expect(MEETING_LINE).toBe('Direct between you and your guests — free.');
    expect(MEETING_LINE_TIP).toMatch(/encrypted relay carries it/);
    expect(GO_LIVE_LINE).toBe('Through our servers · free for you · replay kept 24 h.');
    expect(GO_LIVE_LINE_TIP).toMatch(/You aren’t charged/);
    const qs = src('./views/create/QuickStart.tsx');
    expect(qs).toMatch(/cost: MEETING_LINE/);
    expect(qs).toMatch(/cost: GO_LIVE_LINE/);
  });

  it('Studio: the ready check says who carries the stream; Go live says it too; the viewer count carries it while live', () => {
    expect(studioViewersLine(P720)).toBe('Your viewers watch through our servers — free for you. You upload ≈ 1.2 GB an hour at 720p.');
    const sv = src('./views/StudioView.tsx');
    expect(sv).toMatch(/cost=\{studioViewersLine\(preset\)\}/);
    expect(sv.match(/GO_LIVE_LINE/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sv).toMatch(/BROADCAST_TIP/);
    expect(BROADCAST_TIP).toMatch(/^Live · through our servers · free for you, up to 200 viewers/);
  });

  it('Save sheet: free options first, each with who pays; the 7-day copy is headed "through our servers" before its button', () => {
    const ss = src('./components/SaveSheet.tsx');
    expect(FREE_CHIP).toEqual({ drive: 'Free · yours to keep', device: 'Free · on this device' });
    expect(CLOUD_COPY_HEAD).toBe('Or a 7-day copy · through our servers');
    expect(CLOUD_COPY_DRIVE_TIP).toMatch(/The 7-day copy uses our storage and your upload/);
    const head = ss.indexOf('{CLOUD_COPY_HEAD}');
    expect(head).toBeGreaterThan(ss.indexOf('FREE_CHIP[o.free]'));
    expect(head).toBeLessThan(ss.indexOf('Keep a 7-day copy'));
  });

  it('Settings: the 7-day copy toggle says what it uses (≈ 2.9 GB an hour at 720p, high bitrate)', () => {
    expect(cloudCopySettingDesc(P720, true)).toBe(
      'Off unless you turn it on. Each recorded hour at 720p uses ≈ 2.9 GB of your upload and our storage — kept 7 days, up to 10 GB per account. Google Drive and this device are free, and the file is yours to keep.',
    );
    expect(src('./views/SettingsView.tsx')).toMatch(/cloudCopySettingDesc\(preset, prefs\.recordHighBitrate\)/);
  });

  it('the camera line for the monitor setup says the family watches directly', () => {
    expect(CAMERA_FAMILY_LINE).toBe('Your family watches directly — free. Phones on the same Wi-Fi use no internet at all.');
  });
});

describe('rule 5 — a limit never cuts the baby monitor’s sound or alerts', () => {
  it('no copy says sound or alerts stop, pause, mute or are cut', () => {
    for (const s of everyString()) expect(s).not.toMatch(/\b(?:sound|alerts?)\b[^.·—]*\b(?:stop|stops|stopped|cut|paused?|pauses|muted|off|limited)\b(?<!never limited)/i);
  });

  it('the relay-data notices: 80% and 100%, honest about what happens, with the reset day', () => {
    expect(allowanceLevel(7.9, 10)).toBe('ok');
    expect(allowanceLevel(8, 10)).toBe('warn');
    expect(allowanceLevel(10, 10)).toBe('full');
    expect(allowanceLevel(5, 0)).toBe('ok');
    expect(relayNotice('ok', 1e9, 10, '2026-10', 'account')).toBeNull();
    expect(relayNotice('warn', 8.2e9, 10, '2026-10', 'account')).toBe('You’ve used 8.2 GB of your 10 GB of relay data this month. Direct and Home Wi-Fi don’t count. Resets November 1.');
    expect(relayNotice('warn', 8.2e9, 10, '2026-10', 'nursery')).toBe('This nursery has used 8.2 GB of this nursery’s 10 GB of relay data this month. Direct and Home Wi-Fi don’t count. Resets November 1.');
    const full = relayNotice('full', 10.2e9, 10, '2026-10', 'nursery')!;
    expect(full).toMatch(/sound and alerts are never limited/);
    // The picture only "pauses" where the room says it does.
    expect(full).not.toMatch(/pause/);
    const enforced = relayNotice('full', 10.2e9, 10, '2026-10', 'nursery', { pictureFallback: true })!;
    expect(enforced).toContain(RELAY_OUT_MONITOR);
    expect(RELAY_OUT_MONITOR).toMatch(/sound and alerts are unchanged/);
    expect(RELAY_OUT_MONITOR).not.toMatch(/our server/); // never "falls back to our server"
    // Calls and the account: nothing about the monitor, no claim of a cut.
    expect(relayNotice('full', 10.2e9, 10, '2026-10', 'account')).toBe('You’ve used this month’s 10 GB of relay data. Direct and Home Wi-Fi don’t count. Resets November 1.');
  });

  it('the 7-day copies notice: rolling, so space frees up as copies expire', () => {
    expect(cloudCopyNotice('ok', 1, 10)).toBeNull();
    expect(cloudCopyNotice('warn', 8.5 * 1024 ** 3, 10 * 1024 ** 3)).toBe('8.5 GB of your 10 GB of 7-day copies is in use. Google Drive and this device are free, and the file is yours to keep.');
    expect(cloudCopyNotice('full', 10 * 1024 ** 3, 10 * 1024 ** 3)).toMatch(/space frees up as older copies expire after 7 days/);
  });
});

describe('the recap lines', () => {
  it('a broadcast’s Delivery line uses ≈ for what is estimated', () => {
    expect(deliveryLine({ durMs: 62 * MIN, peakViewers: 20, storedBytes: 1.2e9, deliveredBytes: 23e9 })).toBe('1 h 02 m · peak 20 viewers · ≈ 1.2 GB stored for 24 h · ≈ 23 GB delivered');
    expect(deliveryLine({ durMs: 5 * MIN, peakViewers: 1, storedBytes: 0, deliveredBytes: 0 })).toBe('5 min · peak 1 viewer');
  });

  it('a hosted meeting’s line', () => {
    expect(meetingDeliveryLine({ ms: paths({ direct: 45 * MIN }), guests: 3 })).toBe('3 guests · 45 min on camera · all direct · free');
    expect(meetingDeliveryLine({ ms: paths({ direct: 40 * MIN, turn: 5 * MIN }), guests: 1 })).toBe('1 guest · 45 min on camera · 5 min through our relay');
    expect(meetingDeliveryLine({ ms: paths({}), guests: 0 })).toBe('0 guests · direct between you and your guests');
  });
});

describe('Help: the Usage guide and answers follow the same rules', () => {
  const guide = readFileSync(fileURLToPath(new URL('./components/Guide.tsx', import.meta.url)), 'utf8');
  const usageHelp = [
    guide.slice(guide.indexOf("id: 'usage'"), guide.indexOf("id: 'fix-camera'")),
    guide.slice(guide.indexOf("section: 'Usage & what’s free'"), guide.indexOf("section: 'Troubleshooting'")),
  ];

  it('there is a Usage guide that opens Customize → Usage, and a Usage section in Help', () => {
    expect(usageHelp[0]).toMatch(/hash: '#\/settings\?s=usage'/);
    expect(usageHelp[1]).toMatch(/Am I charged\?/);
    expect(guide).toMatch(/and Usage: what was free this month, and what went through our servers/);
  });

  it('never "free" for our relay or server, never a charge, and sound and alerts never limited', () => {
    const texts = usageHelp.flatMap((block) => [...block.matchAll(/(?:body|intro|a): '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]));
    expect(texts.length).toBeGreaterThan(8);
    const bad: string[] = [];
    for (const t of texts) {
      for (const c of clauses(t)) {
        // A clause listing what goes through our servers may say "(free for you)" — nothing else free.
        if (OURS.test(c) && /\bfree\b(?! for you)/i.test(c)) bad.push(c);
        if (/\bserver\b/i.test(c) && /end-to-end/i.test(c) && !/not end-to-end/i.test(c)) bad.push(c);
      }
    }
    expect(bad).toEqual([]);
    expect(usageHelp.join(' ')).toMatch(/sound and alerts are never limited/);
    expect(usageHelp.join(' ')).toMatch(/never a bill/);
  });
});
