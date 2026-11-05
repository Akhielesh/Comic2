// @vitest-environment node
/**
 * Every number and name the legal pages state comes from components/legal/legalFacts.ts. These
 * tests read the code that actually decides each one and fail the moment the two disagree, so a
 * retention change, a new provider or a new age rule can't ship with a stale policy.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RECORDING_RETENTION_MS, REPLAY_WINDOW_MS } from '../../live/protocol';
import { FAIR_USE } from '../../shared/stream/usage';
import {
    BILLING_LIVE,
    COMIC_PG_CEILING_UNDER_AGE,
    DIRECT_AI_PROVIDERS,
    MIN_SIGNUP_AGE_YEARS,
    PEOPLE_SEARCH,
    PRIVACY_EMAIL,
    RECENT_CALLS_KEPT,
    RETENTION,
    SECURITY_ADVISORY_URL,
    SECURITY_EMAIL,
    STREAM_FAIR_USE,
    SUPPORT_EMAIL
} from './legalFacts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The value of `[export] const NAME = <arithmetic>;` in a source file (digits, _, *, ** and spaces only). */
const constValue = (rel: string, name: string): number => {
    const m = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*([^;]+);`).exec(read(rel));
    if (!m) throw new Error(`${name} not found in ${rel}`);
    const expr = m[1].replace(/_/g, '').trim();
    if (!/^[\d\s*+()]+$/.test(expr)) throw new Error(`${name} in ${rel} is not plain arithmetic: ${expr}`);
    return Function(`"use strict"; return (${expr});`)() as number;
};

/** `key: <arithmetic>,` inside the object literal assigned to NAME. */
const objectField = (rel: string, name: string, key: string): number => {
    const body = new RegExp(`const\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`).exec(read(rel))?.[1] ?? '';
    const m = new RegExp(`\\b${key}:\\s*([\\d\\s*_]+)`).exec(body);
    if (!m) throw new Error(`${name}.${key} not found in ${rel}`);
    return Function(`"use strict"; return (${m[1].replace(/_/g, '')});`)() as number;
};

describe('legal facts match the code: retention', () => {
    it('Stream Studio replays and 7-day copies (live/protocol.ts and the EventRoom agree)', () => {
        expect(REPLAY_WINDOW_MS).toBe(RETENTION.replayHours * HOUR);
        expect(RECORDING_RETENTION_MS).toBe(RETENTION.cloudCopyDays * DAY);
        expect(constValue('live-worker/src/eventRoom.ts', 'REPLAY_WINDOW_MS')).toBe(RETENTION.replayHours * HOUR);
        expect(constValue('live-worker/src/eventRoom.ts', 'RECORDING_RETENTION_MS')).toBe(RETENTION.cloudCopyDays * DAY);
        expect(constValue('live-worker/src/eventRoom.ts', 'SWEEP_GRACE_MS')).toBe(RETENTION.recordingSweepGraceDays * DAY);
        expect(constValue('live-worker/src/cloudCopyQuota.ts', 'CLOUD_COPY_LIMIT_BYTES')).toBe(RETENTION.cloudCopyLimitGb * 1024 ** 3);
    });

    it('baby monitor history (live-worker/src/monitorStore.ts RETAIN) and the purge that applies it', () => {
        const store = 'live-worker/src/monitorStore.ts';
        expect(objectField(store, 'RETAIN', 'events')).toBe(RETENTION.monitorEventsDays * DAY);
        expect(objectField(store, 'RETAIN', 'incidents')).toBe(RETENTION.monitorIncidentsDays * DAY);
        expect(objectField(store, 'RETAIN', 'minutes')).toBe(RETENTION.monitorMinutesDays * DAY);
        expect(objectField(store, 'RETAIN', 'sleep')).toBe(RETENTION.monitorSleepDays * DAY);
        expect(read(store)).toMatch(/DELETE FROM mon_events WHERE at < \?`, now - RETAIN\.events/);
        // The purge rides on the room's housekeeping, i.e. while the nursery is in use.
        expect(read('live-worker/src/monitorRoom.ts')).toMatch(/private async housekeeping[\s\S]*?this\.tracker\.purge\(now\)/);
    });

    it('baby tracker entries (live-worker/src/trackerStore.ts TRACK_RETAIN_MS)', () => {
        expect(constValue('live-worker/src/trackerStore.ts', 'TRACK_RETAIN_MS')).toBe(RETENTION.trackerYears * 366 * DAY);
        expect(read('live-worker/src/trackerStore.ts')).toContain("DELETE FROM mon_track WHERE start < ?', now - TRACK_RETAIN_MS");
    });

    it('deleting a nursery only removes its row: the room storage is never wiped (the policy says so)', () => {
        expect(read('server/sql/live_security_v2.sql')).toMatch(/function public\.monitor_delete[\s\S]*?delete from public\.monitor_nurseries where id = p_nursery and owner_id = v_uid;/);
        expect(read('live-worker/src/monitorRoom.ts')).not.toMatch(/storage\.deleteAll\(/);
    });

    it('Comic Studio safety records and image-call logs (pg_cron purges in server/sql)', () => {
        const safety = read('server/sql/comic_safety.sql');
        expect(safety).toContain(`delete from public.comic_safety_events where created_at < now() - interval '${RETENTION.safetyEventsDays} days'`);
        expect(safety).toContain(`coalesce(resolved_at, created_at) < now() - interval '${RETENTION.closedSafetyCasesDays} days'`);
        expect(safety).toContain(`delete from public.comic_quarantine where created_at < now() - interval '${RETENTION.quarantineDays} days'`);
        expect(read('server/sql/comic_image_calls.sql')).toContain(`delete from public.comic_image_calls where created_at < now() - interval '${RETENTION.imageCallLogDays} days'`);
        expect(read('server/sql/image_assets_retention.sql')).toContain(`refresh_image_asset_references(${RETENTION.imageUnusedDays}, ${RETENTION.imageExpiryGraceDays})`);
    });

    it('the devices list window and the 30-day idle sign-out', () => {
        expect(constValue('services/deviceSessions.ts', 'ACTIVE_WINDOW_DAYS')).toBe(RETENTION.deviceActiveDays);
        expect(constValue('services/supabase.ts', 'INACTIVITY_SIGNOUT_MS')).toBe(30 * DAY);
    });

    it('recent calls kept per member', () => {
        expect(constValue('live-worker/src/directCalls.ts', 'DIRECT_LOG_CAP')).toBe(RECENT_CALLS_KEPT);
    });
});

describe('legal facts match the code: accounts, people and calls', () => {
    it('the sign-up age floor is the same in every sign-up path', () => {
        expect(constValue('components/AuthPage.tsx', 'MIN_SIGNUP_AGE_YEARS')).toBe(MIN_SIGNUP_AGE_YEARS);
        expect(constValue('server/src/routes/authEmail.ts', 'MIN_SIGNUP_AGE_YEARS')).toBe(MIN_SIGNUP_AGE_YEARS);
        const sheet = read('live/components/AuthSheet.tsx');
        expect(sheet).toContain(`d.setFullYear(d.getFullYear() - ${MIN_SIGNUP_AGE_YEARS});`);
        expect(sheet).toContain(`you must be ${MIN_SIGNUP_AGE_YEARS} or older`);
    });

    it('accounts under 13 get the PG ceiling in Comic Studio', () => {
        expect(read('server/src/comic/safety/index.ts')).toContain(`age !== null && age < ${COMIC_PG_CEILING_UNDER_AGE} ? 'PG' : PLATFORM_CEILING`);
    });

    it('people search: any member, 2+ letters, 12 results, no opt-out column', () => {
        const sql = read('server/sql/live_accounts_and_monitor.sql');
        const fn = /create or replace function public\.live_search_people[\s\S]*?\$\$;/.exec(sql)?.[0] ?? '';
        expect(fn).toContain(`char_length(v_q) < ${PEOPLE_SEARCH.minLetters}`);
        expect(fn).toContain(`limit ${PEOPLE_SEARCH.maxResults}`);
        expect(fn).not.toMatch(/discoverable|searchable|hidden/i);
    });

    it('calls are open to every member by default ("Who can call you" = everyone)', () => {
        expect(read('live-worker/src/directCalls.ts')).toContain("export const DEFAULT_PREFS: DirectPrefs = { who: 'everyone' };");
    });

    it('fair-use allowances (shared/stream/usage.ts FAIR_USE)', () => {
        expect(FAIR_USE).toMatchObject(STREAM_FAIR_USE);
    });
});

describe('legal facts match the code: providers, billing, email and contacts', () => {
    it('every direct chat provider in the gateway is named, plus Anthropic and NVIDIA', () => {
        const gateway = read('server/src/ai/gateway.ts');
        const labels = [...gateway.matchAll(/label: '([^']+)', baseUrl:/g)].map((m) => m[1]);
        expect(labels.length).toBeGreaterThanOrEqual(7);
        const named = DIRECT_AI_PROVIDERS.join(' | ');
        for (const label of labels) expect(named).toContain(label);
        expect(statSync(path.join(ROOT, 'server/src/ai/providers/anthropic.ts')).isFile()).toBe(true);
        expect(statSync(path.join(ROOT, 'server/src/ai/providers/nvidia.ts')).isFile()).toBe(true);
    });

    it('billing is off in production', () => {
        expect(BILLING_LIVE).toBe(false);
        expect(read('api-proxy/wrangler.jsonc')).toMatch(/"BILLING_ENABLED":\s*"false"/);
    });

    it('the email open-tracking image is on by default and off only for auth mail', () => {
        expect(read('server/src/services/mailer.ts')).toMatch(/params\.pixelUrl = `\$\{EMAIL_PUBLIC_BASE_URL\}\/api\/email\/o\/\$\{logId\}\.gif`/);
        expect(read('server/src/routes/authEmail.ts')).toMatch(/track: false/);
    });

    it('interest registrations keep at most a 1,000-character note and these studios', () => {
        const store = read('server/src/services/emailStore.ts');
        expect(store).toContain("intent.feedback.trim().slice(0, 1000)");
        expect(store).toContain("export const WAITLIST_PRODUCTS = ['comic_studio', 'chat_studio', 'code_studio', 'stream_studio', 'dashboards'] as const;");
    });

    it('security reports go where security.txt says', () => {
        const txt = read('public/.well-known/security.txt');
        expect(txt).toContain(`Contact: mailto:${SECURITY_EMAIL}`);
        expect(txt).toContain(`Contact: ${SECURITY_ADVISORY_URL}`);
    });

    it('support@ and privacy@ are the routed mailboxes in the setup guide', () => {
        const guide = read('docs/connectors/google-setup.md');
        expect(guide).toContain(`\`${SUPPORT_EMAIL}\` → your real inbox`);
        expect(guide).toContain(`\`${PRIVACY_EMAIL}\` → your real inbox`);
    });
});

describe('legal facts match the code: no trackers, no cookies', () => {
    const CLIENT_DIRS = ['components', 'services', 'hooks', 'live', 'contexts', 'lib'];
    const files = (dir: string): string[] =>
        readdirSync(path.join(ROOT, dir)).flatMap((name) => {
            const rel = path.join(dir, name);
            const full = path.join(ROOT, rel);
            if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : files(rel);
            return /\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name) ? [rel] : [];
        });

    it('our own client code never writes a cookie', () => {
        const writers = [...CLIENT_DIRS.flatMap(files), 'App.tsx', 'index.tsx'].filter((f) => /document\.cookie\s*=/.test(read(f)));
        expect(writers).toEqual([]);
    });

    it('no analytics or advertising SDK is a dependency or loaded by an HTML entry', () => {
        const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' ');
        expect(deps).not.toMatch(/posthog|segment|mixpanel|amplitude|google-analytics|gtag|@sentry|datadog|hotjar|plausible|umami|logrocket|fullstory|clarity|intercom/i);
        for (const html of ['index.html', 'live.html']) {
            expect(read(html)).not.toMatch(/googletagmanager|google-analytics|gtag\(|posthog|plausible|hotjar|clarity\.ms|facebook\.net/i);
        }
    });

    it('the third parties the cookie notice names are exactly the ones the HTML entries load', () => {
        const hosts = new Set([...`${read('index.html')}\n${read('live.html')}`.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]));
        expect([...hosts].sort()).toEqual(['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com']);
        expect(read('components/Turnstile.tsx')).toContain('challenges.cloudflare.com');
    });
});
