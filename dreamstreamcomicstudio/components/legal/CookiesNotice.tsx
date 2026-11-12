import React from 'react';
import { Callout, DataTable, DocLink, LIST, LegalDocument, MailLink, type LegalSection } from './LegalDocument';
import { BROWSER_THIRD_PARTIES, PRIVACY_EMAIL } from './legalFacts';
import type { LegalPageProps } from './LegalDocument';

// Cookies & Local Storage: what the apps keep in the browser, by purpose, with the real key names
// (each one is checked against the code by components/legal/legalSuite.test.tsx).

const Key: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <code className="rounded bg-[var(--ds-well-strong)] px-1 py-0.5 font-mono text-[12px] text-[var(--ds-ink)]">{children}</code>
);

/** Every key named on this page. A test checks that each one still appears in the app's code. */
export const DOCUMENTED_STORAGE_KEYS = [
    'dreamstream_auth_token',
    'dreamstream_auth_persist',
    'dreamstream_last_active_at',
    'ds.pendingSignIn',
    'ds.postLoginNext',
    'ds_pending_invite_code',
    'dreamstream_device_id',
    'ds.localDataOwner',
    'ds.theme.v1',
    'dreamstream_settings',
    'comicstudio.reader.prefs.v1',
    'ds-live-appearance',
    'ds-live-theme',
    'dreamstream_api_keys_v2',
    'dreamstream_openrouter_key',
    'dreamstream_flux_key',
    'dreamstream_mcp_servers',
    'dreamstream_local_cache',
    'dreamstream_comic_studio',
    'dreamstream_chat',
    'dreamstream_chat_memory',
    'ds_telemetry_session_id',
    'ds.interest.unavailable',
    'ds-live-owner',
    'ds-live-prefs',
    'ds-live-my-events',
    'ds-live-my-recordings',
    'ds-live-unsaved-recordings',
    'ds-live-viewer-name',
    'ds-live-welcome-ticket',
    'ds-monitor-device',
    'ds-call-ring',
    'ds-keys',
    'ds-live-save'
] as const;

const sections: LegalSection[] = [
    {
        id: 'summary',
        title: 'In short',
        content: (
            <ul className={LIST}>
                <li>Our own code doesn't set cookies.</li>
                <li>Our apps contain no advertising cookies and no third-party advertising or analytics trackers. Emails our server sends contain an open-tracking image (see Emails).</li>
                <li>The apps store what they need in your browser's own storage (local storage, session storage, IndexedDB and, for Stream Studio, a service worker and its cache), mostly so you stay signed in, your settings stick, and your work isn't lost.</li>
                <li>Some things are loaded by your browser straight from other companies' servers, which see your IP address and browser details when they are (see Services from other companies).</li>
            </ul>
        )
    },
    {
        id: 'what-we-store',
        title: 'What the apps store on your device',
        content: (
            <>
                <DataTable
                    caption="Browser storage used by DreamStream, by purpose"
                    head={['Purpose', 'What and where', 'Examples of keys']}
                    rows={[
                        [
                            'Signing in',
                            'Your session, kept in local storage if you choose "Remember me" or in session storage (this tab only) if you don\'t; when you were last active (on the main site, sessions unused for 30 days are signed out); a sign-in or invite in progress.',
                            <><Key>dreamstream_auth_token</Key> <Key>dreamstream_auth_persist</Key> <Key>dreamstream_last_active_at</Key> <Key>ds.pendingSignIn</Key> <Key>ds.postLoginNext</Key> <Key>ds_pending_invite_code</Key></>
                        ],
                        [
                            'This device',
                            'A random ID for this browser (for the devices list in Settings), and which account the data on this device belongs to.',
                            <><Key>dreamstream_device_id</Key> <Key>ds.localDataOwner</Key></>
                        ],
                        [
                            'Preferences',
                            'Theme, layout, reader and studio settings, tours you\'ve seen, dismissed notices.',
                            <><Key>ds.theme.v1</Key> <Key>dreamstream_settings</Key> <Key>comicstudio.reader.prefs.v1</Key> <Key>ds-live-appearance</Key> <Key>ds-live-theme</Key></>
                        ],
                        [
                            'Your own API keys',
                            'Keys you add for AI or image providers, and the address and any access token of MCP servers you add (in Settings or Chat Studio\'s tools), kept in local storage on this device. If you\'re signed in, a copy of a provider key is also stored with your account, encrypted, so the key works on your other devices (see the Privacy Policy). MCP servers stay on this device: the ones you turn on in a chat are sent, token included, with that chat\'s requests so our server can call them.',
                            <><Key>dreamstream_api_keys_v2</Key> <Key>dreamstream_openrouter_key</Key> <Key>dreamstream_flux_key</Key> <Key>dreamstream_mcp_servers</Key></>
                        ],
                        [
                            'Your work',
                            'Projects, guest projects, caches that make the studios fast and work offline, Chat Studio conversations and memory, kept in IndexedDB and local storage.',
                            <><Key>dreamstream_local_cache</Key> <Key>dreamstream_comic_studio</Key> <Key>dreamstream_chat</Key> <Key>dreamstream_chat_memory</Key></>
                        ],
                        [
                            'Diagnostics',
                            'A random ID for this visit, in session storage, so error reports from one visit can be grouped. It is deleted when you close the tab.',
                            <Key>ds_telemetry_session_id</Key>
                        ],
                        [
                            'Registering interest',
                            'A note, in session storage, that registering interest isn\'t available right now, so the form stays hidden instead of failing again. It holds no email address and is deleted when you close the tab.',
                            <Key>ds.interest.unavailable</Key>
                        ],
                        [
                            'Stream Studio',
                            'Your display name and settings, the host keys of events you created, recordings in progress and not yet saved (written to the browser\'s private file storage as you record), the name you used as a viewer, nursery and alert settings, the tracker\'s offline queue, usage counts, call settings, and a welcome ticket while you sign up.',
                            <><Key>ds-live-owner</Key> <Key>ds-live-prefs</Key> <Key>ds-live-my-events</Key> <Key>ds-live-my-recordings</Key> <Key>ds-live-unsaved-recordings</Key> <Key>ds-live-viewer-name</Key> <Key>ds-live-welcome-ticket</Key> <Key>ds-monitor-device</Key> <Key>ds-call-ring</Key></>
                        ],
                        [
                            'Baby monitor encryption',
                            'This browser\'s device keys for the baby monitor\'s end-to-end encryption, kept in IndexedDB as keys that scripts can use but cannot read out.',
                            <Key>ds-keys</Key>
                        ],
                        [
                            'Saving recordings',
                            'The folder you picked for saving recordings on a computer (so you aren\'t asked every time), kept in IndexedDB.',
                            <Key>ds-live-save</Key>
                        ],
                        [
                            'Alerts and calls with the app closed',
                            'A service worker for Stream Studio that receives baby-monitor alerts and call rings, and a small cache it uses to remember that you signed out.',
                            <Key>/live-sw.js</Key>
                        ]
                    ]}
                />
                <p>Names in the table are the actual keys; some features add a few more of the same kind (for example one entry per nursery).</p>
            </>
        )
    },
    {
        id: 'third-parties',
        title: 'Services from other companies',
        content: (
            <>
                <p>Your browser loads these straight from other companies' servers, not through ours. When it does, it sends them your IP address and browser details, and they handle that under their own policies:</p>
                <ul className={LIST}>
                    {BROWSER_THIRD_PARTIES.map((p) => (
                        <li key={p.name}>
                            <strong>{p.name}</strong>
                            {p.hosts[0] !== '*' && <> ({p.hosts.join(', ')})</>}: {p.when} {p.receives}
                        </li>
                    ))}
                </ul>
                <p>The <DocLink to="subprocessors" /> page lists these too, with the services our servers use.</p>
                <p>Our hosting provider, Cloudflare, may also set strictly necessary security cookies of its own to protect our sites from attacks.</p>
            </>
        )
    },
    {
        id: 'emails',
        title: 'Emails',
        content: (
            <p>Emails our server sends contain a tiny image that tells us when the email is first opened. Sign-in links, sign-up confirmations, password-reset emails and the email that asks you to confirm updates or an interest registration never do. You can stop it by blocking images in your email app. The <DocLink to="privacy" hash="emails">Privacy Policy</DocLink> has the details.</p>
        )
    },
    {
        id: 'your-choices',
        title: 'Your choices',
        content: (
            <>
                <ul className={LIST}>
                    <li><strong>Sign out.</strong> Signing out of Stream Studio, or of DreamStream, removes your Stream Studio account data from that device (your display name and settings, your events' host keys, nursery data, call settings and the name you used as a viewer) and ends its alert subscription. Recordings you made but haven't saved stay on the device until you save or discard them, and only the account that made them is offered them. Your preferences (theme, camera lens, tours seen) stay.</li>
                    <li><strong>Clear site data.</strong> Your browser's settings can remove everything our sites store. You'll be signed out, and work that hasn't been saved to your account, such as guest projects and unsaved recordings, is lost. API keys you added while signed in stay stored with your account; keys added while signed out are lost.</li>
                    <li><strong>Block storage.</strong> If you block site storage, signing in and most features won't work.</li>
                </ul>
                <Callout>
                    <p>Because everything we store is needed for the Service to work, or is something you chose to keep, we don't show a cookie banner. If we ever add third-party analytics or advertising, we will ask first where the law requires it, and update this page.</p>
                </Callout>
                <p>Questions: <MailLink email={PRIVACY_EMAIL} />.</p>
            </>
        )
    }
];

const intro = (
    <p>This notice explains what DreamStream's sites and apps store in your browser and why, the services from other companies our pages load, and how to clear it. It applies to dreamstreamstudio.ai, stream.dreamstreamstudio.ai and comics.dreamstreamstudio.ai.</p>
);

export const CookiesNotice: React.FC<LegalPageProps> = ({ onBack, onOpenDoc, onHistoryBack }) => (
    <LegalDocument doc="cookies" intro={intro} sections={sections} onBack={onBack} onOpenDoc={onOpenDoc} onHistoryBack={onHistoryBack} />
);
