// @vitest-environment node
/**
 * Every number and name the legal pages state comes from components/legal/legalFacts.ts. These
 * tests read the code that actually decides each one and fail the moment the two disagree, so a
 * retention change, a new provider or a new age rule can't ship with a stale policy.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RECORDING_RETENTION_MS, REPLAY_WINDOW_MS } from '../../live/protocol';
import { sanitizeAssistantContext } from '../../server/src/ai/assistantPolicy';
import { buildProjectSnapshot } from '../../services/assistantContext';
import { assistantChrome } from '../../services/assistantChrome';
import { FAIR_USE } from '../../shared/stream/usage';
import { IMAGE_MODELS } from '../../services/imageModels';
import { inboxKey } from '../../server/src/services/emailStore';
import { prepareMemoryImportContent } from '../../services/memoryImport';
import { TOOL_SERVICES } from './SubprocessorsPage';
import {
    ASSISTANT_SCRIPT_PREVIEW_CHARS,
    BILLING_LIVE,
    BROWSER_THIRD_PARTIES,
    COMIC_PG_CEILING_UNDER_AGE,
    CONFIRM_EMAIL_LIMITS,
    CONFIRM_LINK_DAYS,
    DIRECT_AI_PROVIDERS,
    EVENT_ROOM_KEPT,
    MEMORY_IMPORT_MAX_CHARS,
    MEMORY_NOTE_MODEL,
    MEMORY_SEARCH_MAX_CHARS,
    MIN_SIGNUP_AGE_YEARS,
    PEOPLE_SEARCH,
    PRIVACY_EMAIL,
    QUICK_FINDER,
    RECENT_CALLS_KEPT,
    RETENTION,
    SECURITY_ADVISORY_URL,
    SECURITY_EMAIL,
    STREAM_FAIR_USE,
    SUPPORT_EMAIL
} from './legalFacts';

// buildProjectSnapshot's module also loads artifacts from the database; nothing here touches it.
vi.mock('../../services/db', () => ({ loadArtifactsForProject: async () => [] }));

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

/** Every non-test file under `dir` with this extension (.ts by default), relative to the app root. */
const sourceFiles = (dir: string, ext = /\.ts$/): string[] =>
    readdirSync(path.join(ROOT, dir)).flatMap((name) => {
        const rel = path.join(dir, name);
        if (statSync(path.join(ROOT, rel)).isDirectory()) return sourceFiles(rel, ext);
        return ext.test(name) && !/\.test\./.test(name) ? [rel] : [];
    });

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

    it(`confirmation links for updates and interest registrations stop working after ${CONFIRM_LINK_DAYS} days`, () => {
        const ttl = /NEWSLETTER_CONFIRM_TTL_HOURS = parseIntegerEnv\(\s*process\.env\.NEWSLETTER_CONFIRM_TTL_HOURS,\s*(\d+),/.exec(read('server/src/config.ts'));
        expect(Number(ttl?.[1]) * HOUR).toBe(CONFIRM_LINK_DAYS * DAY);
        expect(read('server/src/services/confirmToken.ts')).toMatch(/now - issuedAtMs > NEWSLETTER_CONFIRM_TTL_HOURS \* 3_600_000/);
        // Production config sets no override (D1 backend_env was checked by hand on 2026-11-05).
        expect(read('api-proxy/wrangler.jsonc')).not.toContain('NEWSLETTER_CONFIRM_TTL_HOURS');
    });

    // The page says "Until you ask us to delete them" / "Not deleted automatically today" for
    // update and interest rows and delivery records. True while only the unapplied SQL file purges
    // them; see the TODO on RETENTION in legalFacts.ts.
    it('no server code deletes update/interest rows or delivery records; the 30-day purges exist only in the unapplied register_interest_2026_11.sql', () => {
        const deleters = sourceFiles('server/src').filter((f) =>
            /from\(\s*(?:'waitlist_signups'|'email_log'|TABLE)\s*\)\s*\.delete\(/.test(read(f))
        );
        expect(deleters).toEqual([]);
        const sql = read('server/sql/register_interest_2026_11.sql');
        expect(sql).toContain("'waitlist-interest-retention-daily'");
        expect(sql).toMatch(/delete from public\.waitlist_signups as w[\s\S]*?< now\(\) - interval '30 days'[\s\S]*?< now\(\) - interval '30 days';/);
        expect(sql).toMatch(/delete from public\.email_log as l\s+where l\.template = 'newsletter-confirm'[\s\S]*?now\(\) - interval '30 days'/);
        // Its purge covers update/interest rows only: early-access requests (kind 'access') stay
        // until someone asks, which their own retention row says.
        expect(sql).toMatch(/delete from public\.waitlist_signups as w\s+where w\.kind = 'updates'/);
        // When that file is applied, the retention rows change (the TODO in legalFacts.ts).
        const policy = read('components/PrivacyPolicy.tsx');
        expect(policy).toContain("['Update sign-ups and interest registrations', `Until you ask us to delete them.");
        expect(policy).toContain("['Email delivery records and open times', 'Not deleted automatically today.']");
        expect(policy).toContain("['Early-access requests', 'Until you ask us to delete them. Unsubscribing adds the time you unsubscribed and keeps the request.']");
    });

    it(`a repeat registration re-sends the confirmation at most every ${CONFIRM_EMAIL_LIMITS.minIntervalMinutes} minutes and ${CONFIRM_EMAIL_LIMITS.maxPerDay} times a day per inbox, with the link first sent`, () => {
        const store = read('server/src/services/interestStore.ts');
        const limits = /INTEREST_CONFIRM_THROTTLE = \{ minIntervalMs: (\d+) \* 60_000, maxPerDay: (\d+) \}/.exec(store);
        expect(Number(limits?.[1])).toBe(CONFIRM_EMAIL_LIMITS.minIntervalMinutes);
        expect(Number(limits?.[2])).toBe(CONFIRM_EMAIL_LIMITS.maxPerDay);
        // Counted over the inbox (every alias of the address), over a rolling day.
        expect(store).toContain('const sends = await recentConfirmEmailsToInbox(email, iso(now - DAY_MS));');
        // The re-sent email carries the stored link while more than an hour of it is left, and its
        // lifetime runs from when it was first issued (confirmToken.ts never extends it).
        expect(store).toContain('return confirmTokenExpired(issuedAt, now, 3_600_000) ? null : row.confirm_token;');
        expect(store).toContain('const token = reusableToken(row, email, now) ?? issueConfirmToken(email, now);');
    });
});

describe('legal facts match the code: the limits on unauthenticated email hold under parallel requests', () => {
    it('the confirmation throttle claims the inbox (every alias) before the row, and the email copy states the same daily limit', () => {
        const store = read('server/src/services/interestStore.ts');
        expect(store).toContain("const releaseInbox = throttle ? null : claimInbox('confirm', email);");
        expect(store).toMatch(/if \(throttle\) return \{ outcome: 'throttled', reason: throttle\.code \};\s*\/\/[^\n]*\n\s*const releaseInbox = claimInbox\('confirm', email\);\s*if \(!releaseInbox\) return \{ outcome: 'throttled', reason: 'in_flight' \};/);
        expect(store).toContain('const key = `${scope}:${inboxKey(email)}`;');
        // Both routes let the claim go once the send is over.
        for (const f of ['server/src/routes/interest.ts', 'server/src/routes/newsletter.ts']) expect(read(f), f).toContain('result.sent();');
        // The confirmation email's own "up to 3 of these a day" is the throttle's number, per inbox key:
        // spellings the key doesn't fold (Proton's dots, me.com/icloud.com, Fastmail subdomains,
        // catch-alls) reach one inbox with 3 each, and the email says "or more" for them.
        const templates = read('shared/email/templates.ts');
        expect(templates).toContain(`export const NEWSLETTER_CONFIRM_MAX_PER_DAY = ${CONFIRM_EMAIL_LIMITS.maxPerDay};`);
        expect(inboxKey('v.ic@proton.me')).not.toBe(inboxKey('vic@proton.me'));
        expect(inboxKey('vic@me.com')).not.toBe(inboxKey('vic@icloud.com'));
        expect(templates).toContain("you may get up to ${NEWSLETTER_CONFIRM_MAX_PER_DAY} of these a day, or more if it's entered in other spellings that reach the same inbox.");
    });

    it('answer timing and the cap boundary: SECURITY.md states the residuals the code leaves (the slowest 5% of sends with 20+ samples, the hold a send raises, an hour\'s window; several refusals at one cap boundary, and a few sends over a cap)', () => {
        const store = read('server/src/services/interestStore.ts');
        expect(store).toContain('return Math.max(answerFloorMs, sorted[Math.ceil(sorted.length * 0.95) - 1]);');
        expect(store).toContain('export const SENT_SAMPLE_WINDOW_MS = 60 * 60_000;');
        expect(read('server/src/routes/interest.ts')).toMatch(/noteSentDuration\(startedAt\);[\s\S]{0,300}await holdAnswer\(startedAt\);/);
        // The mailer counts only rows logged as sent, at send time.
        expect(read('server/src/services/emailStore.ts')).toMatch(/export const getUsage[\s\S]{0,800}\.eq\('status', 'sent'\)/);
        expect(read('server/src/services/mailer.ts')).toContain('const usage = await getUsage();');
        const doc = read('docs/email/SECURITY.md');
        expect(doc).toContain('the 95th percentile of the sends in the last hour (`SENT_SAMPLE_WINDOW_MS`, at most 50 of them)');
        expect(doc).toContain('with 20 or more sends in the hour the hold leaves out the slowest 5% (it is the 2nd or 3rd slowest), so about one send in 20 answers later than a throttled request would');
        expect(doc).toContain('a slow one also raises the hold for the answers after it, which a request made right after it can see');
        expect(doc).toContain('That can hit several requests at one boundary, and the count at their check need only be within the number of sends then finishing, not exactly one under');
        expect(doc).toContain('so the count can end a few over a cap (by at most the sends in flight together)');
        for (const stale of ['a send slower than every recent one', 'at most once per boundary', 'over-cap sends are skipped + alerted, never delivered']) expect(doc).not.toContain(stale);
        expect(store).not.toContain('Only a send slower than all of that still answers later.');
    });

    it('the early-access receipt goes at most once a day per inbox and shares the public-form budget (the page says "at most one such email a day to one inbox")', () => {
        const store = read('server/src/services/interestStore.ts');
        expect(store).toContain('export const ACCESS_RECEIPT_INTERVAL_MS = DAY_MS;');
        expect(store).toContain('recentConfirmEmailsToInbox(email, iso(now - ACCESS_RECEIPT_INTERVAL_MS), ACCESS_REQUESTED_TEMPLATE)');
        expect(read('server/src/services/emailStore.ts')).toContain('export const PUBLIC_FORM_EMAIL_TEMPLATES = [NEWSLETTER_CONFIRM_TEMPLATE, ACCESS_REQUESTED_TEMPLATE] as const;');
        const newsletter = read('server/src/routes/newsletter.ts');
        const access = newsletter.slice(newsletter.indexOf("if (kind === 'access') {"), newsletter.indexOf('// Newsletter double opt-in'));
        expect(access).toMatch(/const receipt = await claimAccessReceipt\(email\);\s*if \(receipt\) \{/);
        // "None while the allowance is used up": the receipt is skipped on the budget share or the cap.
        expect(store).toContain('if (budget || capped || (recent && recent.length > 0)) return null;');
        // "Counting the +tag and Gmail dot spellings as the same address", and nothing more: those two
        // fold together, other spellings of one mailbox don't (the page claims no more than this).
        expect(inboxKey('Vic.Tim+news@googlemail.com')).toBe(inboxKey('victim@gmail.com'));
        expect(inboxKey('vic+x@proton.me')).toBe('vic@proton.me');
        expect(inboxKey('vic@proton.me')).not.toBe(inboxKey('vic@protonmail.com'));
        expect(inboxKey('v.ic@proton.me')).not.toBe(inboxKey('vic@proton.me'));
        expect(inboxKey('a@vic.fastmail.com')).not.toBe(inboxKey('b@vic.fastmail.com'));
        const policy = read('components/PrivacyPolicy.tsx');
        expect(policy).toContain("otherwise it usually emails you to confirm we received it: at most one such email a day to one address, counting the +tag and Gmail dot spellings of an address as the same address, and none while that day's or month's allowance for these emails is used up.");
        expect(policy).not.toContain('however the address is written');
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

    it('Comic Studio\'s writing steps can go to NVIDIA as well as OpenRouter and Gemini, and the page names all three', () => {
        const text = read('server/src/routes/text.ts');
        const resolve = text.slice(text.indexOf('const resolveTextProvider'), text.indexOf("textRouter.post('/analyze-script'"));
        const providers = [...new Set([...resolve.matchAll(/provider: '([a-z]+)'/g)].map((m) => m[1]))].sort();
        expect(providers).toEqual(['gemini', 'nvidia', 'openrouter']);
        expect(resolve).toContain("if (textSource === 'nvidia' && nvidiaKey) return nvidiaPick();");
        expect(resolve).toMatch(/if \(openRouterKey\) return openRouterPick\(\);\s*if \(nvidiaKey\) return nvidiaPick\(\);/);
        // The source is the app-wide pick under Settings → API & Models, sent with every call.
        expect(read('services/apiClient.ts')).toContain("...(textSource ? { 'X-Text-Source': textSource as string } : {}),");
        expect(read('components/PrivacyPolicy.tsx')).toContain("Google's Gemini API, NVIDIA, or a model reached through OpenRouter");
    });

    it(`every signed-in Chat Studio message goes to Google's Gemini API to search memory (first ${MEMORY_SEARCH_MAX_CHARS} characters), whichever provider answers`, () => {
        const memory = read('server/src/services/userMemory.ts');
        const retrieve = memory.slice(memory.indexOf('export const retrieveUserMemories'), memory.indexOf('export const buildUserMemoryBlock'));
        expect(retrieve).toContain("const queryEmbedding = await embedText(query, 'RETRIEVAL_QUERY');");
        // Before anything checks whether the account has notes.
        expect(retrieve.indexOf("embedText(query, 'RETRIEVAL_QUERY')")).toBeLessThan(retrieve.indexOf('fetchRecent'));
        expect(memory).toContain('`${GEMINI_BASE_URL}/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${ASSISTANT_GEMINI_API_KEY}`');
        expect(Number(/text\.slice\(0, ([\d_]+)\)/.exec(memory)?.[1].replace(/_/g, ''))).toBe(MEMORY_SEARCH_MAX_CHARS);
        // Memory is on unless someone turned it off (only by email today), and every signed-in turn asks for it.
        expect(memory).toContain('const enabled = data ? data.enabled !== false : true; // default ON');
        expect(read('server/src/routes/chat.ts')).toContain('userMemory: Boolean(p.userId),');
        expect(read('server/src/ai/chat.ts')).toMatch(/if \(params\.userId && params\.userMemory\) \{[\s\S]*?buildUserMemoryBlock\(params\.userId, memoryQuery\)/);
        expect(read('components/PrivacyPolicy.tsx')).toContain("is also sent to Google's Gemini API before the answer is written, whichever model or provider you chose, even when you have no saved notes.");
    });

    it('turning memory off stops memory search and saving notes to the account\'s memory, but not the requests that write them, nor the in-app list, which keeps growing, syncs to the account and goes with every request (the page says which)', () => {
        const memory = read('server/src/services/userMemory.ts');
        const block = memory.slice(memory.indexOf('export const buildUserMemoryBlock'));
        // Off: nothing is searched (no Gemini embedding) and no saved note is sent.
        expect(block).toMatch(/^export const buildUserMemoryBlock[^\n]*\n\s*if \(!\(await isMemoryEnabled\(userId\)\)\) return null;\s*const rows = await retrieveUserMemories/);
        // Off: a written note is dropped only after the model wrote it.
        const remember = memory.slice(memory.indexOf('export const rememberUserMemories'), memory.indexOf('export const retrieveUserMemories'));
        expect(remember).toContain('if (!(await isMemoryEnabled(userId))) return 0;');
        // A setting that can't be read counts as on ("handles the request as if memory were on").
        const enabled = memory.slice(memory.indexOf('export const isMemoryEnabled'), memory.indexOf('export const setMemoryEnabled'));
        expect(enabled).toMatch(/catch \(err\) \{\s*logger\.warn\('user_memory_prefs_read_failed'[^\n]*\n\s*return true;/);
        // Neither write path asks first, and POST /memory returns what the model wrote either way.
        const route = read('server/src/routes/chat.ts');
        const handler = route.slice(route.indexOf("chatRouter.post('/memory'"), route.indexOf("chatRouter.get('/memory/list'"));
        const auto = route.slice(route.indexOf('const maybeAutoRemember'), route.indexOf('const maybeAutoRemember') + 2500);
        for (const path of [handler, auto]) expect(path).not.toContain('isMemoryEnabled');
        expect(handler).toContain('res.json({ memory: updated || existing });');
        // Chat Studio puts that result into the in-app list without checking the setting...
        const chat = read('components/chat/AIChatPlatform.tsx');
        const update = chat.slice(chat.indexOf('const updateMemoryInBackground'), chat.indexOf('const updateMemoryInBackground') + 1200);
        expect(update).toMatch(/void updateChatMemory\(recent, current\)\s*\.then\(\(\{ memory: updated \}\) => \{\s*if \(updated && updated\.trim\(\) && updated\.trim\(\) !== current\.trim\(\)\) \{\s*setChatMemory\(updated, user\.id\);/);
        expect(update).not.toMatch(/enabled|isMemoryEnabled/);
        // ...a change to it schedules a sync, and the synced snapshot carries it to the account.
        expect(read('services/chatStorage.ts')).toMatch(/export const setChatMemory[\s\S]{0,400}notifyChatDataChanged\(\)/);
        expect(read('contexts/AuthContext.tsx')).toContain('setChatDataChangeListener(');
        expect(read('services/cloudSync.ts')).toMatch(/chat: \{\s*memory: getChatMemory\(userId\),/);
        // The in-app list is the browser's own and goes with every request.
        expect(chat).toContain('composeSystemPrompt(getChatMemory(');
        const policy = read('components/PrivacyPolicy.tsx');
        expect(policy).toContain('Once it is turned off, no notes are added to it, the notes in it are no longer sent with your requests, and your messages are no longer sent to Gemini to search them. If our server can\'t read that setting at the moment of a request (a temporary error), it handles the request as if memory were on. Turning it off doesn\'t stop the list in Settings → Memory in Chat Studio: Chat Studio still sends the latest messages to an AI model to write notes into that list, and the list is kept in your browser, synced to your account when you\'re signed in, and sent with your requests. After an answer, the latest messages are also still sent to an AI model to write notes for the memory on your account, but what it writes is not saved.');
        expect(policy).not.toContain('no notes are saved to your account or sent with your requests');
        expect(policy).not.toContain('their result is not saved');
        expect(policy).toContain('whichever provider you choose (unless memory is turned off for your account)');
    });

    it(`the quick-finder sends the selected text (first ${QUICK_FINDER.selectionChars} characters) to Chat Studio's backend on every page App shows but ${QUICK_FINDER.hiddenOn.join(', ')} (never in Stream Studio, a separate entry), so memory search, connected-account context and memory notes apply`, () => {
        const app = read('App.tsx');
        const show = /const showQuickFinder = ([^;]+);/.exec(app)?.[1] ?? '';
        expect([...show.matchAll(/effectiveView !== '([a-z-]+)'/g)].map((m) => m[1]).sort()).toEqual([...QUICK_FINDER.hiddenOn].sort());
        expect(show.replace(/effectiveView !== '[a-z-]+'/g, '').replace(/&&|\s/g, '')).toBe('');
        const finder = read('components/QuickFinder.tsx');
        expect(Number(/const Q = \(t: string\) => `[^`]*?\.slice\(0, (\d+)\)/.exec(finder)?.[1])).toBe(QUICK_FINDER.selectionChars);
        expect(finder).toMatch(/await sendChatMessageStream\(\s*\{ messages: \[\{ role: 'user', content: prompt \}\], \.\.\.\(clientContext \? \{ clientContext \} : \{\}\) \},/);
        expect(finder).not.toMatch(/\bsource:/);
        expect(read('services/chatApi.ts')).toContain("const res = await postStream('/api/chat/stream', req, { signal: handlers.signal });");
        // Every signed-in chat turn searches memory and adds connected-account context, and the
        // three turn handlers (/, /stream, /swarm) write memory notes after the answer.
        const route = read('server/src/routes/chat.ts');
        expect(route).toContain('userMemory: Boolean(p.userId),');
        expect(route).toContain('connectorContext: Boolean(p.userId),');
        expect(route.match(/maybeAutoRemember\(req, p, result\.text \|\| ''\);/g)).toHaveLength(3);
        // Only App mounts it: Stream Studio is its own entry (live.html → live/main.tsx → LiveApp), and
        // nothing under live/ imports QuickFinder or App.
        expect(read('vite.config.ts')).toMatch(/main: [^\n]*index\.html[\s\S]{0,200}live: [^\n]*live\.html/);
        expect(read('live.html')).toContain('/live/main.tsx');
        for (const f of sourceFiles('live', /\.tsx?$/)) expect(read(f), f).not.toMatch(/QuickFinder|from ['"](?:\.\.\/)+App['"]/);
        const policy = read('components/PrivacyPolicy.tsx');
        expect(policy).toContain('<li><strong>The quick-finder:</strong> when you select text on a page while signed in');
        expect(policy).toContain('It works on every page of the main site and the Comic Studio site except the sign-in pages and shared or public comic pages: in Comic Studio, Page Studio, Settings, the legal pages and Chat Studio too. It is not in Stream Studio.');
        expect(policy).not.toContain('It works on every page except');
        expect(policy).toContain('and so can the quick-finder (the Explain, Summarize and similar actions offered when you select text on a page');
        expect(policy).toContain('the text of each message you send in Chat Studio or through the quick-finder while signed in');
        expect(read('components/legal/SubprocessorsPage.tsx')).toContain('the text of each message you send in Chat Studio or through the quick-finder while signed in');
    });

    it(`memory notes are written two ways: after an answer through that turn's provider and key, and from Chat Studio through the app-wide pick; on OpenRouter by ${MEMORY_NOTE_MODEL.id}, or ${MEMORY_NOTE_MODEL.fallbackId} when it fails`, () => {
        const route = read('server/src/routes/chat.ts');
        // After an answer (at most every 5 minutes): the provider and key the turn used, which is the
        // chat's own source before the app-wide header.
        const auto = route.slice(route.indexOf('const maybeAutoRemember'), route.indexOf('const maybeAutoRemember') + 2500);
        expect(route).toContain('const AUTO_MEMORY_THROTTLE_MS = 5 * 60_000;');
        expect(auto).toContain('if (Date.now() - last < AUTO_MEMORY_THROTTLE_MS) return;');
        expect(auto).toContain("const model = p.resolved.provider === 'nvidia' ? NVIDIA_TEXT_MODEL : OPENROUTER_TEXT_MODEL;");
        expect(auto).toMatch(/runChat\(\{\s*provider: p\.resolved\.provider,\s*apiKey: p\.resolved\.apiKey,/);
        expect(auto).toContain("fallbackModel: p.resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,");
        expect(route).toContain('const resolved = resolveChatProvider(req, body.source);');
        expect(route).toContain("const source = String(requestedSource || req.header('X-Text-Source') || '').trim().toLowerCase();");
        // From Chat Studio: no source, so the app-wide pick (X-Text-Source) or the first key, OpenRouter.
        const api = read('services/chatApi.ts');
        const update = api.slice(api.indexOf('export const updateChatMemory'), api.indexOf('export const updateChatMemory') + 450);
        expect(update).toContain('{ messages, memory },');
        expect(update).not.toMatch(/\bsource\b/);
        const handler = route.slice(route.indexOf("chatRouter.post('/memory'"), route.indexOf("chatRouter.get('/memory/list'"));
        expect(handler).toContain("const model = resolved.provider === 'nvidia' ? NVIDIA_TEXT_MODEL : OPENROUTER_TEXT_MODEL;");
        expect(handler).toContain("fallbackModels: resolved.provider === 'openrouter' ? [OPENROUTER_TEXT_MODEL, TEXT_FALLBACK] : undefined,");
        expect(route).toMatch(/const AUTO_PROVIDER_ORDER: AIProviderId\[\] = \[\s*'openrouter',/);
        // The models the page names.
        expect(read('server/src/config.ts')).toContain(`export const OPENROUTER_TEXT_MODEL = process.env.OPENROUTER_TEXT_MODEL || '${MEMORY_NOTE_MODEL.id}';`);
        expect(read('server/src/ai/autoRouter.ts')).toContain(`export const TEXT_FALLBACK = '${MEMORY_NOTE_MODEL.fallbackId}';`);
        expect(read('api-proxy/wrangler.jsonc')).not.toContain('OPENROUTER_TEXT_MODEL');
        const policy = read('components/PrivacyPolicy.tsx');
        expect(policy).toContain("after an answer (at most once every five minutes), through the provider that answered it, with the same key, which can be your own; and from Chat Studio, through the provider you picked under Settings → API &amp; Models or, if you haven't picked one, OpenRouter.");
        expect(policy).toContain('Through OpenRouter the model is one DreamStream picks, today {MEMORY_NOTE_MODEL.label}, or {MEMORY_NOTE_MODEL.fallbackLabel} when that one is unavailable.');
        expect(policy).not.toContain('not by the chat');
        expect(read('components/legal/SubprocessorsPage.tsx')).toContain('today by ${MEMORY_NOTE_MODEL.label}, or ${MEMORY_NOTE_MODEL.fallbackLabel} when that one is unavailable.');
    });

    it(`importing memories from another AI tool sends pasted text (first ${MEMORY_IMPORT_MAX_CHARS} characters) or, from an export file, the user's own text from anywhere in it (up to ${MEMORY_IMPORT_MAX_CHARS}), with the in-app list through the app-wide pick, like the notes written from Chat Studio; the merged list replaces yours only when you accept it`, () => {
        expect(constValue('server/src/routes/chat.ts', 'MAX_IMPORT_CONTENT_CHARS')).toBe(MEMORY_IMPORT_MAX_CHARS);
        expect(constValue('services/memoryImport.ts', 'MAX_IMPORT_CHARS')).toBe(MEMORY_IMPORT_MAX_CHARS);
        const route = read('server/src/routes/chat.ts');
        const handler = route.slice(route.indexOf("chatRouter.post('/memory/import'"), route.indexOf('// Proactive follow-ups'));
        expect(handler).toContain("const content = typeof body.content === 'string' ? body.content.trim().slice(0, MAX_IMPORT_CONTENT_CHARS) : '';");
        expect(handler).toContain("const existing = typeof body.memory === 'string' ?");
        // No chat source: the app-wide pick (X-Text-Source) or the first key, as POST /memory.
        expect(handler).toContain('const resolved = resolveChatProvider(req);');
        expect(handler).toContain("const model = resolved.provider === 'nvidia' ? NVIDIA_TEXT_MODEL : OPENROUTER_TEXT_MODEL;");
        expect(handler).toContain("fallbackModels: resolved.provider === 'openrouter' ? [OPENROUTER_TEXT_MODEL, TEXT_FALLBACK] : undefined,");
        const api = read('services/chatApi.ts');
        const call = api.slice(api.indexOf('export const importChatMemory'), api.indexOf('export const importChatMemory') + 500);
        expect(call).toContain("'/api/chat/memory/import',");
        expect(call).toContain('{ source, content, memory },');
        const modal = read('components/chat/ChatSettingsModal.tsx');
        expect(modal).toContain('const content = prepareMemoryImportContent(importText);');
        expect(modal).toContain('const res = await importChatMemory(importSource, content, existing);');
        expect(modal).toContain('setPreview(merged);');
        expect(modal).toMatch(/const applyImport = \(\) => \{\s*if \(!preview\) return;\s*commit\(preview\);/);
        // What the browser sends: plain text cut at its first 24,000 characters; from an export (JSON),
        // the user's own text from anywhere in it (their messages in past conversations, memory and
        // instruction entries), never the assistant's replies, cut at 24,000.
        const filler = 'x'.repeat(40_000);
        expect(prepareMemoryImportContent(`${filler}tail`)).toBe(filler.slice(0, MEMORY_IMPORT_MAX_CHARS));
        const turn = (role: string, text: string) => ({ author: { role }, content: { parts: [text] } });
        const exportFile = JSON.stringify([
            { title: 'Old chat', mapping: { a: { message: turn('assistant', `ASSISTANT ${filler}`) } } },
            { title: 'Later chat', mapping: { b: { message: turn('user', 'I live in Lisbon and work as a nurse') }, c: { message: turn('assistant', 'Noted, nurse in Lisbon!') } } }
        ]);
        expect(exportFile.indexOf('I live in Lisbon')).toBeGreaterThan(MEMORY_IMPORT_MAX_CHARS);
        const sent = prepareMemoryImportContent(exportFile);
        expect(sent).toContain('I live in Lisbon and work as a nurse');
        expect(sent).not.toMatch(/ASSISTANT|Noted, nurse/);
        expect(prepareMemoryImportContent(JSON.stringify([{ author: { role: 'user' }, content: { parts: [filler] } }])).length).toBe(MEMORY_IMPORT_MAX_CHARS);
        const policy = read('components/PrivacyPolicy.tsx');
        expect(policy).toContain("You can also import memories from another AI tool (ChatGPT, Claude, Gemini or another) into that list. Your browser sends text you paste or a text file you upload as it is, up to its first {MEMORY_IMPORT_MAX_CHARS.toLocaleString('en-US')} characters; from a data-export file (such as ChatGPT's or Claude's conversations file) or other JSON, it sends the text you wrote, taken from anywhere in the file: your own messages in its past conversations and its memory and instruction entries, but not the assistant's replies, up to {MEMORY_IMPORT_MAX_CHARS.toLocaleString('en-US')} characters. That is sent with the list to an AI model, the same way as the notes written from Chat Studio, to merge the two, and the merged list replaces yours only if you accept it.");
        expect(policy).not.toContain('what you paste or upload (up to the first');
        expect(policy).toContain('memory notes (including memories you import from another AI tool)');
        expect(policy).toContain('and memories you import from another AI tool to merge them into your list');
    });

    it('free models: the site-wide assistant picks one first, and DreamStream\'s own picks lead with one; the page says free models may keep and learn from what they receive', () => {
        // The assistant: free-only on the platform key (or with Free-only on), free-first on the user's own key.
        expect(read('server/src/routes/assistant.ts')).toContain("const freeOnly = !hasByokForProvider(req, 'openrouter') || req.freeOnly === true;");
        expect(read('server/src/routes/assistant.ts')).toContain("effectiveModel = await pickTextModel(freeOnly ? { costPref: 'free-only', stageHint: 'assistant' } : { preferFree: true });");
        // DreamStream's own picks default to free-first.
        expect(read('server/src/ai/autoRouter.ts')).toContain("opts?.costPref ?? (opts?.preferFree === false ? 'cheap' : 'free');");
        expect(read('server/src/ai/autoRouter.ts')).toContain(" *  - 'free'      free-first; falls back to cheapest paid when no free model exists.");
        const policy = read('components/PrivacyPolicy.tsx');
        expect(policy).toContain('Free models in particular may keep what they receive and learn from it, that is, use it to train or improve their models. The site-wide assistant picks a free model first, and other features can use one when you pick it or when DreamStream picks the model for you.');
    });

    it('the Contact form in Settings sends the email address, message, phone (inside the message) and account to contact_messages, nothing deletes them, and the page discloses both', () => {
        const db = read('services/db.ts');
        const save = db.slice(db.indexOf('export const savePublicContactMessage'), db.indexOf('// --- COMMUNITY FEATURES'));
        expect(save).toMatch(/supabase\.from\('contact_messages'\)\.insert\(\{\s*user_id: user\.id,\s*email: normalizedEmail,\s*message: normalizedMessage\s*\}\)/);
        const settings = read('components/AccountSettings.tsx');
        const form = settings.slice(settings.indexOf('const ContactSection = () =>'), settings.indexOf('export const AccountSettings'));
        expect(form).toContain('const finalMessage = normalizedPhone ? `[Phone: ${normalizedPhone}]\\n\\n${normalizedMessage}` : normalizedMessage;');
        expect(form).toContain('const saved = await savePublicContactMessage(normalizedEmail, finalMessage);');
        // Nothing in the server, the client or the SQL deletes them (no table file, no purge).
        for (const f of [...sourceFiles('server/src'), ...sourceFiles('services')]) {
            expect(/from\(\s*'contact_messages'\s*\)[^;]*?\.delete\(/.test(read(f)), `${f} deletes contact_messages`).toBe(false);
        }
        for (const f of sourceFiles('server/sql', /\.sql$/)) expect(read(f).toLowerCase(), f).not.toMatch(/(delete\s+from|truncate(\s+table)?)\s+(public\.)?contact_messages\b/);
        const policy = read('components/PrivacyPolicy.tsx');
        expect(policy).toContain('The Contact form in Settings sends our database the email address you enter, your message, a phone number if you add one, and your account, so we can reply by email.');
        expect(policy).toContain("['Messages sent with the Contact form in Settings', 'Not deleted automatically today; email us to have yours deleted.']");
        // The form promises a reply by email, and no hours or reply time.
        expect(form).toContain("Thanks — we'll reply by email.");
        expect(form).not.toMatch(/representative|Business Hours|business days/);
    });

    it("in the classic editor and Page Studio an image step without references can fall back to Ideogram, which the server runs only on the user's own key or for an account with access; the page says so", () => {
        const ideogram = IMAGE_MODELS.filter((m) => (m.provider as string) === 'ideogram');
        expect(ideogram.length).toBeGreaterThan(0);
        expect(ideogram.every((m) => !m.supportsReferences)).toBe(true);
        const service = read('services/imageService.ts');
        expect(service).toMatch(/let fallbackOrder = IMAGE_MODELS\s*\.filter\(\(model\) => model\.id !== primaryModel\.id\);\s*if \(hasReferences \|\| requiresReferenceCapableModel\) \{\s*fallbackOrder = fallbackOrder\.filter\(\(model\) => model\.supportsReferences\);/);
        expect(service).toMatch(/if \(provider === "ideogram"\) \{[\s\S]{0,200}generateIdeogramImage\(/);
        const route = read('server/src/routes/image.ts');
        const gate = route.slice(route.indexOf('const assertIdeogramModelAllowed'), route.indexOf('const assertIdeogramModelAllowed') + 700);
        expect(gate).toContain("if (hasByokForProvider(req, 'ideogram')) return;");
        expect(gate).toContain('if (!pro) {');
        expect(read('components/PrivacyPolicy.tsx')).toContain('In the classic editor and Page Studio, which older projects open in, an image step that uses no reference images can also go to Ideogram: when the Gemini image models fail, or when settings saved earlier chose an Ideogram model, and only with your own Ideogram key or an account that has access to it.');
    });

    it('team-written announcements are service mail: no suppression check, no unsubscribe link, and the console sends them to any pasted address', () => {
        expect(read('shared/email/templates.ts')).toMatch(/\n\s*announcement: 'essential',/);
        const admin = read('server/src/routes/adminEmail.ts');
        const systemOnly = /const SYSTEM_ONLY = new Set<string>\(\[([\s\S]*?)\]\);/.exec(admin)?.[1] ?? '';
        expect(systemOnly).toContain("'newsletter-confirm'");
        expect(systemOnly).not.toContain("'announcement'");
        const mailer = read('server/src/services/mailer.ts');
        expect(mailer).toContain("if (kind === 'marketing' && (await isSuppressed(to))) {");
        expect(mailer).toContain("if (kind === 'marketing' && !unsubscribeUrl) {");
        const policy = read('components/PrivacyPolicy.tsx');
        expect(policy).toContain('service announcements our team writes and sends by hand');
        expect(policy).toContain('they have no unsubscribe link. An announcement can go to any address we have');
    });

    it('nothing deletes invitation sends or usage and cost records (their retention rows say so)', () => {
        const TABLES = ['access_invite_sends', 'token_ledger_entries', 'generation_cost_events', 'provider_usage_log'];
        for (const f of sourceFiles('server/src')) {
            const code = read(f);
            for (const t of TABLES) expect(new RegExp(`from\\(\\s*'${t}'\\s*\\)[^;]*?\\.delete\\(`).test(code), `${f} deletes ${t}`).toBe(false);
        }
        for (const f of sourceFiles('server/sql', /\.sql$/)) {
            const sql = read(f).toLowerCase();
            for (const t of TABLES) expect(sql, `${f} deletes ${t}`).not.toMatch(new RegExp(`(delete\\s+from|truncate(\\s+table)?)\\s+(public\\.)?${t}\\b`));
        }
        expect(read('server/src/services/invites.ts')).toMatch(/from\('access_invite_sends'\)[\s\S]*?\.insert\(\{/);
        const policy = read('components/PrivacyPolicy.tsx');
        expect(policy).toContain("['Invitations you send (the invitee\\'s address, who invited them and how many times)', 'Not deleted automatically today; email us to have one removed.']");
        expect(policy).toContain("['Usage and cost records', 'Not deleted automatically today.']");
    });

    it('billing is off in production', () => {
        expect(BILLING_LIVE).toBe(false);
        expect(read('api-proxy/wrangler.jsonc')).toMatch(/"BILLING_ENABLED":\s*"false"/);
    });

    it('the email open-tracking image is on by default, and off for auth mail and the updates confirmation email', () => {
        const mailer = read('server/src/services/mailer.ts');
        expect(mailer).toMatch(/params\.pixelUrl = `\$\{EMAIL_PUBLIC_BASE_URL\}\/api\/email\/o\/\$\{logId\}\.gif`/);
        expect(mailer).toMatch(/if \(opts\.track === false\) \{\s*delete params\.pixelUrl;/);
        expect(read('server/src/routes/authEmail.ts')).toMatch(/track: false/);
        // The double opt-in email (POST /api/interest and /api/newsletter/subscribe both send it).
        expect(mailer).toMatch(/sendEmail\(\{ to: email, template: 'newsletter-confirm', [^\n]*track: false/);
        // Every other convenience sender keeps the image (the page says only those emails go without).
        const untracked = [...mailer.matchAll(/template: '([a-z-]+)'[^\n]*track: false/g)].map((m) => m[1]);
        expect(untracked).toEqual(['newsletter-confirm']);
    });

    it('interest registrations keep at most a 1,000-character note (the studio list itself is not pinned: the page says "the studios or features you pick")', () => {
        const store = read('server/src/services/emailStore.ts');
        expect(store).toContain('intent.feedback.trim().slice(0, 1000)');
        expect(store).toMatch(/export const WAITLIST_PRODUCTS = /);
        expect(read('server/src/services/interestStore.ts')).toContain("feedback.trim().slice(0, 1000)");
    });

    it('register interest is the updates double opt-in: a kind "updates" row and a confirmation link, no receipt and no account or invitation check', () => {
        const route = read('server/src/routes/interest.ts');
        expect(route).toContain('registerInterest({ email, studios, source })');
        expect(route).toContain('sendNewsletterConfirm(email, confirmUrl');
        expect(route).not.toMatch(/sendAccessRequested|accountExistsForEmail|resendPendingInvite/);
        expect(read('server/src/services/interestStore.ts')).toMatch(/\.insert\(\{\s*email,\s*kind: 'updates',/);
        // The receipt and the account/invitation check belong to early access (kind 'access') only.
        const newsletter = read('server/src/routes/newsletter.ts');
        const access = newsletter.slice(newsletter.indexOf("if (kind === 'access') {"), newsletter.indexOf('// Newsletter double opt-in'));
        for (const call of ['accountExistsForEmail(email)', 'resendPendingInvite(email', 'sendAccessRequested(email']) expect(access).toContain(call);
    });

    it('what a registration stores: picks, source, note, confirmed flag, timestamps and a signed one-time code; no IP, device or account ID', () => {
        const store = read('server/src/services/interestStore.ts');
        const insert = /await db\.from\(TABLE\)\.insert\(\{([\s\S]*?)\}\);/.exec(store)?.[1] ?? '';
        const keys = [...insert.matchAll(/^\s*(?:\.\.\.\(feedback \? \{ (feedback) \}|([a-z_]+)(?=[:,\n]))/gm)].map((m) => m[1] ?? m[2]);
        expect(keys.sort()).toEqual(['confirm_sent_at', 'confirm_token', 'confirmed', 'email', 'feedback', 'kind', 'metadata', 'product_interests', 'source']);
        // created_at (when you first registered) is the column default; confirmed_at is stamped on the click.
        expect(read('server/sql/waitlist_signups.sql')).toContain('created_at timestamptz not null default now()');
        const email = read('server/src/services/emailStore.ts');
        expect(email).toContain('if (!wasSubscribed) fields.confirmed_at = new Date().toISOString();');
        // The code is signed and single-use: confirming clears it.
        expect(read('server/src/services/confirmToken.ts')).toContain("crypto.createHmac('sha256', EMAIL_HMAC_SECRET)");
        expect(email).toContain('const fields: Record<string, unknown> = { confirmed: true, confirm_token: null, unsubscribed_at: null };');
        // A subscriber's new picks wait in metadata until their click.
        expect(email).toContain("export const PENDING_INTERESTS_KEY = 'pending_interests';");
        expect(store).toMatch(/if \(row\.confirmed && !row\.unsubscribed_at\) \{[\s\S]*?\[PENDING_INTERESTS_KEY\]: next/);
        // Neither server writer of these rows (registerInterest, and upsertSubscriber for early
        // access) stores the IP, the user agent or the account; the table has no such column.
        const upsert = email.slice(email.indexOf('export const upsertSubscriber'), email.indexOf('// ── Confirming'));
        for (const [name, code] of [['interestStore.ts', store], ['upsertSubscriber', upsert]] as const) {
            expect(code, name).not.toMatch(/\b(ip|ip_address|user_agent|userAgent|user_id|userId|device)\b\s*:/);
        }
        expect(read('server/sql/waitlist_signups.sql')).not.toMatch(/\b(ip|ip_address|user_agent|user_id)\b/);
        expect(read('services/waitlist.ts')).toMatch(/\.insert\(\{\s*email,\s*kind,\s*source: [^\n]+\n\s*metadata: \{ \.\.\.metadata, \.\.\.cleanIntent \}\s*\}\)/);
    });

    it('unsubscribing clears an updates row\'s picks, note and code (early access only gets the time); confirming again lifts the marketing suppression', () => {
        const email = read('server/src/services/emailStore.ts');
        const unsub = email.slice(email.indexOf('export const markUnsubscribed'));
        expect(unsub).toContain("await suppress(normalized, 'user_unsubscribe', 'marketing');");
        expect(unsub).toMatch(/\.update\(\{ unsubscribed_at: new Date\(\)\.toISOString\(\) \}\)\s*\.eq\('email', normalized\);/);
        expect(unsub).toMatch(/\.update\(\{ product_interests: \[\], feedback: null, confirm_token: null \}\)\s*\.eq\('email', normalized\)\s*\.eq\('kind', 'updates'\);/);
        expect(unsub).toContain('delete metadata[PENDING_INTERESTS_KEY];');
        expect(email).toContain(".from('email_suppressions').delete().eq('email', normalized).eq('scope', 'marketing');");
    });

    it('delivery records: address, email, status and error, time, provider message ID, request ID and the related account', () => {
        const log = read('server/src/services/emailStore.ts');
        const insert = /\.from\('email_log'\)\s*\.insert\(\{([\s\S]*?)\}\)/.exec(log)?.[1] ?? '';
        for (const col of ['to_email', 'template', 'kind', 'status', 'message_id', 'error', 'user_id', 'request_id']) expect(insert).toContain(`${col}:`);
        expect(read('server/sql/email_system.sql')).toMatch(/create table if not exists public\.email_log[\s\S]*?opened_at[\s\S]*?created_at timestamptz not null default now\(\)/);
        // The app's own register-interest and early-access requests carry no session (only a
        // content-type header), so optionalAuth never sets req.user and their records name no
        // account: the page claims none for them.
        for (const f of ['services/interest.ts', 'services/waitlist.ts']) {
            const client = read(f);
            expect(client, f).toContain("headers: { 'content-type': 'application/json' },");
            expect(client, f).not.toMatch(/authorization|getSession|access_token/i);
        }
        // An invitation's record carries the inviter; a team send, the admin who sent it.
        expect(read('server/src/routes/invites.ts')).toContain('{ userId: req.user.id, requestId: req.requestId }');
        expect(read('server/src/services/invites.ts')).toContain('{ userId: pending.sentBy, requestId: meta?.requestId ?? null }');
        expect(read('server/src/routes/adminEmail.ts')).toContain('userId: req.user?.id ?? null');
    });

    it('no sender reads the Settings email preferences, so the page offers only the unsubscribe link', () => {
        // authEmail.ts only copies the sign-up choices into the profile; assistantPolicy.ts only
        // keeps them out of the assistant's context. Nothing that sends mail reads them.
        const readers = [...sourceFiles('server/src'), ...sourceFiles('email-worker/src'), ...sourceFiles('api-proxy/src')].filter((f) => /email_pref|marketing_consent/.test(read(f)));
        expect(readers.sort()).toEqual(['server/src/ai/assistantPolicy.ts', 'server/src/routes/authEmail.ts']);
        // Marketing mail is held back only by the suppression list, and no SQL copies a preference into it.
        expect(read('server/src/services/mailer.ts')).toContain("if (kind === 'marketing' && (await isSuppressed(to))) {");
        for (const f of sourceFiles('server/sql', /\.sql$/)) {
            const sql = read(f);
            expect(/email_pref|marketing_consent/.test(sql) && /email_suppressions/.test(sql), f).toBe(false);
        }
        const policy = read('components/PrivacyPolicy.tsx');
        expect(policy).not.toContain('change your email preferences in Settings');
        expect(policy).toContain("The email preferences in Settings are saved with your account, but they don't yet change which emails we send.");
    });

    it('early access: the backend sends a receipt and checks accounts, invitations and earlier requests, and tells the visitor; when it doesn\'t answer normally the browser saves the request itself', () => {
        const newsletter = read('server/src/routes/newsletter.ts');
        const access = newsletter.slice(newsletter.indexOf("if (kind === 'access') {"), newsletter.indexOf('// Newsletter double opt-in'));
        for (const answer of ["status: 'account-exists'", "status: 'already-invited'", "status: 'already-registered'", 'void sendAccessRequested(email']) {
            expect(access).toContain(answer);
        }
        // The account check is exact (no pattern): an escaped ILIKE, or eq for an address with '*'.
        expect(newsletter).toContain("const exact = email.includes('*') ? query.eq('email', email) : query.ilike('email', escapeLike(email));");
        const client = read('services/waitlist.ts');
        expect(client).toMatch(/const apiResult = await subscribeViaApi\([^)]*\);\s*if \(apiResult\) return apiResult;\s*\/\/ Fallback: write directly to Supabase/);
        // A 429 from the per-IP limiter or a 5xx has no ok/message body: that falls back too.
        expect(client).toMatch(/if \(httpStatus === 400 && data\?\.message\) return \{ ok: false, message: data\.message \};\s*return null;/);
        expect(read('server/src/index.ts')).toContain("app.use('/api/newsletter/subscribe', interestRateLimit);");
        // ...while a 400 (a bad address, a failed bot check) is shown, never saved: so the page
        // names only an unreachable, failing or busy server.
        expect(read('components/PrivacyPolicy.tsx')).toContain("If our server can't be reached, has an error or is too busy (for example while it starts up, or after many requests from one network), your browser saves the request directly instead, without that email or check.");
    });

    it('the Unsubscribe link in an email only opens a page (scanners fetch links); its button or the One-Click POST unsubscribes', () => {
        const newsletter = read('server/src/routes/newsletter.ts');
        const get = newsletter.slice(newsletter.indexOf("newsletterRouter.get('/unsubscribe'"), newsletter.indexOf("newsletterRouter.post('/unsubscribe'"));
        expect(get).toContain('return sendUnsubscribePage(res, email, token);');
        expect(get).not.toContain('markUnsubscribed');
        expect(newsletter.slice(newsletter.indexOf("newsletterRouter.post('/unsubscribe'"))).toContain('await markUnsubscribed(email);');
        expect(read('email-worker/src/index.ts')).toContain("headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';");
        // So the pages promise an unsubscribe link (a page with a button) and one click only in
        // email apps with their own button, never a "one-click unsubscribe link".
        const policy = read('components/PrivacyPolicy.tsx');
        expect(policy).toContain("Every update includes an unsubscribe link, which opens a page with an Unsubscribe button (so a mail scanner that opens links can't unsubscribe you by mistake); email apps with their own Unsubscribe button do it in one click.");
        for (const f of ['components/PrivacyPolicy.tsx', 'components/WaitlistForm.tsx', 'server/src/routes/newsletter.ts']) {
            expect(read(f), f).not.toMatch(/one-click unsubscribe(?! *POST)/i);
        }
        expect(read('components/WaitlistForm.tsx')).toContain('Every update has an unsubscribe link');
    });

    it('the register-interest form and its API send people to routed mailboxes', () => {
        expect(read('server/src/routes/interest.ts')).toContain(`export const INTEREST_SUPPORT_EMAIL = '${SUPPORT_EMAIL}';`);
        const form = read('components/WaitlistForm.tsx');
        expect(form).toContain("import { PRIVACY_EMAIL, SUPPORT_EMAIL } from './legal/legalFacts';");
        expect(form).not.toContain('contact@');
    });

    it('Stream Studio takes its mailboxes from contacts.ts, never legalFacts.ts (whose third-party links would land in its bundle and its CSP check)', () => {
        const live = sourceFiles('live', /\.tsx?$/);
        expect(live.filter((f) => /components\/legal\/legalFacts/.test(read(f)))).toEqual([]);
        expect(live.filter((f) => /components\/legal\/contacts/.test(read(f))).sort()).toEqual(['live/components/Guide.tsx', 'live/ui/legalLinks.tsx']);
        expect(read('components/legal/contacts.ts')).not.toMatch(/^import /m);
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

    it('the site-wide assistant runs on the pages the policy names and saves frustrated messages as feedback and as a diagnostics event', () => {
        const chrome = read('services/assistantChrome.ts');
        expect(chrome).toContain("const NOT_MOUNTED = new Set(['auth-callback', 'shared', 'chat', 'comicstudio', 'publiccomic']);");
        // The classic editor and Page Studio (older projects) have it; the reader keeps it mounted with its button hidden.
        for (const view of ['home', 'dashboard', 'privacy', 'settings', 'editor', 'pagestudio']) expect(assistantChrome(view).mounted, view).toBe(true);
        expect(assistantChrome('reader')).toEqual({ mounted: true, hideLauncher: true });
        const assistant = read('components/UniversalAssistant.tsx');
        expect(assistant).toMatch(/const sentiment = detectSentiment\(message\);[\s\S]*?submitFeedback\(\{[\s\S]*?comment: message/);
        expect(assistant).toMatch(/const sentiment = detectSentiment\(message\);\s*if \(sentiment\) \{\s*captureEvent\(\{\s*eventType: 'assistant_user_sentiment',[\s\S]*?\bmessage,/);
        expect(read('server/src/services/telemetryStore.ts')).toMatch(/message: str\(typeof e\.message === 'string'/);
        expect(assistant).toMatch(/maskedEmail: maskEmail\(/);
        expect(assistant).toContain('projectSnapshot: activeProject ? buildProjectSnapshot(activeProject) : undefined');
        expect(read('server/src/routes/assistant.ts')).toContain('The assistant runs on a free OpenRouter model.');
    });

    it('what the assistant gets about the open project: overview, script start and prompts; the server drops the per-item samples', () => {
        const project = {
            id: 'p1',
            name: 'NAME-MARK',
            updatedAt: 1,
            state: {
                step: 2,
                overview: 'OVERVIEW-MARK',
                script: `SCRIPT-MARK ${'x'.repeat(2000)}`,
                stylePrompt: 'STYLE-MARK',
                customLayoutPrompt: 'LAYOUT-MARK',
                coverPrompt: 'COVER-MARK',
                generationStatus: { isActive: true, progress: 40, currentStepDescription: 'STEP-MARK' },
                scenes: [{ id: 's1', synopsis: 'SYNOPSIS-MARK', setting: 'SETTING-MARK', characters: ['CAST-MARK'] }],
                panels: [{ id: 'pa', sceneId: 's1', description: 'PANEL-MARK', dialogue: 'DIALOGUE-MARK' }],
                characters: [{ id: 'c1', name: 'CHARNAME-MARK', description: 'CHARDESC-MARK' }],
                items: [{ id: 'i1', name: 'ITEMNAME-MARK', description: 'ITEMDESC-MARK' }],
                locations: [{ id: 'l1', name: 'LOCNAME-MARK', description: 'LOCDESC-MARK' }],
                comments: [{ id: 'k1', author: 'AUTHOR-MARK', text: 'COMMENT-MARK', likes: 1, dislikes: 0, createdAt: 1 }],
                styleVariants: []
            }
        } as unknown as Parameters<typeof buildProjectSnapshot>[0];
        const built = JSON.stringify(buildProjectSnapshot(project));
        // The client builds samples of scenes, panels, cast and comments…
        for (const mark of ['SYNOPSIS-MARK', 'DIALOGUE-MARK', 'CHARDESC-MARK', 'AUTHOR-MARK', 'COMMENT-MARK']) expect(built).toContain(mark);
        // …and the server's sanitizer (what the model sees) keeps only the top of the snapshot.
        const sent = sanitizeAssistantContext({ view: 'editor', projectSnapshot: buildProjectSnapshot(project) }, { isAuthenticated: true }).projectSnapshot as Record<string, unknown>;
        const json = JSON.stringify(sent);
        for (const mark of ['NAME-MARK', 'OVERVIEW-MARK', 'SCRIPT-MARK', 'STYLE-MARK', 'LAYOUT-MARK', 'COVER-MARK', 'STEP-MARK']) expect(json, mark).toContain(mark);
        for (const mark of ['SYNOPSIS-MARK', 'SETTING-MARK', 'CAST-MARK', 'PANEL-MARK', 'DIALOGUE-MARK', 'CHARNAME-MARK', 'CHARDESC-MARK', 'ITEMDESC-MARK', 'LOCDESC-MARK', 'AUTHOR-MARK', 'COMMENT-MARK']) {
            expect(json, mark).not.toContain(mark);
        }
        expect(String(sent.scriptPreview)).toHaveLength(ASSISTANT_SCRIPT_PREVIEW_CHARS);
    });

    it('the approximate location goes into the model prompt, and its lookup is plain HTTP', () => {
        expect(read('server/src/ai/chat.ts')).toContain('- Approximate user location: ');
        expect(read('server/src/ai/clientGeo.ts')).toContain('`http://ip-api.com/json/');
    });

    it('place searches near you send your location (Foursquare or OpenStreetMap), news gets your country, and the public refresh does the same', () => {
        const registry = read('server/src/ai/tools/registry.ts');
        expect(registry).toMatch(/const userLocation =\s*ctx\?\.location && typeof ctx\.location\.lat === 'number' && typeof ctx\.location\.lng === 'number'/);
        expect(registry).toMatch(/findPlacesFoursquare\(\s*\{ query, near: near \|\| undefined, userLocation,/);
        expect(registry).toMatch(/findPlaces\(\{ query, near: near \|\| undefined, userLocation \}/);
        expect(read('server/src/ai/tools/foursquare.ts')).toContain("params.set('ll', `${args.userLocation.lat},${args.userLocation.lng}`)");
        expect(read('server/src/ai/tools/places.ts')).toContain("anchor = { lat: args.userLocation.lat, lng: args.userLocation.lng, label: 'your location' }");
        expect(registry).toContain('const region = ctx?.location?.country ||');
        const chat = read('server/src/routes/chat.ts');
        expect(chat).toMatch(/chatPublicRouter\.post\('\/tool-refresh'[\s\S]*?resolveClientGeo\(clientIpFromReq\(req\)\)[\s\S]*?location: clientContext\?\.location/);
    });

    it('the page reader also fetches plain-HTTP websites', () => {
        expect(read('server/src/ai/tools/readArticle.ts')).toContain("if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;");
    });

    it('MCP servers (with any access token) stay in local storage and go with each chat request that turns them on', () => {
        const mcp = read('services/mcpServers.ts');
        expect(mcp).toContain("const STORAGE = 'dreamstream_mcp_servers';");
        expect(mcp).toContain('{ headers: { Authorization: input.authorization.trim() } }');
        expect(read('components/chat/AIChatPlatform.tsx')).toContain('mcpServers: getMcpServersByIds(session.mcpServers || [])');
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
    // Our own domains only. Supabase (supabase.co) is another company that browsers reach directly,
    // so it is in BROWSER_THIRD_PARTIES and checked like every other host.
    const OURS = /(^|\.)(dreamstreamstudio\.ai|dreamstream\.app|workers\.dev)$|^(example\.com|server\.example\.com|docs\.example\.com|cdn\.test)$/;
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

    it('Supabase, which every browser reaches directly (sign-in, data, images, the shared-comic reader), is named', () => {
        expect(read('functions/_middleware.ts')).toContain("export const SUPABASE_ORIGIN = 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co';");
        const csp = read('functions/_shared/csp.ts');
        expect(csp).toContain('`img-src \'self\' data: blob: ${supabaseOrigin}`');
        expect(csp).toMatch(/`connect-src 'self' \$\{supabaseOrigin\} \$\{supabaseWs\}/);
        expect(undocumented(['bdjfmxfmhqhzvgrhbbzm.supabase.co'])).toEqual([]);
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
