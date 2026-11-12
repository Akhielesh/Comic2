import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The legal links that aren't the shared footer, rendered for real and wired the way App.tsx wires
// them: the home page's footer, the Comics landing's footer and the sign-up form's consent links all
// go through App's openLegal (pushLegalPath, then the view), so the document gets its own marked entry
// and Back (the browser's, or the document's own button) returns to the page that opened it instead of
// skipping it or leaving the site. legalRoutes.test.ts pins that App.tsx passes openLegal to each one.

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));

import { AuthPage } from '../AuthPage';
import { HomePage } from '../HomePage';
import { PrivacyPolicy } from '../PrivacyPolicy';
import { TermsOfService } from '../TermsOfService';
import { ComicsLanding } from '../comicshost/ComicsLanding';
import type { LegalPageProps } from './LegalDocument';
import {
    isLegalDocId,
    keepLegalEntryMark,
    legalBackGoesBack,
    pushLegalPath,
    syncLegalPath,
    viewForHistoryEntry,
    type LegalDocId
} from './legalRoutes';

const PAGES: Partial<Record<LegalDocId, React.FC<LegalPageProps>>> = { privacy: PrivacyPolicy, terms: TermsOfService };
// App.tsx RESTORABLE_VIEWS (signed out: 'auth' is restorable too).
const RESTORABLE = new Set<string>(['dashboard', 'chat', 'ventures', 'gallery', 'learn', 'how-it-works', 'settings', 'privacy', 'terms', 'acceptable-use', 'copyright', 'cookies', 'subprocessors']);

/** App.tsx in miniature, signed out: its address sync, leaveLegalPage, restoreViewFromHistory, handleNavigate and openLegal. */
const Shell: React.FC<{ initial: string; comics?: boolean }> = ({ initial, comics = false }) => {
    const [view, setView] = React.useState(initial);
    React.useEffect(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete('id');
        if (!syncLegalPath(url, view)) {
            if (view === 'home') url.searchParams.delete('view');
            else url.searchParams.set('view', view);
        }
        window.history.replaceState(keepLegalEntryMark(window.history.state), '', url);
    }, [view]);
    const leaveLegalPage = () => setView('home');
    const restoreViewFromHistory = () => {
        const entry = viewForHistoryEntry(window.location, (v) => RESTORABLE.has(v) || v === 'auth');
        if (!entry) return leaveLegalPage();
        setView(entry.view);
    };
    const handleNavigate = (to: string) => {
        setView(to);
        const url = new URL(window.location.href);
        url.searchParams.delete('view');
        url.searchParams.delete('id');
        url.pathname = '/';
        if (isLegalDocId(to)) pushLegalPath(to);
        else window.history.pushState({}, '', url);
    };
    // App.tsx openLegal, exactly.
    const openLegal = (doc: LegalDocId) => () => {
        pushLegalPath(doc);
        setView(doc);
    };
    const Page = isLegalDocId(view) ? PAGES[view] : null;
    return (
        <div>
            <p>{`View: ${view}`}</p>
            {view === 'home' &&
                (comics ? (
                    <ComicsLanding
                        signedIn={false}
                        onSignIn={() => handleNavigate('auth')}
                        onRequestAccess={() => handleNavigate('auth')}
                        onOpenComics={() => handleNavigate('dashboard')}
                        onBrowseGallery={() => handleNavigate('gallery')}
                        onOpenPrivacy={openLegal('privacy')}
                        onOpenTerms={openLegal('terms')}
                    />
                ) : (
                    <HomePage onEnterStudio={() => setView('auth')} onViewComics={() => setView('gallery')} onOpenPrivacy={openLegal('privacy')} onOpenTerms={openLegal('terms')} onNavigate={handleNavigate} />
                ))}
            {view === 'auth' && (
                <AuthPage initialMode="signin" pendingInviteCode="ABCD1234" onLoginSuccess={() => setView('dashboard')} onOpenPrivacy={openLegal('privacy')} onOpenTerms={openLegal('terms')} />
            )}
            {Page && <Page onBack={leaveLegalPage} onHistoryBack={restoreViewFromHistory} onOpenDoc={setView} />}
        </div>
    );
};

const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
const pageBack = () => fireEvent.click(screen.getByRole('button', { name: 'Back' }));
const viewText = () => screen.getByText(/^View: /).textContent;
const address = () => `${window.location.pathname}${window.location.search}`;
const browserBack = async () => {
    await act(async () => {
        window.history.back();
        await new Promise((resolve) => setTimeout(resolve, 30));
    });
};
/** The page the visitor came from (their email app, another site): the entry under DreamStream's first. */
const arriveFromElsewhere = (first: string) => {
    window.history.replaceState({}, '', '/__before_dreamstream');
    window.history.pushState({}, '', first);
};

afterEach(() => {
    window.location.hash = '';
    window.history.replaceState({}, '', '/');
});

describe('legal links outside the shared footer open the document on its own entry', () => {
    it('an invite link (the sign-up form on the tab\'s first entry) → the consent "Terms of Service" → the page\'s Back button → the sign-up form', async () => {
        arriveFromElsewhere('/?view=auth');
        const before = window.history.length;
        render(<Shell initial="auth" />);
        fireEvent.click(screen.getAllByRole('button', { name: 'Terms of Service' })[0]);
        await heading('Terms of Service');
        expect(address()).toBe('/terms');
        expect(window.history.length).toBe(before + 1);
        expect(legalBackGoesBack()).toBe(true);
        pageBack();
        await waitFor(() => expect(viewText()).toBe('View: auth'));
        expect(address()).toBe('/?view=auth');
    });

    it('the same with the browser\'s Back, and with the consent "Privacy Policy": it returns to the sign-up form instead of leaving the site', async () => {
        arriveFromElsewhere('/?view=auth');
        render(<Shell initial="auth" />);
        fireEvent.click(screen.getAllByRole('button', { name: 'Privacy Policy' })[0]);
        await heading('Privacy Policy');
        await browserBack();
        await waitFor(() => expect(viewText()).toBe('View: auth'));
        expect(address()).toBe('/?view=auth');
    });

    it('Back returns to the sign-up page, but with its fields empty again (AuthPage keeps them in its own state, and the document replaces it): App\'s openLegal says so', async () => {
        arriveFromElsewhere('/?view=auth');
        render(<Shell initial="auth" />);
        const email = () => document.querySelector('input[type="email"]') as HTMLInputElement;
        fireEvent.change(email(), { target: { value: 'invitee@example.com' } });
        expect(email().value).toBe('invitee@example.com');
        fireEvent.click(screen.getAllByRole('button', { name: 'Terms of Service' })[0]);
        await heading('Terms of Service');
        await browserBack();
        await waitFor(() => expect(viewText()).toBe('View: auth'));
        expect(email().value).toBe('');
        const app = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../App.tsx'), 'utf8');
        expect(app).toContain('again (the comic, Home, the sign-in/sign-up page, whose fields start empty again) instead of');
        expect(app).not.toContain('again (the comic, Home, the sign-up form) instead of');
    });

    it('the home page opened cold → its footer "Privacy Policy" → the browser\'s Back → the home page, still on DreamStream', async () => {
        arriveFromElsewhere('/');
        const before = window.history.length;
        render(<Shell initial="home" />);
        const links = screen.getAllByRole('button', { name: 'Privacy Policy' });
        fireEvent.click(links[links.length - 1]);
        await heading('Privacy Policy');
        expect(window.history.length).toBe(before + 1);
        await browserBack();
        await waitFor(() => expect(viewText()).toBe('View: home'));
        expect(address()).toBe('/');
    });

    it('the Comics landing → Sign in → the consent "Terms of Service" → the browser\'s Back → the sign-in page, not skipped', async () => {
        window.history.replaceState({}, '', '/');
        render(<Shell initial="home" comics />);
        fireEvent.click(screen.getAllByRole('button', { name: /sign in/i })[0]);
        await waitFor(() => expect(viewText()).toBe('View: auth'));
        fireEvent.click(screen.getAllByRole('button', { name: 'Terms of Service' })[0]);
        await heading('Terms of Service');
        await browserBack();
        await waitFor(() => expect(viewText()).toBe('View: auth'));
        expect(address()).toBe('/?view=auth');
    });

    it('the Comics landing\'s own footer → "Terms of Service" → the page\'s Back button → the landing', async () => {
        arriveFromElsewhere('/');
        render(<Shell initial="home" comics />);
        fireEvent.click(screen.getByRole('button', { name: 'Terms' }));
        await heading('Terms of Service');
        expect(legalBackGoesBack()).toBe(true);
        pageBack();
        await waitFor(() => expect(viewText()).toBe('View: home'));
        expect(address()).toBe('/');
    });
});
