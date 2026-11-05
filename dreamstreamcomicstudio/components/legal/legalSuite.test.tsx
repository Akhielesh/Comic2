import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrivacyPolicy } from '../PrivacyPolicy';
import { TermsOfService } from '../TermsOfService';
import { LegalMicroLinks } from '../layout/LegalMicroLinks';
import { LIVE_LEGAL_LINKS } from '../../live/ui/legalLinks';
import { AcceptableUsePolicy } from './AcceptableUsePolicy';
import { CookiesNotice, DOCUMENTED_STORAGE_KEYS } from './CookiesNotice';
import { CopyrightPolicy } from './CopyrightPolicy';
import { AI_PROVIDERS, BROWSER_SERVICES, CORE, NOT_IN_USE, OTHER_SERVICES, SubprocessorsPage, TOOL_SERVICES } from './SubprocessorsPage';
import {
    ASSISTANT_SCRIPT_PREVIEW_CHARS,
    BROWSER_THIRD_PARTIES,
    CONFIRM_EMAIL_LIMITS,
    CONFIRM_LINK_DAYS,
    DIRECT_AI_PROVIDERS,
    EVENT_ROOM_KEPT,
    GOOGLE_PRIVACY_POLICY_URL,
    GOOGLE_SECURITY_PERMISSIONS_URL,
    LEGAL_LAST_UPDATED,
    MIN_SIGNUP_AGE_YEARS,
    PRIVACY_EMAIL,
    RETENTION,
    SUPPORT_EMAIL,
    YOUTUBE_TERMS_URL
} from './legalFacts';
import { LEGAL_DOCS, isLegalDocId, legalDocForPath, legalPath, type LegalDocId } from './legalRoutes';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const textOf = (el: Element): string => (el.textContent || '').replace(/\s+/g, ' ').trim();

type PageProps = { onBack: () => void; onOpenDoc?: (id: LegalDocId) => void };
const PAGES: Record<LegalDocId, React.FC<PageProps>> = {
    terms: TermsOfService,
    privacy: PrivacyPolicy,
    'acceptable-use': AcceptableUsePolicy,
    copyright: CopyrightPolicy,
    cookies: CookiesNotice,
    subprocessors: SubprocessorsPage
};

const renderDoc = (id: LegalDocId, onOpenDoc = vi.fn()) => {
    const Page = PAGES[id];
    const utils = render(<Page onBack={vi.fn()} onOpenDoc={onOpenDoc} />);
    return { ...utils, main: utils.container.querySelector('main') as HTMLElement, onOpenDoc };
};

afterEach(() => {
    window.location.hash = '';
    window.history.replaceState({}, '', '/');
});

describe('legal suite: every document renders as a complete page', () => {
    for (const doc of LEGAL_DOCS) {
        it(`${doc.path}: title, date, legal navigation and a table of contents that resolves`, () => {
            const { main } = renderDoc(doc.id);
            expect(within(main).getByRole('heading', { level: 1, name: doc.title })).toBeInTheDocument();
            expect(within(main).getByText(LEGAL_LAST_UPDATED.label, { selector: 'time' })).toHaveAttribute('dateTime', LEGAL_LAST_UPDATED.iso);
            expect(document.title).toBe(`${doc.title} · DreamStream Studio`);

            const nav = within(main).getByRole('navigation', { name: 'Legal documents' });
            const links = within(nav).getAllByRole('link');
            expect(links.map((a) => a.getAttribute('href'))).toEqual(LEGAL_DOCS.map((d) => d.path));
            expect(within(nav).getByRole('link', { current: 'page' })).toHaveAttribute('href', doc.path);

            const toc = within(main).getByRole('navigation', { name: 'On this page' });
            const anchors = within(toc).getAllByRole('link').map((a) => a.getAttribute('href') as string);
            expect(anchors.length).toBeGreaterThanOrEqual(5);
            expect(new Set(anchors).size).toBe(anchors.length);
            for (const href of anchors) {
                const section = main.querySelector(href);
                expect(section?.tagName).toBe('SECTION');
                expect(section?.getAttribute('aria-labelledby')).toBe(`${href.slice(1)}-title`);
            }
        });

        it(`${doc.path}: no placeholders, no foreign domains, only our own mailboxes`, () => {
            const { main } = renderDoc(doc.id);
            const text = textOf(main);
            expect(text).not.toMatch(/\[[A-Z][A-Z0-9 _-]*\]/); // [COMPANY], [ADDRESS], [DATE]…
            expect(text).not.toMatch(/\b(TODO|TBD|FIXME|lorem ipsum|XXX)\b/i);
            expect(text).not.toMatch(/<your|your company|insert /i);
            expect(text).not.toMatch(/@dreamstream\.com/);
            expect(text).not.toMatch(/DreamStream Inc|Terms (&|and) Conditions/);
            expect(text).not.toMatch(/no provider (ever )?trains|never (sent|go) to free models/i);
            for (const a of main.querySelectorAll('a[href^="mailto:"]')) {
                const address = (a.getAttribute('href') as string).slice('mailto:'.length).split('?')[0];
                expect([SUPPORT_EMAIL, PRIVACY_EMAIL]).toContain(address);
            }
            for (const a of main.querySelectorAll('a[href^="http"]')) {
                expect(a).toHaveAttribute('target', '_blank');
                expect(a.getAttribute('rel')).toContain('noopener');
            }
        });
    }

    it('cross-links open the other document in the app on a plain click, and follow the link otherwise', () => {
        // jsdom can't follow a real navigation: swallow the ones the page lets through.
        const swallow = (e: MouseEvent) => e.preventDefault();
        document.addEventListener('click', swallow);
        const { main, onOpenDoc } = renderDoc('terms');
        const aup = within(main).getAllByRole('link', { name: 'Acceptable Use Policy' })[0];
        expect(aup).toHaveAttribute('href', '/acceptable-use');
        fireEvent.click(aup);
        expect(onOpenDoc).toHaveBeenCalledWith('acceptable-use');

        onOpenDoc.mockClear();
        fireEvent.click(aup, { metaKey: true });
        expect(onOpenDoc).not.toHaveBeenCalled();

        // A link to a section of another page is a real load, so the browser lands on the anchor.
        onOpenDoc.mockClear();
        const privacy = renderDoc('privacy', onOpenDoc).main;
        const youtubeTerms = privacy.querySelector('#google-user-data a[href="/terms#youtube"]') as HTMLAnchorElement;
        expect(youtubeTerms).toHaveTextContent('Terms of Service');
        fireEvent.click(youtubeTerms);
        expect(onOpenDoc).not.toHaveBeenCalled();
        document.removeEventListener('click', swallow);
    });

    it('drops the old #fragment when it opens another document, so the next one starts at the top', () => {
        window.location.hash = '#contact';
        const { main, onOpenDoc } = renderDoc('terms');
        fireEvent.click(within(within(main).getByRole('navigation', { name: 'Legal documents' })).getByRole('link', { name: 'Cookies' }));
        expect(onOpenDoc).toHaveBeenCalledWith('cookies');
        expect(window.location.hash).toBe('');
    });

    it('lands on a #fragment once mounted, and survives a mangled one', () => {
        const scroll = vi.fn();
        Element.prototype.scrollIntoView = scroll;
        window.location.hash = '#repeat-infringers';
        renderDoc('copyright');
        expect(scroll).toHaveBeenCalledTimes(1);
        expect(scroll.mock.contexts[0]).toHaveProperty('id', 'repeat-infringers');

        window.location.hash = '#%E0%A4';
        expect(() => renderDoc('cookies')).not.toThrow();
    });

    it('uses theme tokens only, so every page reads in light and dark', () => {
        for (const file of ['components/legal/LegalDocument.tsx', 'components/legal/AcceptableUsePolicy.tsx', 'components/legal/CopyrightPolicy.tsx', 'components/legal/CookiesNotice.tsx', 'components/legal/SubprocessorsPage.tsx', 'components/TermsOfService.tsx', 'components/PrivacyPolicy.tsx']) {
            const src = read(file);
            expect(src, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
            expect(src, file).not.toMatch(/\b(?:bg|text|border)-(?:white|black|slate-\d+|gray-\d+)\b/);
            expect(src, file).not.toMatch(/\b(?:font-display|font-comic|shadow-comic|border-2)\b/);
        }
    });
});

describe('Terms of Service', () => {
    it('binds YouTube users to the YouTube Terms of Service and links Google\'s policy and revocation page', () => {
        const { main } = renderDoc('terms');
        const youtube = main.querySelector('#youtube')?.parentElement as HTMLElement;
        expect(textOf(youtube)).toContain('DreamStream uses YouTube API Services. If you connect your YouTube account, you agree to be bound by the YouTube Terms of Service.');
        expect(within(main).getByRole('link', { name: 'YouTube Terms of Service' })).toHaveAttribute('href', YOUTUBE_TERMS_URL);
        expect(within(youtube).getByRole('link', { name: 'Google Privacy Policy' })).toHaveAttribute('href', GOOGLE_PRIVACY_POLICY_URL);
        expect(within(youtube).getByRole('link', { name: 'Google security settings' })).toHaveAttribute('href', GOOGLE_SECURITY_PERMISSIONS_URL);
    });

    it('states the real age rule, the AI notice, recording consent, the monitor\'s limits and that nothing is charged', () => {
        const text = textOf(renderDoc('terms').main);
        expect(text).toContain(`only accepts people who are at least ${MIN_SIGNUP_AGE_YEARS} years old`);
        expect(text).toContain('When you talk to them you are interacting with an AI, not a person.');
        expect(text).toContain('DreamStream does not currently add a visible label or machine-readable marking');
        expect(text).toContain('Stream Studio does not show viewers or guests that you are recording.');
        expect(text).toContain('It does not monitor breathing, heart rate, temperature, oxygen or sleep position');
        expect(text).toContain('Paid billing is switched off: DreamStream does not take payments');
        expect(text).toMatch(/subscriptions, paid plans, credit packs, or overage billing are not active unless/);
        expect(text).toContain(`Replays of a live stream are kept for about ${RETENTION.replayHours} hours`);
        expect(text).toMatch(/Private studio, guest, admin, or recap links are bearer capability links/);
        expect(text).toContain('we end the accounts of people who repeatedly infringe');
        // Owner decisions stay neutral: no governing-law clause, no claim of output ownership.
        expect(text).not.toMatch(/governed by the laws of|exclusive jurisdiction|you own all outputs/i);
    });

    it('sends contacts to email, not to a screen Stream Studio users never see', () => {
        const contact = renderDoc('terms').main.querySelector('#contact') as HTMLElement;
        expect(within(contact).getByRole('link', { name: SUPPORT_EMAIL })).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}`);
        expect(textOf(contact)).not.toMatch(/Account Settings/);
    });
});

describe('Privacy Policy', () => {
    it('lists what sign-up really collects, including phone and date of birth', () => {
        const account = textOf(renderDoc('privacy').main.querySelector('#information-we-collect') as HTMLElement);
        expect(account).toContain('phone number (optional), date of birth (required)');
        expect(account).toContain('we store a yes/no, not which version or when');
        expect(account).toContain('Pwned Passwords');
    });

    it('covers the baby monitor, tracker, calls, people search and alerts', () => {
        const stream = textOf(renderDoc('privacy').main.querySelector('#stream-studio') as HTMLElement);
        expect(stream).toContain('Live video and sound are never recorded.');
        expect(stream).toContain('in memory only and never stored');
        expect(stream).toContain('the audio and frames they analyse never leave it');
        expect(stream).toMatch(/breastfeeding \(side and minutes\).*medicine, temperature/);
        expect(stream).toContain('There is no setting to hide from this search today.');
        expect(stream).toContain('push subscription');
    });

    it('discloses email open tracking and how interest registrations are kept', () => {
        const emails = textOf(renderDoc('privacy').main.querySelector('#emails') as HTMLElement);
        expect(emails).toContain('contain a tiny image that tells us when the email is first opened');
        expect(emails).toContain('double opt-in');
        // The studio list lives in the code (and changes): the page doesn't pin one.
        expect(emails).toContain('the studios or features you pick');
        expect(emails).not.toMatch(/Code Studio|Dashboards/);
        expect(emails).toContain('for every email our backend sends');
        expect(emails).toContain('up to 1,000 characters');
        expect(emails).toContain('suppression list');
    });

    it('describes register interest as the updates double opt-in, with everything it stores (legalFacts.test.ts ties each part to the code)', () => {
        const section = renderDoc('privacy').main.querySelector('#emails') as HTMLElement;
        const items = [...section.querySelectorAll('li')].map(textOf);
        const item = (label: string) => items.find((t) => t.startsWith(label)) ?? '';
        const interest = item('Updates and interest registrations (double opt-in):');
        expect(interest).toContain('if you sign up for updates or register interest in a studio');
        expect(interest).toContain('We then email you a confirmation link, and nothing else until you press Confirm.');
        // A repeat registration (anyone can type the address) re-sends it, within the throttle...
        expect(interest).toContain(
            `If the address is registered again, by you or by anyone who types it in, we send the confirmation email again, at most once every ${CONFIRM_EMAIL_LIMITS.minIntervalMinutes} minutes and ${CONFIRM_EMAIL_LIMITS.maxPerDay} times in any 24 hours.`
        );
        // ...with the same link, whose lifetime runs from the first send.
        expect(interest).toContain(`A link stops working ${CONFIRM_LINK_DAYS} days after we first sent it, even when a later email carries it again.`);
        expect(interest).not.toMatch(/send one email|stops working after/);
        expect(interest).toContain('whether you have confirmed; when you first registered, when we last sent you a confirmation email and when you confirmed');
        expect(interest).toContain('the signed one-time code in your link, which we delete when you confirm or unsubscribe');
        expect(interest).toContain('the new picks are kept apart and only added when you press Confirm');
        expect(interest).toContain('The registration itself stores no IP address, device details or account ID.');
        // The receipt and the account/invitation check are early access only.
        expect(interest).not.toMatch(/confirm we received it|pending invitation/);
        const access = item('Early access requests:');
        expect(access).toContain('When our server handles the request, it first checks whether your address already has an account, a pending invitation or an earlier request');
        expect(access).toContain('otherwise it emails you to confirm we received it');
        // services/waitlist.ts falls back to a direct insert when the backend doesn't answer normally.
        expect(access).toContain('your browser saves the request directly instead, without that email or check');
        const unsub = item('Unsubscribing');
        expect(unsub).toContain('your studio picks (including any still waiting for your confirmation), your note and any unused confirmation link');
        expect(unsub).toContain('an early-access request keeps its details, with the unsubscribe time added');
        expect(unsub).toContain('unless you sign up and confirm again');
        const delivery = item('Delivery records:');
        for (const part of ['why, with any error message', 'the message ID our email provider gives it', 'an ID for the request that caused it', 'yours when the email is about your account', "the sender's for an invitation"]) {
            expect(delivery).toContain(part);
        }
        // The app's register-interest and early-access requests carry no session, so their
        // records never name an account (legalFacts.test.ts checks the two clients).
        expect(delivery).not.toMatch(/signed in when you asked|registering interest while signed in/);
        expect(item('Open tracking:')).toContain('password-reset emails and the email that asks you to confirm updates or an interest registration never contain it');
        // Nothing reads the Settings email preferences when sending (legalFacts.test.ts), so the
        // page offers only the unsubscribe link, and says so.
        const after = textOf(section.querySelector('p') as HTMLElement);
        expect(after).toContain('To stop marketing emails, use the unsubscribe link in any of them.');
        expect(after).toContain("The email preferences in Settings are saved with your account, but they don't yet change which emails we send.");
        expect(textOf(renderDoc('privacy').main)).not.toMatch(/change your email preferences|email preferences in Settings, and/);
    });

    it('early-access requests have a retention row and a legal basis, and the early-access answers are disclosed', () => {
        const { main } = renderDoc('privacy');
        const retention = textOf(main.querySelector('#retention') as HTMLElement);
        expect(retention).toContain('Early-access requests');
        expect(retention).toContain('Until you ask us to delete them. Unsubscribing adds the time you unsubscribed and keeps the request.');
        expect(textOf(main.querySelector('#legal-bases') as HTMLElement)).toContain(
            'steps you ask for before you have an account: an early-access request, its receipt email and the check for an existing account or invitation'
        );
        const visible = textOf(main.querySelector('#public') as HTMLElement);
        expect(visible).toContain(
            'anyone who enters your email address in the early-access form is told whether it already has a DreamStream account or a pending invitation, or is already on the early-access list'
        );
        expect(visible).toContain('The form for updates and interest registrations gives the same answer for every address.');
    });

    it('carries the retention numbers the code enforces, and says plainly what is not deleted automatically', () => {
        const retention = textOf(renderDoc('privacy').main.querySelector('#retention') as HTMLElement);
        for (const fragment of [
            `About ${RETENTION.replayHours} hours`,
            `About ${RETENTION.cloudCopyDays} days`,
            `Alerts, events and incidents ${RETENTION.monitorEventsDays} days`,
            `minute-by-minute summaries ${RETENTION.monitorMinutesDays} days`,
            `sleep sessions ${RETENTION.monitorSleepDays} days`,
            `About ${RETENTION.trackerYears} years`,
            `Check records ${RETENTION.safetyEventsDays} days`,
            'Not deleted automatically today',
            `Until you ask us to delete them. A confirmation link stops working ${CONFIRM_LINK_DAYS} days after we first sent it.`
        ]) {
            expect(retention).toContain(fragment);
        }
        expect(retention).toContain('Its stored history and tracker entries are not erased automatically');
    });

    it('states rights honestly: by email, handled by hand, legal timelines', () => {
        const rights = textOf(renderDoc('privacy').main.querySelector('#your-rights') as HTMLElement);
        expect(rights).toContain('There is no self-service download or account deletion in the app yet');
        expect(rights).toContain('one month under the GDPR and 45 days under the California Consumer Privacy Act');
    });

    it('describes children truthfully (8+ at sign-up, no parental-consent process)', () => {
        const children = textOf(renderDoc('privacy').main.querySelector('#children') as HTMLElement);
        expect(children).toContain(`accepts people aged ${MIN_SIGNUP_AGE_YEARS} and over`);
        expect(children).toContain('We do not run a separate process to get a parent\'s consent');
        expect(children).not.toMatch(/not intended for children|COPPA[- ]compliant|we comply with COPPA/i);
    });

    it('never claims certifications or provider promises it can\'t back', () => {
        const text = textOf(renderDoc('privacy').main);
        expect(text).not.toMatch(/GDPR[- ]compliant|HIPAA|SOC 2|ISO 27001|Privacy Shield|Data Privacy Framework|certified/i);
        expect(text).toContain('DreamStream does not use your content to train AI models of its own.');
        expect(text).toContain('We do not sell personal information');
    });
});

describe('Acceptable Use and Copyright', () => {
    it('AUP: zero tolerance for child sexual content, and enforcement described as it works', () => {
        const text = textOf(renderDoc('acceptable-use').main);
        expect(text).toContain('Never create, request, upload, share or link to sexual content involving anyone under 18');
        expect(text).toContain('Live video, calls and baby-monitor video are never screened.');
        expect(text).toContain('Automated checks can miss things or flag things by mistake.');
    });

    it('Copyright: notice and counter-notice elements, repeat infringers, and no claim of a registered agent', () => {
        const { main } = renderDoc('copyright');
        const text = textOf(main);
        expect(text).toContain('17 U.S.C. § 512(c)(3)');
        expect(text).toContain('17 U.S.C. § 512(g)(3)');
        expect(text).toContain('10 to 14 business days');
        expect(text).toContain('repeat infringers');
        expect(text).not.toMatch(/designated agent|registered with the (US |U\.S\. )?Copyright Office/i);
        expect(within(main).getAllByRole('link', { name: SUPPORT_EMAIL })[0]).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}?subject=Copyright%20notice`);
    });
});

describe('Cookies & Local Storage', () => {
    const CLIENT = ['components', 'services', 'hooks', 'live', 'contexts', 'lib'];
    const sources = (dir: string): string[] =>
        readdirSync(path.join(ROOT, dir)).flatMap((name) => {
            const rel = path.join(dir, name);
            if (statSync(path.join(ROOT, rel)).isDirectory()) return rel.startsWith(path.join('components', 'legal')) ? [] : sources(rel);
            return /\.(tsx?|js)$/.test(name) && !/\.test\./.test(name) ? [rel] : [];
        });
    const code = [...CLIENT.flatMap(sources), 'App.tsx'].map(read).join('\n');

    it('every storage key the notice names is one the apps really use', () => {
        for (const key of DOCUMENTED_STORAGE_KEYS) expect(code, key).toMatch(new RegExp(`['"\`]${key.replace(/[.]/g, '\\.')}['"\`]`));
        expect(read('public/live-sw.js').length).toBeGreaterThan(0);
    });

    it('names the third parties the pages load', () => {
        const text = textOf(renderDoc('cookies').main);
        for (const host of ['challenges.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com']) expect(text).toContain(host);
        expect(text).toContain("Our own code doesn't set cookies.");
    });

    it('names the register-interest session key, and the confirmation email among those without the tracking image', () => {
        const { main } = renderDoc('cookies');
        expect(textOf(main.querySelector('#what-we-store') as HTMLElement)).toContain('ds.interest.unavailable');
        expect(textOf(main.querySelector('#emails') as HTMLElement)).toContain('the email that asks you to confirm updates or an interest registration never do');
    });
});

describe('Subprocessors', () => {
    it('names the infrastructure, every AI provider, and what is set up but unused', () => {
        const names = [...CORE, ...AI_PROVIDERS, ...TOOL_SERVICES, ...BROWSER_SERVICES, ...OTHER_SERVICES, ...NOT_IN_USE].map((s) => s.name).join(' | ');
        for (const p of ['Cloudflare', 'Supabase', 'OpenRouter', 'Google (Gemini API)', 'Ideogram', 'Pixazo', 'Jina Reader', 'ip-api.com', 'Pwned Passwords', 'Google APIs', 'Stripe', 'Railway']) {
            expect(names).toContain(p);
        }
        for (const p of DIRECT_AI_PROVIDERS.filter((p) => p !== 'Google (Gemini)')) expect(names).toContain(p);
        const text = textOf(renderDoc('subprocessors').main);
        expect(text).toContain('Nothing today: billing is switched off.');
        expect(text).toContain('United States (US West, Oregon)');
    });
});

describe('what the browser loads, the assistant, keys and other disclosures', () => {
    it('Cookies and Subprocessors both list every service the browser loads, and no longer say tools are server-only', () => {
        const cookies = textOf(renderDoc('cookies').main.querySelector('#third-parties') as HTMLElement);
        const subs = renderDoc('subprocessors').main;
        const browser = textOf(subs.querySelector('#loaded-by-your-browser') as HTMLElement);
        for (const p of BROWSER_THIRD_PARTIES) {
            expect(cookies).toContain(p.name);
            expect(browser).toContain(p.name);
            for (const h of p.hosts.filter((h) => h !== '*')) expect(cookies).toContain(h);
        }
        for (const h of ['basemaps.cartocdn.com', 'api.qrserver.com', 'cdn.jsdelivr.net', '*.codesandbox.io', 'stun.l.google.com']) expect(browser).toContain(h);
        expect(textOf(subs)).not.toMatch(/made by our server, not your browser/);
        const tools = textOf(subs.querySelector('#chat-tools') as HTMLElement);
        expect(tools).toContain('loaded by your browser instead');
        expect(tools).not.toMatch(/contain only what the AI writes/);
        expect(tools).toContain('plus your location (approximate, or precise if you shared it) when you search for places near you, and your country and language for news');
        expect(textOf(subs.querySelector('#ai-models') as HTMLElement)).toContain(`the first ${ASSISTANT_SCRIPT_PREVIEW_CHARS} characters of its script`);
        for (const n of ['agify', 'Amadeus', 'Finnhub', 'FRED', 'similar public sources']) expect(textOf(subs)).toContain(n);
    });

    it('Privacy: API keys, the assistant, usage events, location, images, emails, events and sign-in records', () => {
        const text = textOf(renderDoc('privacy').main);
        expect(text).toContain('it is stored with your account, encrypted with AES-256-GCM, so it works on all your devices');
        expect(text).toContain('The site-wide assistant:');
        expect(text).toContain('that message is also saved automatically, as feedback and in our diagnostics log');
        expect(text).toContain('the classic editor and Page Studio that older projects open in');
        expect(text).toContain('It is not in Chat Studio, the current Comic Studio or shared comic pages, and its button is hidden in the comic reader.');
        expect(text).toContain(`that project's story overview, the first ${ASSISTANT_SCRIPT_PREVIEW_CHARS} characters of its script, its style, layout and cover prompts`);
        expect(text).toContain('sent to the place-search services (Foursquare or OpenStreetMap) when you ask for places near you');
        expect(text).toContain('websites the AI reads that are only available over plain HTTP');
        expect(text).toContain('never the text of your message or the answer');
        expect(text).toContain('That location, with your timezone and language, is included in each request to the AI model');
        expect(text).toContain('plain HTTP');
        expect(text).toContain('anyone who has one of those addresses can open that image without signing in, even if the project is private');
        expect(text).toContain('someone who knows your username can find out the email address that goes with it');
        expect(text).not.toMatch(/Email addresses are never shown|Every table in our database|weekly summaries/);
        expect(text).toContain(`the last ${EVENT_ROOM_KEPT.chatMessages} messages`);
        expect(text).toContain('there is no way to delete an event in the app today');
        expect(text).toContain('also records the IP address and browser of each sign-in session');
        expect(text).toContain('in-app notifications');
        expect(text).toContain(`about ${RETENTION.trackerDeletedDays} days later`);
        expect(text).toContain('STUN servers run by Cloudflare and Google');
        expect(text).not.toMatch(/(?<!third-party )(advertising|ad) or analytics trackers/);
    });

    it('Terms: the assistant is in the AI notice, the training heading is narrow, invitations are described as they work', () => {
        const text = textOf(renderDoc('terms').main);
        expect(text).toContain('the site-wide assistant on our pages');
        expect(text).toContain("We don't train our own AI models on your content.");
        expect(text).not.toMatch(/We don't train on your content\./);
        expect(text).toContain("The main site's sign-up form opens only with an invitation");
    });

    it('Cookies: keys stored with the account survive clearing site data; no blanket "no tracking pixels" claim', () => {
        const text = textOf(renderDoc('cookies').main);
        expect(text).toContain('API keys you added while signed in stay stored with your account');
        expect(text).toContain('the address and any access token of MCP servers you add');
        expect(text).not.toMatch(/tracking pixels in our apps/);
    });

    it('AUP names the automatic pause Comic Studio applies', () => {
        expect(textOf(renderDoc('acceptable-use').main)).toContain('repeated blocked requests pause generation for 15 minutes, or for 24 hours');
    });

    it('tables label every cell for phones, where the header row is hidden', () => {
        const retention = renderDoc('privacy').main.querySelector('#retention table') as HTMLTableElement;
        expect(retention.querySelector('thead')?.className).toMatch(/^hidden\b.*\bsm:table-header-group\b/);
        const firstValue = retention.querySelector('tbody tr td') as HTMLElement;
        expect(firstValue.querySelector('span')).toHaveTextContent('How long');
        expect(firstValue.querySelector('span')?.className).toContain('sm:hidden');
    });
});

describe('Back and Forward between documents opened in the app', () => {
    it('a cross-link and the legal navigation each add a history entry, so Back has somewhere to go', () => {
        const swallow = (e: MouseEvent) => e.preventDefault();
        document.addEventListener('click', swallow);
        window.history.replaceState({}, '', '/terms');
        const before = window.history.length;
        const { main, onOpenDoc } = renderDoc('terms');
        fireEvent.click(within(main).getAllByRole('link', { name: 'Acceptable Use Policy' })[0]);
        expect(onOpenDoc).toHaveBeenCalledWith('acceptable-use');
        expect(window.location.pathname).toBe('/acceptable-use');
        expect(window.history.length).toBe(before + 1);
        fireEvent.click(within(within(main).getByRole('navigation', { name: 'Legal documents' })).getByRole('link', { name: 'Cookies' }));
        expect(window.location.pathname).toBe('/cookies');
        expect(window.history.length).toBe(before + 2);
        document.removeEventListener('click', swallow);
    });

    it('popstate to another document opens it, to a non-legal path goes Back, and a #section move is left alone', () => {
        const onBack = vi.fn();
        const onOpenDoc = vi.fn();
        window.history.replaceState({}, '', '/privacy');
        render(<PrivacyPolicy onBack={onBack} onOpenDoc={onOpenDoc} />);

        window.history.replaceState({}, '', '/privacy#retention');
        window.dispatchEvent(new PopStateEvent('popstate'));
        expect(onOpenDoc).not.toHaveBeenCalled();
        expect(onBack).not.toHaveBeenCalled();

        window.history.replaceState({}, '', '/terms');
        window.dispatchEvent(new PopStateEvent('popstate'));
        expect(onOpenDoc).toHaveBeenCalledWith('terms');

        window.history.replaceState({}, '', '/');
        window.dispatchEvent(new PopStateEvent('popstate'));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('Back to another view and then Forward reopens the document (the address and the view stay in step)', async () => {
        // App in miniature: one view, the shared footer, the legal page, and App's address sync (replaceState).
        const Shell: React.FC = () => {
            const [view, setView] = React.useState<string>('home');
            React.useEffect(() => {
                window.history.replaceState({}, '', isLegalDocId(view) ? legalPath(view) : '/');
            }, [view]);
            if (view === 'privacy') return <PrivacyPolicy onBack={() => setView('home')} onOpenDoc={setView} />;
            return (
                <div>
                    <p>Home view</p>
                    <LegalMicroLinks onOpenPrivacy={() => setView('privacy')} onOpenTerms={() => setView('terms')} onOpenLegal={setView} onOpenFaq={vi.fn()} />
                </div>
            );
        };
        const swallow = (e: MouseEvent) => e.preventDefault();
        document.addEventListener('click', swallow);
        window.history.replaceState({}, '', '/');
        render(<Shell />);
        fireEvent.click(screen.getByRole('link', { name: 'Privacy Policy' }));
        document.removeEventListener('click', swallow);
        expect(screen.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeInTheDocument();
        expect(window.location.pathname).toBe('/privacy');

        window.history.back();
        await waitFor(() => expect(screen.getByText('Home view')).toBeInTheDocument());
        expect(window.location.pathname).toBe('/');

        window.history.forward();
        await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeInTheDocument());
        expect(window.location.pathname).toBe('/privacy');
    });

    it('the shared footer adds a history entry too', () => {
        const swallow = (e: MouseEvent) => e.preventDefault();
        document.addEventListener('click', swallow);
        const before = window.history.length;
        render(<LegalMicroLinks onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} onOpenLegal={vi.fn()} />);
        fireEvent.click(screen.getByRole('link', { name: 'Terms of Service' }));
        expect(window.location.pathname).toBe('/terms');
        expect(window.history.length).toBe(before + 1);
        document.removeEventListener('click', swallow);
    });
});

describe('footers and other entry points reach the documents', () => {
    it('the shared footer links every document by its real path, under one name', () => {
        const onOpenPrivacy = vi.fn();
        const onOpenTerms = vi.fn();
        const onOpenLegal = vi.fn();
        render(<LegalMicroLinks onOpenPrivacy={onOpenPrivacy} onOpenTerms={onOpenTerms} onOpenFaq={vi.fn()} onOpenLegal={onOpenLegal} />);
        for (const doc of LEGAL_DOCS) expect(screen.getByRole('link', { name: doc.label })).toHaveAttribute('href', doc.path);
        expect(screen.queryByText(/Terms (&|and) Conditions/)).toBeNull();
        fireEvent.click(screen.getByRole('link', { name: 'Privacy Policy' }));
        fireEvent.click(screen.getByRole('link', { name: 'Terms of Service' }));
        fireEvent.click(screen.getByRole('link', { name: 'Cookies' }));
        expect(onOpenPrivacy).toHaveBeenCalledTimes(1);
        expect(onOpenTerms).toHaveBeenCalledTimes(1);
        expect(onOpenLegal).toHaveBeenCalledWith('cookies');
    });

    it('Stream Studio\'s legal links and sign-up sheet resolve to the documents', () => {
        for (const link of LIVE_LEGAL_LINKS.filter((l) => !l.href.startsWith('mailto:'))) {
            expect(legalDocForPath(new URL(link.href, 'https://dreamstreamstudio.ai').pathname)).not.toBeNull();
        }
        const sheet = read('live/components/AuthSheet.tsx');
        expect(sheet).toContain("mainAppUrl(legalPath('terms'))");
        expect(sheet).toContain("mainAppUrl(legalPath('privacy'))");
        expect(sheet).toContain('>Terms of Service</a>');
    });

    it('support links go to the routed support mailbox, not the unrouted contact@', () => {
        for (const f of ['components/layout/LegalMicroLinks.tsx', 'components/ComicReader.tsx', 'live/ui/legalLinks.tsx', 'live/components/Guide.tsx', 'components/WaitlistForm.tsx', 'server/src/routes/interest.ts']) expect(read(f), f).not.toContain('contact@');
        expect(LIVE_LEGAL_LINKS.find((l) => l.label === 'Support')?.href).toBe(`mailto:${SUPPORT_EMAIL}?subject=Stream%20Studio%20support`);
        for (const id of ['acceptable-use', 'copyright'] as const) {
            expect(LIVE_LEGAL_LINKS.some((l) => legalDocForPath(new URL(l.href, 'https://dreamstreamstudio.ai').pathname) === id)).toBe(true);
        }
    });

    it('Settings → Legal links to the documents instead of carrying an old copy', () => {
        const settings = read('components/AccountSettings.tsx');
        expect(settings).not.toMatch(/Feb 11, 2026|Stripe for subscriptions|Token-based limits apply/);
        expect(settings).toContain('LEGAL_DOCS.map((doc)');
        // In a new tab: an in-app move would put Back on the document's own target (Dashboard or
        // Home) instead of Settings, since App doesn't restore a view from a popped address yet.
        expect(settings).toContain('<a href={doc.path} target="_blank" rel="noopener noreferrer"');
    });

    it('the sign-up consent checkbox calls them the Terms of Service', () => {
        const auth = read('components/AuthPage.tsx');
        expect(auth).not.toMatch(/Terms (&|and) Conditions/);
        expect(auth).toContain('>Terms of Service</button>');
    });

    it('the wrong live statements are gone', () => {
        const guide = read('live/components/Guide.tsx');
        expect(guide).not.toContain('We never ask for your Google password or permissions');
        expect(guide).toContain('This way needs no Google sign-in and no Google permissions.');
        const auth = read('components/AuthPage.tsx');
        expect(auth).not.toContain('DreamStream Inc');
        expect(auth).toContain('&copy; 2026 DreamStream Studio. All rights reserved.');
    });
});
