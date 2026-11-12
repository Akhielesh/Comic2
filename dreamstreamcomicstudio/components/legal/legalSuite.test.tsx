import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import type { LegalPageProps } from './LegalDocument';
import {
    LEGAL_DOCS,
    isLegalDocId,
    isOnLegalPage,
    keepLegalEntryMark,
    legalBackGoesBack,
    legalDocForPath,
    legalEntryState,
    legalPath,
    pushLegalPath,
    syncLegalPath,
    viewForHistoryEntry,
    type LegalDocId
} from './legalRoutes';
import { resetBackStack, useBackLayer } from '../comicstudio/mobile/backStack';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const textOf = (el: Element): string => (el.textContent || '').replace(/\s+/g, ' ').trim();

const PAGES: Record<LegalDocId, React.FC<LegalPageProps>> = {
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

        // A link to a section of another page opens it in the app too, on its own marked entry that
        // names the section (the page lands on it once mounted), so its Back button returns here.
        onOpenDoc.mockClear();
        window.history.replaceState(legalEntryState(), '', '/privacy');
        const before = window.history.length;
        const privacy = renderDoc('privacy', onOpenDoc).main;
        const youtubeTerms = privacy.querySelector('#google-user-data a[href="/terms#youtube"]') as HTMLAnchorElement;
        expect(youtubeTerms).toHaveTextContent('Terms of Service');
        fireEvent.click(youtubeTerms, { ctrlKey: true });
        expect(onOpenDoc).not.toHaveBeenCalled();
        fireEvent.click(youtubeTerms);
        expect(onOpenDoc).toHaveBeenCalledWith('terms');
        expect(`${window.location.pathname}${window.location.hash}`).toBe('/terms#youtube');
        expect(window.history.length).toBe(before + 1);
        expect(window.history.state).toEqual(legalEntryState());
        document.removeEventListener('click', swallow);
    });

    it('a jump to a section of the page shown (the table of contents, a link in the text) stays on the same history entry and keeps its mark', () => {
        const scroll = vi.fn();
        Element.prototype.scrollIntoView = scroll;
        for (const [id, pick] of [
            ['privacy', (main: HTMLElement) => within(within(main).getByRole('navigation', { name: 'On this page' })).getAllByRole('link')[0]],
            ['acceptable-use', (main: HTMLElement) => main.querySelector('a[href="#enforcement"]') as HTMLAnchorElement],
            ['terms', (main: HTMLElement) => within(within(main).getByRole('navigation', { name: 'On this page' })).getAllByRole('link').at(-1) as HTMLElement]
        ] as const) {
            window.history.replaceState(legalEntryState(), '', legalPath(id));
            const before = window.history.length;
            const { main, unmount } = renderDoc(id);
            const link = pick(main);
            const section = (link.getAttribute('href') as string).slice(1);
            scroll.mockClear();
            fireEvent.click(link);
            expect(`${window.location.pathname}${window.location.hash}`, id).toBe(`${legalPath(id)}#${section}`);
            expect(window.history.length, id).toBe(before);
            expect(window.history.state, id).toEqual(legalEntryState());
            expect(scroll.mock.contexts[0], id).toHaveProperty('id', section);
            expect(document.activeElement, id).toHaveProperty('id', section);
            unmount();
        }
        // A modified click is the browser's (a new tab, a copied link).
        window.history.replaceState(legalEntryState(), '', '/privacy');
        const { main } = renderDoc('privacy');
        const first = within(within(main).getByRole('navigation', { name: 'On this page' })).getAllByRole('link')[0];
        const swallow = (e: MouseEvent) => e.preventDefault();
        document.addEventListener('click', swallow);
        fireEvent.click(first, { metaKey: true });
        document.removeEventListener('click', swallow);
        expect(window.location.hash).toBe('');
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
        // "No updates", not "nothing else": a service announcement can reach any address we hold.
        expect(interest).toContain("We then email you a confirmation link (none while our record of the emails we send can't be read; registering again once it can sends it), and no updates until you press Confirm (service announcements, above, can still reach the address).");
        expect(interest).not.toContain('nothing else until you press Confirm');
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
        expect(access).toContain('otherwise it usually emails you to confirm we received it');
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

    it('the "Your work" row names the reading place the comic reader keeps for every comic read on the device', () => {
        const row = [...renderDoc('cookies').main.querySelectorAll('tr')].find((tr) => tr.textContent?.includes('dreamstream_local_cache'));
        expect(row?.textContent).toContain("and where you were in each comic you've read here (page, reading mode, scroll position and when you last read it), kept in IndexedDB and local storage.");
        // The reader saves exactly that, per comic, into the reader_state store of dreamstream_local_cache:
        // every save (a page turn, a mode change, a scroll, the close) stamps updatedAt with the time.
        expect(read('services/db.ts')).toContain('const DB_NAME = "dreamstream_local_cache";');
        expect(read('services/db.ts')).toContain('const READER_STATE_STORE = "reader_state";');
        expect(read('types.ts')).toMatch(/export type ReaderState = \{\s*projectId: string;\s*mode: "scroll" \| "flip";\s*pageIndex\?: number;\s*scrollTop\?: number;\s*updatedAt: number;\s*\};/);
        expect(read('components/ComicReader.tsx')).toContain('void saveReaderState({ projectId, mode, pageIndex: page, scrollTop:');
        expect(read('components/ComicReader.tsx').match(/updatedAt: Date\.now\(\)/g)).toHaveLength(2);
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

    it('the Privacy Policy\'s own list of what the browser loads names every one of those services, Supabase included', () => {
        // How each BROWSER_THIRD_PARTIES entry reads in the Privacy Policy's prose (a new entry must be added here and there).
        const WORDS: Record<string, string> = {
            Supabase: 'Supabase, our database and sign-in provider',
            'Cloudflare Turnstile': 'Cloudflare Turnstile',
            'Google Fonts': 'Google Fonts',
            'cdnjs (Cloudflare)': "Cloudflare's cdnjs",
            jsDelivr: 'the Python runtime (jsDelivr)',
            'CodeSandbox (Sandpack)': 'code previews (CodeSandbox)',
            CARTO: 'map tiles (CARTO)',
            RainViewer: 'weather radar (RainViewer)',
            'Google (site icons)': 'site icons (Google)',
            'Parqet, Financial Modeling Prep': 'market logos (Parqet, Financial Modeling Prep)',
            'goQR (api.qrserver.com)': 'QR codes (goQR)',
            'YouTube, Vimeo': 'videos (YouTube, Vimeo)',
            'Google Drive': 'Google Drive uploads',
            'STUN servers (Cloudflare, Google)': 'STUN servers (Cloudflare, Google)',
            'Images in answers': 'images from the websites they come from'
        };
        const prose = textOf(renderDoc('privacy').main.querySelector('#cookies') as HTMLElement);
        for (const p of BROWSER_THIRD_PARTIES) {
            expect(WORDS[p.name], `add "${p.name}" to WORDS`).toBeDefined();
            expect(prose).toContain(WORDS[p.name]);
        }
        expect(BROWSER_THIRD_PARTIES.find((p) => p.name === 'Supabase')?.hosts).toEqual(['*.supabase.co']);
        expect(CORE.find((c) => c.name === 'Supabase')?.data).toContain('the IP address and browser details of every request your browser makes to it');
    });

    it('Privacy and Subprocessors: memory search and memory notes, NVIDIA in Comic Studio, announcements, sign-out and the new retention rows', () => {
        const privacyMain = renderDoc('privacy').main;
        const privacy = textOf(privacyMain);
        expect(privacy).toContain("the text of each message you send in Chat Studio or through the quick-finder while signed in (up to the first 8,000 characters) is also sent to Google's Gemini API before the answer is written, whichever model or provider you chose, even when you have no saved notes.");
        expect(privacy).toContain("Through OpenRouter the model is one DreamStream picks, today Google's Gemini 2.5 Flash, or OpenAI's GPT-4o mini when that one is unavailable.");
        expect(privacy).toContain('after an answer (at most once every five minutes), through the provider that answered it, with the same key');
        expect(privacy).toContain("each message you send is also sent to Google's Gemini API to search your memory notes, whichever provider you choose (unless memory is turned off for your account)");
        expect(privacy).toContain("Google's Gemini API, NVIDIA, or a model reached through OpenRouter");
        expect(privacy).toContain('service announcements our team writes and sends by hand');
        // Sign-out and unsaved recordings: who is offered one, including ones no account made, and
        // what another account at the device can see and do (live/recorder.unit.test.ts checks it).
        // One an earlier version made carries no account, and none is guessed from who holds the device
        // (recorder.ts ownerOf): offered to anyone while that version's list names it, as it was, and to no
        // one (UNKNOWN_OWNER, only counted) once that version had stopped listing it.
        expect(privacy).toContain("Recordings you made but haven't saved stay on the device until you save or delete them, with a note of the account each was made for. Each is offered only to the account its studio was opened for; one made while no one was signed in is offered to anyone who opens Stream Studio on that device. An earlier version of Stream Studio kept no such note, so a recording made with it, also in a tab still running it, belongs to no account: one this version finds on that version's list is offered to anyone who opens Stream Studio on that device, as that version offered it, and one that version had already stopped listing is offered to no one. So is any other recording whose account can't be told. Someone signed in there with another account sees only how many of your unsaved recordings there are and how much space they use, and can delete them; anyone there sees the same for recordings offered to no one.");
        for (const page of ['components/PrivacyPolicy.tsx', 'components/legal/CookiesNotice.tsx']) expect(read(page), page).not.toContain('when this version first ran there');
        for (const page of ['components/PrivacyPolicy.tsx', 'components/legal/CookiesNotice.tsx']) expect(read(page), page).not.toContain('first ran there or, if there was none, is offered to anyone');
        for (const page of ['components/PrivacyPolicy.tsx', 'components/legal/CookiesNotice.tsx']) expect(read(page), page).not.toContain('goes to the account signed in there when this version first ran');
        expect(privacy).not.toContain('only the account that made them is offered them');
        expect(privacy).not.toContain('the Stream Studio data on that device is removed');
        const retention = textOf(privacyMain.querySelector('#retention') as HTMLElement);
        expect(retention).toContain("Invitations you send (the invitee's address, who invited them and how many times)");
        expect(retention).toContain('Usage and cost records');
        const subs = renderDoc('subprocessors').main;
        const gemini = AI_PROVIDERS.find((p) => p.name === 'Google (Gemini API)')!;
        expect(gemini.data).toContain('the text of each message you send in Chat Studio or through the quick-finder while signed in (to search your memory notes, unless memory is turned off for your account), whichever model answers it');
        expect(AI_PROVIDERS.find((p) => p.name === 'OpenRouter')!.purpose).toContain("Chat Studio's memory notes are written through it whenever the chat, or your pick under Settings → API & Models, uses OpenRouter");
        expect(AI_PROVIDERS.find((p) => p.name === 'Ideogram, Pixazo (Flux)')!.purpose).toContain('In the classic editor and Page Studio, Ideogram also when the Gemini image models fail');
        expect(textOf(subs.querySelector('#ai-models') as HTMLElement)).toContain("NVIDIA also does Comic Studio's writing steps");
        const cookiesMain = renderDoc('cookies').main;
        const cookies = textOf(cookiesMain.querySelector('#your-choices') as HTMLElement);
        expect(cookies).not.toContain("removes Stream Studio's personal data from that device");
        expect(cookies).toContain("An earlier version of Stream Studio kept no such note, so a recording made with it, also in a tab still running it, belongs to no account: one this version finds on that version's list is offered to anyone who opens Stream Studio on that device, as that version offered it, and one that version had already stopped listing is offered to no one.");
        expect(cookies).toContain('anyone there sees the same for recordings offered to no one.');
        // What sign-out removes and, in the same words as the code's purge list, what stays (live/accountPurge.unit.test.ts).
        // Guest passes from share links go with the account (accountPurge PREFIXES), and the list of what
        // stays no longer claims to be three things: device settings stay too.
        expect(cookies).toContain("nursery data, guest passes from a nursery's share link, call settings, the names of people you called and the name you used as a viewer) and ends its alert subscription.");
        // A signed-out guest's pass: every way it goes (leave, the room's refusal at its next connection, Stream
        // Studio opening 90 days past its end: LiveApp.gateGuestPass.unit.test.tsx; and any sign-out or account
        // switch on that device, or a member opening it: live/accountPurge.unit.test.ts).
        expect(cookies).toContain('A guest who joined with a share link while no one was signed in keeps their pass on that device until they leave, the nursery turns it down when that device next connects to it (a parent ended it or removed them), or Stream Studio opens on that device once 90 days have passed since its end, unless someone signs out of Stream Studio or DreamStream on that device, the device switches to another account, or a member of that nursery opens it there signed in: then it goes too. These stay after a sign-out.');
        expect(cookies).not.toContain('keeps their pass on that device until it ends or a parent ends it');
        expect(cookies).not.toContain('or 90 days after its end, unless');
        expect(read('live/LiveApp.tsx')).toMatch(/void sweepDiscardedRecordings\(\);\s*sweepExpiredGuestPasses\(\);\s*\}, \[\]\);/);
        expect(cookies).not.toContain('Three things stay');
        expect(cookies).toContain("This browser's baby-monitor encryption data stays: its own keys, its copies of nursery keys, the counters its encryption uses, and which cameras it has seen encrypt");
        expect(cookies).toContain('Device settings stay too: your preferences (theme, camera lens, tours seen, the tracker\'s units and similar), the name this device goes by in the baby monitor, and the folder you picked for saving recordings.');
        expect(read('live/accountPurge.ts')).toMatch(/const PREFIXES = \[[^\]]*'ds-monitor-guest-'/);
        for (const kept of ['ds-monitor-device', 'ds-relay-seq-']) expect(read('live/accountPurge.ts'), kept).not.toContain(`'${kept}`);
        expect(textOf(cookiesMain.querySelector('#what-we-store') as HTMLElement)).toContain('guest passes for nurseries you joined with a share link');
        expect(cookies).toContain("Changes to your call favourites and blocks that haven't reached our server yet stay, for your account only, until they do.");
        expect(cookies).toContain('Each is offered only to the account its studio was opened for; one made while no one was signed in is offered to anyone who opens Stream Studio on that device.');
        expect(cookies).toContain('sees only how many of your unsaved recordings there are and how much space they use, and can delete them; anyone there sees the same for recordings offered to no one.');
        expect(cookies).not.toContain('only the account that made them is offered them');
    });

    it('Privacy: free models may keep and learn from what they receive, the Contact form and its retention row, and memory import (DreamStream review)', () => {
        const privacyMain = renderDoc('privacy').main;
        const privacy = textOf(privacyMain);
        expect(textOf(privacyMain.querySelector('#ai-processing') as HTMLElement)).toContain('Free models in particular may keep what they receive and learn from it, that is, use it to train or improve their models.');
        expect(privacy).toContain('The Contact form in Settings sends our database the email address you enter, your message, a phone number if you add one, and your account, so we can reply by email.');
        expect(textOf(privacyMain.querySelector('#retention') as HTMLElement)).toMatch(/Messages sent with the Contact form in Settings\s*How long\s*Not deleted automatically today; email us to have yours deleted\./);
        // What an import sends: pasted text up to its first 24,000 characters; from JSON, the text it finds
        // outside messages marked as the assistant's (the first 800 pieces), or a file it finds nothing in as
        // it is (services/memoryImport.ts; legalFacts.test.ts runs it).
        expect(privacy).toContain("You can also import memories from another AI tool (ChatGPT, Claude, Gemini or another) into that list. Your browser sends text you paste or a text file you upload as it is, up to its first 24,000 characters. From JSON, such as ChatGPT's or Claude's conversations file, it sends the text it finds in memory and instruction entries, in messages the file marks as yours, and in other fields such as \"text\" or \"content\" that the file doesn't mark as the assistant's, but not messages the file marks as the assistant's: the first 800 pieces of text it finds, up to 24,000 characters. So an assistant's reply in a file that doesn't say who wrote what can be sent, and a JSON file in which it finds none of that, such as a Google Takeout activity file, is sent as it is, assistant replies included, up to its first 24,000 characters.");
        expect(privacy).not.toContain('what you paste or upload (up to the first');
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

    it('the browser\'s Back uses onHistoryBack when App gives one, and the page\'s Back button uses onBack when nothing in this visit opened the page', () => {
        const onBack = vi.fn();
        const onHistoryBack = vi.fn();
        window.history.replaceState({}, '', '/privacy');
        render(<PrivacyPolicy onBack={onBack} onHistoryBack={onHistoryBack} onOpenDoc={vi.fn()} />);
        window.history.replaceState({}, '', '/?view=gallery');
        window.dispatchEvent(new PopStateEvent('popstate'));
        expect(onHistoryBack).toHaveBeenCalledTimes(1);
        expect(onBack).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(onBack).toHaveBeenCalledTimes(1);
        expect(onHistoryBack).toHaveBeenCalledTimes(1);
    });

    it('opened from another page of this visit (a marked entry), the page\'s Back button goes back in history instead of calling onBack', () => {
        const onBack = vi.fn();
        const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
        window.history.replaceState(legalEntryState(), '', '/privacy');
        render(<PrivacyPolicy onBack={onBack} onHistoryBack={vi.fn()} onOpenDoc={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(back).toHaveBeenCalledTimes(1);
        expect(onBack).not.toHaveBeenCalled();
        back.mockRestore();
    });

    it('outside the app (no onOpenDoc: nothing listens for Back), the page\'s Back button always uses onBack', () => {
        const onBack = vi.fn();
        const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
        window.history.replaceState(legalEntryState(), '', '/privacy');
        render(<PrivacyPolicy onBack={onBack} />);
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(onBack).toHaveBeenCalledTimes(1);
        expect(back).not.toHaveBeenCalled();
        back.mockRestore();
    });

    it('the shared footer adds a history entry too, marked as opened in the app', () => {
        const swallow = (e: MouseEvent) => e.preventDefault();
        document.addEventListener('click', swallow);
        const before = window.history.length;
        render(<LegalMicroLinks onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} onOpenLegal={vi.fn()} />);
        fireEvent.click(screen.getByRole('link', { name: 'Terms of Service' }));
        expect(window.location.pathname).toBe('/terms');
        expect(window.history.length).toBe(before + 1);
        expect(window.history.state).toEqual(legalEntryState());
        document.removeEventListener('click', swallow);
    });
});

describe('Back from a legal page shows the view the entry names (App routing in miniature)', () => {
    // App.tsx in miniature, built from the same legalRoutes helpers App uses: its restorable views,
    // its address sync (replaceState keeping only a legal entry's mark; the share viewer and the
    // reader keep their own address), handleNavigate (one entry, pushLegalPath for a legal document),
    // restoreViewFromHistory (a reader entry, the comic already open shown again without loading it,
    // the open project's workspace and the profile App holds included), leaveLegalPage, openLegal,
    // the date-of-birth prompt (which waits while a legal page is open), the header on every view, and
    // the shared footer under the other views. The comic reader (ComicReader, also inside SharedViewer)
    // holds a back-stack layer and wraps all its footer links in leaveTo, as the real one does.
    const RESTORABLE = new Set<string>(['dashboard', 'gallery', 'settings', ...LEGAL_DOCS.map((d) => d.id)]);
    const Reader: React.FC<{ label: string; layer: string; onOpenPrivacy: () => void; onOpenTerms: () => void; onOpenLegal: (doc: LegalDocId) => void }> = ({ label, layer, onOpenPrivacy, onOpenTerms, onOpenLegal }) => {
        const leaveReader = useBackLayer(true, () => undefined, layer);
        const leaveTo = (fn: () => void) => () => leaveReader(fn, { final: false });
        return (
            <div>
                <p>{label}</p>
                <LegalMicroLinks onOpenPrivacy={leaveTo(onOpenPrivacy)} onOpenTerms={leaveTo(onOpenTerms)} onOpenFaq={vi.fn()} onOpenLegal={(doc) => leaveTo(() => onOpenLegal(doc))()} />
            </div>
        );
    };
    const Shell: React.FC<{ initial: string; signedIn?: boolean; project?: string; profile?: string; needsDob?: boolean; onLoadComic?: (id: string) => void }> = ({ initial, signedIn = true, project, profile, needsDob = false, onLoadComic }) => {
        const [view, setView] = React.useState(initial);
        const [dobPrompted, setDobPrompted] = React.useState(false);
        // App's date-of-birth prompt: it opens Settings once, but never off a legal page.
        React.useEffect(() => {
            if (!needsDob || dobPrompted) return;
            if (isOnLegalPage(view)) return;
            setDobPrompted(true);
            setView('settings');
        }, [needsDob, dobPrompted, view]);
        const [token, setToken] = React.useState<string | null>(() => /^\/share\/([^/]+)$/.exec(window.location.pathname)?.[1] ?? null);
        const [comic, setComic] = React.useState<string | null>(() => new URLSearchParams(window.location.search).get('id'));
        React.useEffect(() => {
            if (view === 'shared' || view === 'reader') return;
            const url = new URL(window.location.href);
            if (view === 'editor' && project) {
                url.pathname = '/';
                url.searchParams.set('view', 'editor');
                url.searchParams.set('id', project);
            } else {
                url.searchParams.delete('id');
                if (!syncLegalPath(url, view)) {
                    if (view === 'home') url.searchParams.delete('view');
                    else url.searchParams.set('view', view);
                }
            }
            window.history.replaceState(keepLegalEntryMark(window.history.state), '', url);
        }, [view]);
        const leaveLegalPage = () => setView(signedIn ? 'dashboard' : 'home');
        const restoreViewFromHistory = () => {
            const entry = viewForHistoryEntry(
                window.location,
                (v, id) => RESTORABLE.has(v) || (v === 'auth' && !signedIn) || (v === 'read' && !!id) || (v === 'editor' && !!id) || (v === 'profile' && !!profile)
            );
            if (!entry) return leaveLegalPage();
            if (entry.shareToken) setToken(entry.shareToken);
            if (entry.view === 'read' && entry.id) {
                // App: the comic the reader had open is shown again as it was; another one goes through
                // navigateToReader(entry.id, …) (a fetch and a view count), which rewrites this same entry.
                if (entry.id !== comic) {
                    onLoadComic?.(entry.id);
                    setComic(entry.id);
                }
                setView('reader');
                return;
            }
            if (entry.view === 'editor' && entry.id) {
                // App: the open project goes straight back; another one goes through setPendingStudioTarget.
                if (entry.id === project) setView('editor');
                return;
            }
            setView(entry.view);
        };
        const openLegal = (doc: LegalDocId) => () => {
            pushLegalPath(doc);
            setView(doc);
        };
        const navigate = (to: string) => {
            setView(to);
            const url = new URL(window.location.href);
            url.searchParams.delete('view');
            url.searchParams.delete('id');
            url.pathname = '/';
            if (isLegalDocId(to)) pushLegalPath(to);
            else window.history.pushState({}, '', url);
        };
        const Page = isLegalDocId(view) ? PAGES[view] : null;
        let body: React.ReactNode;
        if (Page) body = <Page onBack={leaveLegalPage} onHistoryBack={restoreViewFromHistory} onOpenDoc={setView} />;
        else if (view === 'shared' || view === 'reader') {
            body = (
                <Reader
                    key={`${view}:${token}:${comic}`}
                    label={view === 'shared' ? `View: shared ${token}` : `View: reader ${comic}`}
                    layer={view === 'shared' ? `reader:share-${token}` : `reader:${comic}`}
                    onOpenPrivacy={openLegal('privacy')}
                    onOpenTerms={openLegal('terms')}
                    onOpenLegal={(doc) => openLegal(doc)()}
                />
            );
        } else {
            body = (
                <div>
                    <p>{`View: ${view}${view === 'editor' ? ` ${project}` : view === 'profile' ? ` ${profile}` : ''}`}</p>
                    {view === 'settings' && (
                        <a href="/privacy" onClick={(e) => (e.preventDefault(), navigate('privacy'))}>
                            Settings → Legal: Privacy Policy
                        </a>
                    )}
                    <LegalMicroLinks onOpenPrivacy={() => setView('privacy')} onOpenTerms={() => setView('terms')} onOpenLegal={setView} onOpenFaq={vi.fn()} />
                </div>
            );
        }
        return (
            <div>
                <button type="button" onClick={() => navigate('gallery')}>Header: Gallery</button>
                <button type="button" onClick={() => navigate('privacy')}>Header: Privacy Policy</button>
                {body}
            </div>
        );
    };
    afterEach(() => resetBackStack());
    const swallow = (e: MouseEvent) => e.preventDefault(); // jsdom can't follow a link
    const clickFooter = (name: string) => {
        document.addEventListener('click', swallow);
        fireEvent.click(screen.getByRole('link', { name }));
        document.removeEventListener('click', swallow);
    };
    const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
    const pageBack = () => fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const address = () => `${window.location.pathname}${window.location.search}`;

    it('Gallery → footer Privacy Policy → Back shows Gallery again, at /?view=gallery (not the Dashboard)', async () => {
        window.history.replaceState({}, '', '/?view=gallery');
        render(<Shell initial="gallery" />);
        clickFooter('Privacy Policy');
        await heading('Privacy Policy');
        expect(window.location.pathname).toBe('/privacy');
        window.history.back();
        await waitFor(() => expect(screen.getByText('View: gallery')).toBeInTheDocument());
        expect(address()).toBe('/?view=gallery');
    });

    it('the page\'s own Back button does what the browser\'s Back does: Gallery → footer → Back button → Gallery', async () => {
        window.history.replaceState({}, '', '/?view=gallery');
        const before = window.history.length;
        render(<Shell initial="gallery" />);
        clickFooter('Privacy Policy');
        await heading('Privacy Policy');
        pageBack();
        await waitFor(() => expect(screen.getByText('View: gallery')).toBeInTheDocument());
        expect(address()).toBe('/?view=gallery');
        // It went back to Gallery's entry instead of stacking a new one on top of the document's.
        expect(window.history.length).toBe(before + 1);
    });

    it('Settings → Legal → a document → Back returns to Settings on its Legal tab; the document\'s own address carries no ?tab=', async () => {
        window.history.replaceState({}, '', '/?view=settings&tab=legal');
        const before = window.history.length;
        render(<Shell initial="settings" />);
        fireEvent.click(screen.getByRole('link', { name: 'Settings → Legal: Privacy Policy' }));
        await heading('Privacy Policy');
        expect(address()).toBe('/privacy');
        expect(window.history.length).toBe(before + 1);
        window.history.back();
        await waitFor(() => expect(screen.getByText('View: settings')).toBeInTheDocument());
        expect(address()).toBe('/?view=settings&tab=legal');
    });

    it('Settings (Legal tab) → a document → the page\'s "Back" button → Settings on the Legal tab at /?view=settings&tab=legal', async () => {
        window.history.replaceState({}, '', '/?view=settings&tab=legal');
        render(<Shell initial="settings" />);
        fireEvent.click(screen.getByRole('link', { name: 'Settings → Legal: Privacy Policy' }));
        await heading('Privacy Policy');
        pageBack();
        await waitFor(() => expect(screen.getByText('View: settings')).toBeInTheDocument());
        expect(address()).toBe('/?view=settings&tab=legal');
    });

    it('a document → another one from the legal navigation → Back button → the first → Back button → the page that opened it', async () => {
        window.history.replaceState({}, '', '/?view=gallery');
        render(<Shell initial="gallery" />);
        clickFooter('Privacy Policy');
        await heading('Privacy Policy');
        fireEvent.click(screen.getByRole('link', { name: 'Cookies' }));
        await heading('Cookies & Local Storage');
        expect(window.location.pathname).toBe('/cookies');
        pageBack();
        await heading('Privacy Policy');
        expect(window.location.pathname).toBe('/privacy');
        pageBack();
        await waitFor(() => expect(screen.getByText('View: gallery')).toBeInTheDocument());
        expect(address()).toBe('/?view=gallery');
    });

    it('Gallery → footer Privacy Policy → a table-of-contents entry → the page\'s Back button → Gallery, at /?view=gallery with no #section left', async () => {
        Element.prototype.scrollIntoView = vi.fn();
        window.history.replaceState({}, '', '/?view=gallery');
        const before = window.history.length;
        render(<Shell initial="gallery" />);
        clickFooter('Privacy Policy');
        await heading('Privacy Policy');
        const toc = within(screen.getByRole('navigation', { name: 'On this page' })).getAllByRole('link');
        fireEvent.click(toc[0]);
        fireEvent.click(toc[3]);
        expect(window.location.hash).toBe(toc[3].getAttribute('href'));
        // The jumps stayed on the document's entry (one entry above Gallery's), so Back lands on Gallery.
        expect(window.history.length).toBe(before + 1);
        pageBack();
        await waitFor(() => expect(screen.getByText('View: gallery')).toBeInTheDocument());
        expect(window.location.href).toBe(`${window.location.origin}/?view=gallery`);
    });

    it('Gallery → footer Terms → a link to a section of the Privacy Policy → Back button → Terms → Back button → Gallery', async () => {
        const scroll = vi.fn();
        Element.prototype.scrollIntoView = scroll;
        window.history.replaceState({}, '', '/?view=gallery');
        render(<Shell initial="gallery" />);
        clickFooter('Terms of Service');
        await heading('Terms of Service');
        fireEvent.click(screen.getByRole('link', { name: 'Children section of the Privacy Policy' }));
        await heading('Privacy Policy');
        // It opened in the app on the section, on an entry of its own.
        expect(`${window.location.pathname}${window.location.hash}`).toBe('/privacy#children');
        expect(scroll.mock.contexts.at(-1)).toHaveProperty('id', 'children');
        pageBack();
        await heading('Terms of Service');
        expect(`${window.location.pathname}${window.location.hash}`).toBe('/terms');
        pageBack();
        await waitFor(() => expect(screen.getByText('View: gallery')).toBeInTheDocument());
        expect(address()).toBe('/?view=gallery');
    });

    it('a link to a section of another document leaves keyboard focus on that section, as a jump on the same page does (not on <body>)', async () => {
        Element.prototype.scrollIntoView = vi.fn();
        window.history.replaceState({}, '', '/?view=gallery');
        render(<Shell initial="gallery" />);
        clickFooter('Terms of Service');
        await heading('Terms of Service');
        const link = screen.getByRole('link', { name: 'Children section of the Privacy Policy' });
        link.focus();
        fireEvent.click(link);
        await heading('Privacy Policy');
        const children = document.getElementById('children') as HTMLElement;
        expect(document.activeElement).toBe(children);
        expect(children.getAttribute('tabindex')).toBe('-1');
        // A jump on the page shown lands the same way.
        const toc = within(screen.getByRole('navigation', { name: 'On this page' })).getAllByRole('link');
        fireEvent.click(toc[2]);
        expect(document.activeElement?.id).toBe((toc[2].getAttribute('href') as string).slice(1));
    });

    it('after a table-of-contents jump, a link to the document already shown adds no entry: it drops the #section, goes to the top, and one Back leaves the document', async () => {
        Element.prototype.scrollIntoView = vi.fn();
        const toTop = vi.fn();
        const el = document.scrollingElement ?? document.documentElement;
        const scrollTo = (el as HTMLElement & { scrollTo?: unknown }).scrollTo;
        (el as HTMLElement & { scrollTo: unknown }).scrollTo = toTop;
        try {
            window.history.replaceState({}, '', '/?view=gallery');
            const before = window.history.length;
            render(<Shell initial="gallery" />);
            clickFooter('Privacy Policy');
            await heading('Privacy Policy');
            const toc = within(screen.getByRole('navigation', { name: 'On this page' })).getAllByRole('link');
            fireEvent.click(toc[3]);
            expect(window.location.hash).toBe(toc[3].getAttribute('href'));
            toTop.mockClear();
            // The same document again (the shared footer and the header both push through pushLegalPath).
            fireEvent.click(screen.getByRole('button', { name: 'Header: Privacy Policy' }));
            expect(window.history.length).toBe(before + 1);
            expect(`${window.location.pathname}${window.location.hash}`).toBe('/privacy');
            expect(legalBackGoesBack()).toBe(true);
            expect(toTop).toHaveBeenCalledWith({ top: 0 });
            // Focus goes to the top too: left on the section, the next Tab would scroll back down to it.
            expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Privacy Policy' }));
            window.history.back();
            await waitFor(() => expect(screen.getByText('View: gallery')).toBeInTheDocument());
            expect(address()).toBe('/?view=gallery');
        } finally {
            (el as HTMLElement & { scrollTo: unknown }).scrollTo = scrollTo;
        }
    });

    it('the shared footer under a legal document (App shows it there), used from the keyboard: the document shown, or another one, starts at its title, so the next Tab doesn\'t scroll back down to the footer', async () => {
        Element.prototype.scrollIntoView = vi.fn();
        const el = document.scrollingElement ?? document.documentElement;
        const scrollTo = (el as HTMLElement & { scrollTo?: unknown }).scrollTo;
        (el as HTMLElement & { scrollTo: unknown }).scrollTo = vi.fn();
        const Doc: React.FC = () => {
            const [doc, setDoc] = React.useState<LegalDocId>('privacy');
            const Page = PAGES[doc];
            return (
                <div>
                    <Page key={doc} onBack={vi.fn()} onOpenDoc={setDoc} />
                    <LegalMicroLinks onOpenPrivacy={() => setDoc('privacy')} onOpenTerms={() => setDoc('terms')} onOpenLegal={setDoc} onOpenFaq={vi.fn()} />
                </div>
            );
        };
        try {
            window.history.replaceState({}, '', '/privacy');
            render(<Doc />);
            await screen.findByRole('heading', { level: 1, name: 'Privacy Policy' });
            // Loaded cold, nothing has focus yet: none is moved.
            expect(document.activeElement).toBe(document.body);
            const footer = screen.getByRole('navigation', { name: 'Legal and support' });
            const own = within(footer).getByRole('link', { name: 'Privacy Policy' });
            own.focus();
            fireEvent.click(own);
            expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Privacy Policy' }));
            const terms = within(footer).getByRole('link', { name: 'Terms of Service' });
            terms.focus();
            fireEvent.click(terms);
            const title = await screen.findByRole('heading', { level: 1, name: 'Terms of Service' });
            await waitFor(() => expect(document.activeElement).toBe(title));
        } finally {
            (el as HTMLElement & { scrollTo: unknown }).scrollTo = scrollTo;
        }
    });

    it('the legal navigation, or a link in the text, used from the keyboard: the link is gone with the page, and the next document starts at its title (a section link lands on its section)', async () => {
        Element.prototype.scrollIntoView = vi.fn();
        const el = document.scrollingElement ?? document.documentElement;
        const scrollTo = (el as HTMLElement & { scrollTo?: unknown }).scrollTo;
        (el as HTMLElement & { scrollTo: unknown }).scrollTo = vi.fn();
        // As App renders them: each document in its own slot, so the page that was shown unmounts.
        const Docs: React.FC = () => {
            const [doc, setDoc] = React.useState<LegalDocId>('privacy');
            return (
                <div>
                    {doc === 'privacy' && <PrivacyPolicy onBack={vi.fn()} onOpenDoc={setDoc} />}
                    {doc === 'terms' && <TermsOfService onBack={vi.fn()} onOpenDoc={setDoc} />}
                </div>
            );
        };
        try {
            window.history.replaceState({}, '', '/privacy');
            render(<Docs />);
            await screen.findByRole('heading', { level: 1, name: 'Privacy Policy' });
            expect(document.activeElement).toBe(document.body); // loaded cold: left alone
            const pill = within(screen.getByRole('navigation', { name: 'Legal documents' })).getByRole('link', { name: 'Terms of Service' });
            pill.focus();
            fireEvent.click(pill);
            const terms = await screen.findByRole('heading', { level: 1, name: 'Terms of Service' });
            await waitFor(() => expect(document.activeElement).toBe(terms));
            expect(legalBackGoesBack()).toBe(true);
            // A link in the text to the top of another document.
            const main = () => document.querySelector('main') as HTMLElement;
            const inText = [...main().querySelectorAll('a[href="/privacy"]')].find((a) => !a.closest('nav')) as HTMLElement;
            inText.focus();
            fireEvent.click(inText);
            const privacy = await screen.findByRole('heading', { level: 1, name: 'Privacy Policy' });
            await waitFor(() => expect(document.activeElement).toBe(privacy));
            // And one to a section of another document lands on that section, as before.
            const toSection = main().querySelector('a[href="/terms#youtube"]') as HTMLElement;
            toSection.focus();
            fireEvent.click(toSection);
            await screen.findByRole('heading', { level: 1, name: 'Terms of Service' });
            await waitFor(() => expect(document.activeElement?.id).toBe('youtube'));
        } finally {
            (el as HTMLElement & { scrollTo: unknown }).scrollTo = scrollTo;
        }
    });

    it('a document loaded cold, then a table-of-contents entry: the Back button goes to the Dashboard, and its address keeps no #section', () => {
        Element.prototype.scrollIntoView = vi.fn();
        window.history.replaceState({}, '', '/privacy');
        render(<Shell initial="privacy" />);
        fireEvent.click(within(screen.getByRole('navigation', { name: 'On this page' })).getAllByRole('link')[0]);
        expect(window.location.hash).not.toBe('');
        pageBack();
        expect(screen.getByText('View: dashboard')).toBeInTheDocument();
        expect(window.location.href).toBe(`${window.location.origin}/?view=dashboard`);
    });

    it('a document loaded cold (nothing in this visit opened it): the Back button stays in the app (Dashboard, or Home signed out)', () => {
        for (const [signedIn, expected] of [[true, 'View: dashboard'], [false, 'View: home']] as const) {
            window.history.replaceState({}, '', '/privacy');
            const before = window.history.length;
            const back = vi.spyOn(window.history, 'back');
            const { unmount } = render(<Shell initial="privacy" signedIn={signedIn} />);
            pageBack();
            expect(screen.getByText(expected)).toBeInTheDocument();
            expect(back).not.toHaveBeenCalled();
            expect(window.history.length).toBe(before);
            back.mockRestore();
            unmount();
        }
    });

    it('a /share/<token> link → the reader\'s footer (inside its back layer) → Back shows that shared comic again, at its own address', async () => {
        window.history.replaceState({}, '', '/?view=gallery'); // the page before the share link
        window.history.pushState({}, '', '/share/tok-123');
        render(<Shell initial="shared" />);
        expect(screen.getByText('View: shared tok-123')).toBeInTheDocument();
        clickFooter('Terms of Service');
        await heading('Terms of Service');
        expect(window.location.pathname).toBe('/terms');
        window.history.back();
        await waitFor(() => expect(screen.getByText('View: shared tok-123')).toBeInTheDocument());
        expect(window.location.pathname).toBe('/share/tok-123');
    });

    it('a /share/<token> link → the reader\'s footer → the page\'s Back button → the shared comic', async () => {
        window.history.replaceState({}, '', '/?view=gallery');
        window.history.pushState({}, '', '/share/tok-456');
        render(<Shell initial="shared" />);
        clickFooter('Privacy Policy');
        await heading('Privacy Policy');
        pageBack();
        await waitFor(() => expect(screen.getByText('View: shared tok-456')).toBeInTheDocument());
        expect(window.location.pathname).toBe('/share/tok-456');
    });

    it('a comic in the reader (?view=read&id=…) → its footer → Back reopens that comic', async () => {
        window.history.replaceState({}, '', '/?view=read&id=c1');
        render(<Shell initial="reader" />);
        clickFooter('Privacy Policy');
        await heading('Privacy Policy');
        window.history.back();
        await waitFor(() => expect(screen.getByText('View: reader c1')).toBeInTheDocument());
        expect(address()).toBe('/?view=read&id=c1');
    });

    it('the project open in the classic editor → footer → Back shows the editor again, not the Dashboard', async () => {
        window.history.replaceState({}, '', '/?view=editor&id=p-open');
        render(<Shell initial="editor" project="p-open" />);
        clickFooter('Privacy Policy');
        await heading('Privacy Policy');
        window.history.back();
        await waitFor(() => expect(screen.getByText('View: editor p-open')).toBeInTheDocument());
        expect(address()).toBe('/?view=editor&id=p-open');
    });

    it('a public profile → footer → Back shows that profile again', async () => {
        window.history.replaceState({}, '', '/?view=profile');
        render(<Shell initial="profile" profile="ada" />);
        clickFooter('Cookies');
        await heading('Cookies & Local Storage');
        window.history.back();
        await waitFor(() => expect(screen.getByText('View: profile ada')).toBeInTheDocument());
        expect(window.location.search).toBe('?view=profile');
    });

    it('signed out, the sign-in page → footer → Back shows the sign-in page again', async () => {
        window.history.replaceState({}, '', '/?view=auth');
        render(<Shell initial="auth" signedIn={false} />);
        clickFooter('Cookies');
        await heading('Cookies & Local Storage');
        window.history.back();
        await waitFor(() => expect(screen.getByText('View: auth')).toBeInTheDocument());
        expect(window.location.search).toBe('?view=auth');
    });

    it('an entry that names no view App can show falls back to Dashboard when signed in, Home when not', () => {
        for (const [signedIn, expected] of [[true, 'View: dashboard'], [false, 'View: home']] as const) {
            window.history.replaceState({}, '', '/privacy');
            const { unmount } = render(<Shell initial="privacy" signedIn={signedIn} />);
            window.history.replaceState({}, '', '/?view=fontlab');
            act(() => {
                window.dispatchEvent(new PopStateEvent('popstate'));
            });
            expect(screen.getByText(expected)).toBeInTheDocument();
            unmount();
        }
    });

    it('header navigation from a legal page adds ONE entry: Back reopens the document, and the next Back leaves it', async () => {
        window.history.replaceState({}, '', '/?view=dashboard');
        render(<Shell initial="dashboard" />);
        clickFooter('Privacy Policy');
        await heading('Privacy Policy');
        const onDocument = window.history.length;
        fireEvent.click(screen.getByRole('button', { name: 'Header: Gallery' }));
        await waitFor(() => expect(screen.getByText('View: gallery')).toBeInTheDocument());
        expect(window.history.length).toBe(onDocument + 1);
        expect(window.location.search).toBe('?view=gallery');

        window.history.back();
        await heading('Privacy Policy');
        expect(window.location.pathname).toBe('/privacy');
        window.history.back();
        await waitFor(() => expect(screen.getByText('View: dashboard')).toBeInTheDocument());
        expect(window.location.search).toBe('?view=dashboard');
    });

    it('the header\'s link to the document already shown adds no entry (pushLegalPath), so one Back still leaves it', async () => {
        window.history.replaceState({}, '', '/?view=gallery');
        const before = window.history.length;
        render(<Shell initial="gallery" />);
        fireEvent.click(screen.getByRole('button', { name: 'Header: Privacy Policy' }));
        await heading('Privacy Policy');
        fireEvent.click(screen.getByRole('button', { name: 'Header: Privacy Policy' }));
        expect(window.history.length).toBe(before + 1);
        window.history.back();
        await waitFor(() => expect(screen.getByText('View: gallery')).toBeInTheDocument());
        expect(address()).toBe('/?view=gallery');
    });

    it('the reader\'s footer opens all six documents in the app: a comic → its footer\'s Cookies → Back shows that comic again, without loading it again', async () => {
        const onLoadComic = vi.fn();
        window.history.replaceState({}, '', '/?view=read&id=c1');
        render(<Shell initial="reader" onLoadComic={onLoadComic} />);
        document.addEventListener('click', swallow);
        // A plain click is handled in the app (no page load), after the reader has left its layer.
        expect(fireEvent.click(screen.getByRole('link', { name: 'Cookies' }))).toBe(false);
        document.removeEventListener('click', swallow);
        await heading('Cookies & Local Storage');
        expect(window.location.pathname).toBe('/cookies');
        window.history.back();
        await waitFor(() => expect(screen.getByText('View: reader c1')).toBeInTheDocument());
        expect(address()).toBe('/?view=read&id=c1');
        expect(onLoadComic).not.toHaveBeenCalled();
    });

    it('a /share/<token> link → the reader\'s footer Subprocessors → the page\'s Back button → the shared comic, at its own address', async () => {
        window.history.replaceState({}, '', '/?view=gallery');
        window.history.pushState({}, '', '/share/tok-789');
        render(<Shell initial="shared" />);
        clickFooter('Subprocessors');
        await heading('Subprocessors');
        pageBack();
        await waitFor(() => expect(screen.getByText('View: shared tok-789')).toBeInTheDocument());
        expect(window.location.pathname).toBe('/share/tok-789');
    });

    it('the date-of-birth prompt never pulls someone off a legal page: it waits until they leave it', async () => {
        window.history.replaceState({}, '', '/privacy');
        render(<Shell initial="privacy" needsDob />);
        await heading('Privacy Policy');
        expect(window.location.pathname).toBe('/privacy');
        pageBack(); // a cold load: the Back button goes to the Dashboard, and the prompt runs from there
        await waitFor(() => expect(screen.getByText('View: settings')).toBeInTheDocument());
    });
});

describe('App\'s automatic moves wait while a legal page is open (isOnLegalPage)', () => {
    it('a legal view, or an old ?view= link to one that the view hasn\'t caught up with; not a path App is leaving', () => {
        window.history.replaceState({}, '', '/');
        for (const doc of LEGAL_DOCS) expect(isOnLegalPage(doc.id), doc.id).toBe(true);
        for (const view of ['home', 'dashboard', 'gallery', 'settings', 'reader']) expect(isOnLegalPage(view), view).toBe(false);
        window.history.replaceState({}, '', '/?view=terms');
        expect(isOnLegalPage('home')).toBe(true);
        window.history.replaceState({}, '', '/?view=gallery');
        expect(isOnLegalPage('gallery')).toBe(false);
        // Leaving a document: the view has changed and the address catches up a moment later.
        window.history.replaceState({}, '', '/privacy');
        expect(isOnLegalPage('dashboard')).toBe(false);
    });

    it('a ?view= on a path that owns its address (App never restores or rewrites it there) holds nothing back', () => {
        try {
            for (const [path, view] of [
                ['/share/tok?view=terms', 'shared'],
                ['/share/tok/?view=privacy', 'shared'],
                ['/models?view=privacy', 'models'],
                ['/auth/callback?view=cookies', 'auth-callback'],
                ['/auth/callback/?view=terms', 'auth-callback'],
                ['/c/AbCdEfGhIjKlMnOpQ?view=terms', 'publiccomic']
            ] as const) {
                window.history.replaceState({}, '', path);
                expect(isOnLegalPage(view), path).toBe(false);
            }
            // The document itself still counts there once it is the view.
            window.history.replaceState({}, '', '/share/tok?view=terms');
            expect(isOnLegalPage('terms')).toBe(true);
        } finally {
            window.history.replaceState({}, '', '/');
        }
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
        // The CHANGELOG no longer gives the reader's footer the unrouted contact@ address.
        const changelog = read('CHANGELOG.md');
        expect(changelog).not.toContain("the comic reader's footer (contact@dreamstreamstudio.ai)");
        expect(changelog).toContain("the comic reader's footer, and the support address in Account Settings\n  (all support@dreamstreamstudio.ai;");
        // Settings → Contact names the mailbox legalFacts defines, not a copy of it.
        const settings = read('components/AccountSettings.tsx');
        expect(settings).toContain('Support Email: {SUPPORT_EMAIL}');
        expect(settings).not.toContain(SUPPORT_EMAIL);
        for (const id of ['acceptable-use', 'copyright'] as const) {
            expect(LIVE_LEGAL_LINKS.some((l) => legalDocForPath(new URL(l.href, 'https://dreamstreamstudio.ai').pathname) === id)).toBe(true);
        }
    });

    it('Settings → Legal links to the documents instead of carrying an old copy', () => {
        const settings = read('components/AccountSettings.tsx');
        expect(settings).not.toMatch(/Feb 11, 2026|Stripe for subscriptions|Token-based limits apply/);
        expect(settings).toContain('LEGAL_DOCS.map((doc)');
        // Opened inside the app (App's handleNavigate gives the document its own entry), and the
        // browser's Back comes back to Settings on this tab ("Settings → Legal → a document → Back").
        const legal = settings.slice(settings.indexOf('const renderLegal = () =>'), settings.indexOf('const renderLegal = () =>') + 1500);
        expect(legal).toContain('href={doc.path}');
        expect(legal).toContain('onNavigate(doc.id);');
        expect(legal).not.toContain('target="_blank"');
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
