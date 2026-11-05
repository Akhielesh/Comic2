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
import { TOOL_SERVICES } from './SubprocessorsPage';
import {
    BILLING_LIVE,
    BROWSER_THIRD_PARTIES,
    COMIC_PG_CEILING_UNDER_AGE,
    DIRECT_AI_PROVIDERS,
    EVENT_ROOM_KEPT,
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

    it('baby tracker entries (live-worker/src/trackerStore.ts TRACK_RETAIN_MS), and deleted ones', () => {
        expect(constValue('live-worker/src/trackerStore.ts', 'TRACK_RETAIN_MS')).toBe(RETENTION.trackerYears * 366 * DAY);
        expect(read('live-worker/src/trackerStore.ts')).toContain("DELETE FROM mon_track WHERE start < ?', now - TRACK_RETAIN_MS");
        expect(read('live-worker/src/trackerStore.ts')).toContain(`DELETE FROM mon_track WHERE deleted = 1 AND updated < ?', now - ${RETENTION.trackerDeletedDays} * DAY`);
    });

    it('what a Stream Studio event keeps, and that nothing ever wipes the event room', () => {
        const room = 'live-worker/src/eventRoom.ts';
        expect(constValue(room, 'CHAT_CAP')).toBe(EVENT_ROOM_KEPT.chatMessages);
        expect(constValue(room, 'RSVP_CAP')).toBe(EVENT_ROOM_KEPT.rsvpNames);
        expect(constValue(room, 'LOG_CAP')).toBe(EVENT_ROOM_KEPT.logEntries);
        expect(read(room)).not.toMatch(/storage\.deleteAll\(/);
        expect(read(room)).toContain('The event and its links stay');
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

    it('interest registrations keep at most a 1,000-character note (the studio list itself is not pinned: the page says "the studios or features you pick")', () => {
        const store = read('server/src/services/emailStore.ts');
        expect(store).toContain('intent.feedback.trim().slice(0, 1000)');
        expect(store).toMatch(/export const WAITLIST_PRODUCTS = /);
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

describe('legal facts match the code: what Chat Studio, the assistant and the account really do', () => {
    it('API keys added while signed in are copied to the account, encrypted, and deleting one removes that copy', () => {
        expect(read('services/byokSync.ts')).toContain("post('/api/account/byok'");
        expect(read('components/ApiConfiguration.tsx')).toMatch(/if \(user\) await syncByokKeyToServer\(/);
        expect(read('components/ApiConfiguration.tsx')).toMatch(/deleteKey\(k\.id\); void reconcileProviderMirror\(k\.provider\)/);
        expect(read('server/src/routes/account.ts')).toMatch(/from\('user_api_keys'\)\.upsert\(/);
        expect(read('server/src/lib/secureStore.ts')).toContain("createCipheriv('aes-256-gcm'");
    });

    it('every Chat Studio answer logs a usage event without the message text', () => {
        const chat = read('components/chat/AIChatPlatform.tsx');
        const event = /captureEvent\(\{\s*eventType: 'chat_turn'[\s\S]*?\n\s{6}\}\);/.exec(chat)?.[0] ?? '';
        expect(event).toContain('latencyMs');
        expect(event).toContain('contentLength');
        expect(event).not.toMatch(/\bmessage:|\btext:|content:/);
        const store = read('server/src/services/telemetryStore.ts');
        for (const col of ['user_id: ctx.userId', 'ip: str(ctx.ip', 'user_agent: str(ctx.userAgent', 'surface: str(loggablePath(e.surface)']) expect(store).toContain(col);
    });

    it('the site-wide assistant runs on the pages the policy names and saves frustrated messages as feedback', () => {
        const chrome = read('services/assistantChrome.ts');
        expect(chrome).toContain("const NOT_MOUNTED = new Set(['auth-callback', 'shared', 'chat', 'comicstudio', 'publiccomic']);");
        const assistant = read('components/UniversalAssistant.tsx');
        expect(assistant).toMatch(/const sentiment = detectSentiment\(message\);[\s\S]*?submitFeedback\(\{[\s\S]*?comment: message/);
        expect(assistant).toMatch(/maskedEmail: maskEmail\(/);
        expect(read('server/src/routes/assistant.ts')).toContain('The assistant runs on a free OpenRouter model.');
    });

    it('the approximate location goes into the model prompt, and its lookup is plain HTTP', () => {
        expect(read('server/src/ai/chat.ts')).toContain('- Approximate user location: ');
        expect(read('server/src/ai/clientGeo.ts')).toContain('`http://ip-api.com/json/');
    });

    it('project images sit in the public (unguessable, not listable) bucket; only references and quarantine are private', () => {
        const paths = read('server/src/comic/storagePaths.ts');
        expect(paths).toMatch(/generated \/ derived\s*\|\s*comic-assets\s*\|\s*u\/<user>\/p\/<project>\/img\//);
        expect(paths).toMatch(/refs & uploads\s*\|\s*comic-private/);
    });

    it('Comic Studio pauses generation after repeated blocked requests (15 minutes, or a day)', () => {
        const deps = read('server/src/comic/safety/deps.ts');
        expect(deps).toContain('if (week >= 6) until = last + DAY;');
        expect(deps).toContain('else if (day >= 3) until = last + 15 * MINUTE;');
    });
});

describe('legal facts match the code: every third party a browser or a tool contacts is named', () => {
    const CLIENT_DIRS = ['components', 'services', 'hooks', 'live', 'contexts', 'lib'];
    const files = (dir: string, ext = /\.(tsx?|jsx?)$/): string[] =>
        readdirSync(path.join(ROOT, dir)).flatMap((name) => {
            const rel = path.join(dir, name);
            if (statSync(path.join(ROOT, rel)).isDirectory()) return name === 'node_modules' || name === '__fixtures__' || name === 'testing' ? [] : files(rel, ext);
            return ext.test(name) && !/\.test\./.test(name) ? [rel] : [];
        });
    const OURS = /(^|\.)(dreamstreamstudio\.ai|dreamstream\.app|workers\.dev|supabase\.co)$|^(example\.com|server\.example\.com|docs\.example\.com|cdn\.test)$/;
    const documented = BROWSER_THIRD_PARTIES.flatMap((p) => p.hosts).filter((h) => h !== '*');
    const isDocumented = (host: string) =>
        documented.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h || host.endsWith(`.${h}`)));
    const undocumented = (hosts: Iterable<string>) => [...new Set(hosts)].filter((h) => !OURS.test(h) && !isDocumented(h)).sort();

    it('hosts the client code loads as images, tiles, scripts, fetches or CDNs (components, live, services…)', () => {
        // A line that both names an https host and loads something from it. Links people click are not
        // "loaded" and stay out; demo data in the component gallery is not shown to anyone's account.
        const ASSET = /\bsrc\b|fetch\(|tileLayer|\bTILES?\b|\bCDN\b|\/logos?\/|favicons|image-stock|create-qr-code|SCRIPT_SRC|indexURL/i;
        const skip = /components[\\/](legal[\\/]|PrivacyPolicy|TermsOfService|chat[\\/]ComponentGallery)/;
        const hosts: string[] = [];
        for (const f of [...CLIENT_DIRS.flatMap((d) => files(d)), 'App.tsx'].filter((f) => !skip.test(f))) {
            for (const line of read(f).split('\n')) {
                if (!ASSET.test(line) || /placeholder=/.test(line)) continue;
                for (const m of line.matchAll(/https:\/\/(?:\{[a-z]\}\.)?([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.push(m[1].toLowerCase());
            }
        }
        expect(hosts.length).toBeGreaterThan(5);
        expect(undocumented(hosts), 'add the service to BROWSER_THIRD_PARTIES in components/legal/legalFacts.ts').toEqual([]);
    });

    it('Sandpack previews (CodeSandbox) and the STUN servers Stream Studio uses', () => {
        const sandpack = CLIENT_DIRS.flatMap((d) => files(d)).filter((f) => read(f).includes("from '@codesandbox/sandpack-react'"));
        if (sandpack.length) expect(isDocumented('x.codesandbox.io')).toBe(true);
        const stun = [...CLIENT_DIRS, 'live-worker/src'].flatMap((d) => files(d)).flatMap((f) => [...read(f).matchAll(/stuns?:([a-z0-9.-]+)/g)].map((m) => m[1]));
        expect(stun).toContain('stun.l.google.com');
        expect(undocumented(stun)).toEqual([]);
    });

    it('third-party origins in the main site\'s and Stream Studio\'s CSP', () => {
        const csp = [...read('functions/_middleware.ts').matchAll(/'https:\/\/(?:\*\.)?([a-z0-9.-]+)'/g)].map((m) => (m[0].includes('*.') ? `x.${m[1]}` : m[1]));
        expect(csp).toContain('cdnjs.cloudflare.com');
        expect(undocumented(csp)).toEqual([]);
    });

    it('hosts Chat Studio\'s tools contact are named on the Subprocessors page (or covered by its "similar public sources")', () => {
        const page = TOOL_SERVICES.map((t) => `${t.name} ${t.purpose}`).join(' ') + ' ' + BROWSER_THIRD_PARTIES.map((p) => p.name).join(' ');
        // host pattern → the words on the page that cover it.
        const NAMED: [RegExp, string][] = [
            [/(^|\.)(searx\.be|searx\.tiekoetter\.com|priv\.au|search\.bus-hit\.me)$/, 'SearXNG'],
            [/tavily/, 'Tavily'], [/search\.brave/, 'Brave Search'], [/serper/, 'Serper'], [/www\.googleapis\.com/, 'Google Programmable Search'],
            [/duckduckgo/, 'DuckDuckGo'], [/bing\.com/, 'Bing'], [/wikipedia/, 'Wikipedia'], [/r\.jina\.ai/, 'Jina Reader'],
            [/nominatim|overpass|openstreetmap/, 'OpenStreetMap'], [/foursquare/, 'Foursquare'],
            [/met\.no/, 'MET Norway'], [/open-meteo/, 'Open-Meteo'], [/ip-api\.com/, 'ip-api.com'], [/ipinfo/, 'IPinfo'],
            [/news\.google/, 'Google News'], [/yahoo/, 'Yahoo Finance'], [/stooq/, 'Stooq'], [/alpaca/, 'Alpaca'], [/finnhub/, 'Finnhub'],
            [/coingecko/, 'CoinGecko'], [/binance/, 'Binance'], [/okx/, 'OKX'], [/llama/, 'DefiLlama'], [/polymarket/, 'Polymarket'],
            [/manifold/, 'Manifold'], [/cnn/, 'CNN'], [/alternative\.me/, 'alternative.me'], [/stlouisfed/, 'FRED'],
            [/treasury\.gov/, 'US Treasury'], [/cftc/, 'CFTC'], [/frankfurter/, 'Frankfurter'],
            [/openlibrary/, 'Open Library'], [/arxiv/, 'arXiv'], [/nasa/, 'NASA'], [/usgs/, 'USGS'], [/themealdb/, 'TheMealDB'],
            [/thecocktaildb/, 'TheCocktailDB'], [/github/, 'GitHub'], [/npmjs/, 'npm'], [/pypi/, 'PyPI'], [/hn\.algolia|ycombinator/, 'Hacker News'],
            [/tvmaze/, 'TVmaze'], [/huggingface/, 'Hugging Face'], [/agify/, 'agify'], [/genderize/, 'genderize'], [/nationalize/, 'nationalize'],
            [/amadeus/, 'Amadeus'], [/qrserver/, 'goQR'], [/context7/, 'Context7'], [/deepwiki/, 'DeepWiki'],
            // The one-click MCP catalog (server/src/ai/tools/mcpCatalog.ts): servers a person chooses to add.
            [/mcp\.|gitmcp|knowledge-mcp|learn\.microsoft|livescoremcp|subwayinfo/, 'MCP servers you add'],
            // Links handed to the person (open in their browser when they click), never fetched by a tool.
            [/mail\.google\.com|www\.google\.com|www\.youtube\.com|www\.wsj\.com/, 'Google']
        ];
        // Small free public-data services covered by the knowledge row's "similar public sources".
        const PUBLIC = /adviceslip|datamuse|dictionaryapi|jikan|open-notify|wheretheiss|spacexdata|sunrise-sunset|zippopotam|nager\.at|icanhazdadjoke|numbersapi|opentdb|pokeapi|restcountries|hipolabs|uselessfacts/;
        expect(page).toContain('similar public sources');
        const toolFiles = readdirSync(path.join(ROOT, 'server/src/ai/tools')).filter((n) => /\.ts$/.test(n) && !/\.test\./.test(n));
        const hosts = new Set(toolFiles.flatMap((n) => [...read(`server/src/ai/tools/${n}`).matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase())));
        const unnamed: string[] = [];
        for (const host of hosts) {
            if (OURS.test(host) || PUBLIC.test(host)) continue;
            const hit = NAMED.find(([re]) => re.test(host));
            if (!hit) unnamed.push(host);
            else expect(page, `${host} → "${hit[1]}"`).toContain(hit[1]);
        }
        expect(unnamed, 'name the service on the Subprocessors page (TOOL_SERVICES) and map it here').toEqual([]);
    });
});
