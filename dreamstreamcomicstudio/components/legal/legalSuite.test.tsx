import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrivacyPolicy } from '../PrivacyPolicy';
import { TermsOfService } from '../TermsOfService';
import { LegalMicroLinks } from '../layout/LegalMicroLinks';
import { LIVE_LEGAL_LINKS } from '../../live/ui/legalLinks';
import { AcceptableUsePolicy } from './AcceptableUsePolicy';
import { CookiesNotice, DOCUMENTED_STORAGE_KEYS } from './CookiesNotice';
import { CopyrightPolicy } from './CopyrightPolicy';
import { AI_PROVIDERS, CORE, NOT_IN_USE, OTHER_SERVICES, SubprocessorsPage, TOOL_SERVICES } from './SubprocessorsPage';
import {
    DIRECT_AI_PROVIDERS,
    GOOGLE_PRIVACY_POLICY_URL,
    GOOGLE_SECURITY_PERMISSIONS_URL,
    LEGAL_LAST_UPDATED,
    MIN_SIGNUP_AGE_YEARS,
    PRIVACY_EMAIL,
    RETENTION,
    SUPPORT_EMAIL,
    YOUTUBE_TERMS_URL
} from './legalFacts';
import { LEGAL_DOCS, legalDocForPath, type LegalDocId } from './legalRoutes';

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
        expect(emails).toContain('(Comic Studio, Chat Studio, Code Studio, Stream Studio or Dashboards)');
        expect(emails).toContain('up to 1,000 characters');
        expect(emails).toContain('suppression list');
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
            'Not deleted automatically today'
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
});

describe('Subprocessors', () => {
    it('names the infrastructure, every AI provider, and what is set up but unused', () => {
        const names = [...CORE, ...AI_PROVIDERS, ...TOOL_SERVICES, ...OTHER_SERVICES, ...NOT_IN_USE].map((s) => s.name).join(' | ');
        for (const p of ['Cloudflare', 'Supabase', 'OpenRouter', 'Google (Gemini API)', 'Ideogram', 'Pixazo', 'Jina Reader', 'ip-api.com', 'Pwned Passwords', 'Google APIs', 'Stripe', 'Railway']) {
            expect(names).toContain(p);
        }
        for (const p of DIRECT_AI_PROVIDERS.filter((p) => p !== 'Google (Gemini)')) expect(names).toContain(p);
        const text = textOf(renderDoc('subprocessors').main);
        expect(text).toContain('Nothing today: billing is switched off.');
        expect(text).toContain('United States (US West, Oregon)');
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

    it('the wrong live statements are gone', () => {
        const guide = read('live/components/Guide.tsx');
        expect(guide).not.toContain('We never ask for your Google password or permissions');
        expect(guide).toContain('This way needs no Google sign-in and no Google permissions.');
        const auth = read('components/AuthPage.tsx');
        expect(auth).not.toContain('DreamStream Inc');
        expect(auth).toContain('&copy; 2026 DreamStream Studio. All rights reserved.');
    });
});
