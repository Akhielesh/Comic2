import React, { useEffect } from 'react';

const PRIVACY_EMAIL = 'privacy@dreamstreamstudio.ai';
const GOOGLE_USER_DATA_POLICY_URL = 'https://developers.google.com/terms/api-services-user-data-policy';
const GOOGLE_CONNECTIONS_URL = 'https://myaccount.google.com/connections';
// Atlas Studio connects through the same Google apps (one consent screen for every studio), so this
// policy, which that consent screen links to, points at Atlas's own Google user data section.
const ATLAS_GOOGLE_USER_DATA_URL = 'https://atlas.dreamstreamstudio.ai/privacy#google-user-data';
const GOOGLE_PRIVACY_POLICY_URL = 'https://policies.google.com/privacy';

// Theme tokens only (--ds-*, see index.css) so the page reads in light and dark.
const LINK = 'font-medium text-[var(--ds-ink)] underline decoration-[var(--ds-accent)] underline-offset-2 hover:decoration-2';
const LIST = 'list-disc space-y-2 pl-5';

const ExternalLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
        {children}
    </a>
);

const PrivacyEmail: React.FC = () => (
    <a href={`mailto:${PRIVACY_EMAIL}`} className={LINK}>
        {PRIVACY_EMAIL}
    </a>
);

const Section: React.FC<{ id?: string; title: string; children: React.ReactNode }> = ({ id, title, children }) => (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="mt-10 scroll-mt-24 space-y-3">
        <h2 id={id ? `${id}-title` : undefined} className="text-lg font-semibold text-[var(--ds-ink)]">
            {title}
        </h2>
        {children}
    </section>
);

const SubHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <h3 className="pt-3 text-[15px] font-semibold text-[var(--ds-ink)]">{children}</h3>
);

const Scope: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <code className="whitespace-nowrap rounded bg-[var(--ds-well-strong)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--ds-ink)]">
        {children}
    </code>
);

const Service: React.FC<{ name: string; scopes: string[]; children: React.ReactNode }> = ({ name, scopes, children }) => (
    <li className="rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-4">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong>{name}</strong>
            {scopes.map((s) => (
                <Scope key={s}>{s}</Scope>
            ))}
        </p>
        <div className="mt-2 space-y-2">{children}</div>
    </li>
);

export const PrivacyPolicy: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    // The view mounts after the SPA boots, so the browser's own jump to a #fragment
    // (e.g. ?view=privacy#google-user-data) has already been missed. Do it here.
    useEffect(() => {
        const raw = window.location.hash.slice(1);
        if (!raw) return;
        // A mangled shared link (e.g. #%) must not take the whole page down.
        let id = raw;
        try {
            id = decodeURIComponent(raw);
        } catch {
            /* keep the raw fragment */
        }
        document.getElementById(id)?.scrollIntoView?.();
    }, []);

    return (
        <div className="min-h-screen bg-[var(--ds-canvas)] font-sans text-[var(--ds-ink)]">
            <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-12">
                <div className="mb-4 flex items-center justify-between gap-4">
                    <h1 className="font-display text-3xl text-[var(--ds-ink)]">Privacy Policy</h1>
                    <button
                        type="button"
                        onClick={onBack}
                        className="rounded-md px-2 py-1 text-xs font-bold text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
                    >
                        Back
                    </button>
                </div>
                <p className="mb-6 text-sm font-bold uppercase text-[var(--ds-muted)]">
                    Last Updated: <time dateTime="2026-11-04">November 4, 2026</time>
                </p>
                <div className="space-y-3 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-raised)] p-5 text-[15px] leading-relaxed shadow-sm sm:p-8">
                    <p>DreamStream Studio ("DreamStream", "we", "our", or "us") provides tools for private Stream Studio live events and AI-assisted creative workflows. This Privacy Policy explains what data we process, why we process it, how it moves through our APIs and providers, and what controls you have.</p>
                    <p className="rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-4 py-3 text-sm">
                        Connected a Google account (Gmail, Google Drive, Google Calendar, Google Sheets or YouTube)? Section 4,{' '}
                        <a href="#google-user-data" className={LINK}>Google User Data</a>, explains what we access, how we use it, and how to remove it.
                    </p>

                    <Section title="1. Information We Collect">
                        <ul className={LIST}>
                            <li><strong>Account and Profile Data:</strong> Email/login data from Supabase Auth, plus profile fields such as username, avatar, bio, and website.</li>
                            <li><strong>Consent Data:</strong> Terms acceptance and optional marketing consent values provided during signup.</li>
                            <li><strong>Creative and Project Data:</strong> Scripts, prompts, scene breakdowns, continuity data, generated images, project state, reviews, and comments.</li>
                            <li><strong>Stream Studio Live-Event Data:</strong> Event titles, schedules, host and viewer display names, RSVP/lobby status, chat messages, reactions, moderation actions, stream status, recording metadata, replay segment references, and private host/guest capability-link state needed to run the event.</li>
                            <li><strong>Community Data:</strong> Public profile data, follows, likes, views, notifications, and other social interactions tied to your account.</li>
                            <li><strong>Connected Google Account Data:</strong> If you connect a Google account, the data described in section 4 (Google User Data).</li>
                            <li><strong>Support Data:</strong> Contact/support messages you submit (for example, email and message body).</li>
                            <li><strong>Operational and Debug Data:</strong> Token ledger events, pricing snapshot metadata, provider/model timing metrics, error logs, and stored generation artifacts (which can include prompts and model responses).</li>
                            <li><strong>Billing Lifecycle Data:</strong> If paid billing is enabled for your account, subscription status, cancel-at-period-end flags, billing-period timestamps, webhook processing records, and overage capture metadata.</li>
                            <li><strong>Device-Stored Data:</strong> Browser local storage and IndexedDB records used for saved keys, guest projects, test runs/images, reader state, and learning progress.</li>
                        </ul>
                    </Section>

                    <Section title="2. How We Use Data">
                        <ul className={LIST}>
                            <li>To authenticate users, manage accounts, and provide profile/community features.</li>
                            <li>To run text/image/vision generation workflows you request and return results.</li>
                            <li>To operate Stream Studio live sessions, including event setup, viewer admission, chat/reactions, guest access, stream state, recordings, and replay windows.</li>
                            <li>To store projects, images, artifacts, and support interactions.</li>
                            <li>To enforce plan/usage limits, fraud-abuse controls, and operational safeguards.</li>
                            <li>To monitor reliability, troubleshoot issues, and improve core product behavior.</li>
                            <li>To send account, legal, billing, and support-related communications.</li>
                        </ul>
                        <p>Data from connected Google accounts is used only as described in section 4.</p>
                    </Section>

                    <Section title="3. AI Processing and Third Parties">
                        <p>When you use generation features, relevant request data (for example prompts, selected model, and any reference images you submit) may be sent to model providers to produce output.</p>
                        <ul className={LIST}>
                            <li><strong>Supabase:</strong> Authentication, database tables, and cloud storage.</li>
                            <li><strong>Cloudflare Workers, Durable Objects, and R2:</strong> Stream Studio live-event routing, room state, chat/lobby state, replay segment storage, and optional recording storage/retention.</li>
                            <li><strong>Google Gemini APIs:</strong> Text, image, and vision processing.</li>
                            <li><strong>OpenRouter and other AI model providers:</strong> Chat Studio responses. OpenRouter is our AI gateway: it passes each request to the company that runs the model you pick, or that Auto picks for you. Requests can also go directly to a provider you choose in Chat Studio. Section 4 explains how this applies to connected Google data.</li>
                            <li><strong>Search, lookup and reference services:</strong> While answering in Chat Studio, the AI model can use tools that contact other services, writing each request from your conversation: web search (such as Tavily, Brave Search, Serper, Google Programmable Search, SearXNG, DuckDuckGo, Bing and Wikipedia), the websites whose pages it reads (directly, or through the Jina Reader service when a page can't be read directly), maps, weather, news and similar lookups, image generation, the Context7 and DeepWiki reference services, and MCP servers you add.</li>
                            <li><strong>Pixazo Flux endpoint:</strong> Flux image generation requests.</li>
                            <li><strong>Stripe:</strong> Payment processing and tokenized payment-method storage for subscriptions, credit packs, and overage flows.</li>
                        </ul>
                        <p>These providers process data under their own terms and policies. We do not sell personal data.</p>
                    </Section>

                    <Section id="google-user-data" title="4. Google User Data (Connected Google Accounts)">
                        <p>In Chat Studio and Stream Studio you can connect your own Google account. You pick which Google services to connect, and Google asks for your permission before DreamStream can access anything. This section covers the information DreamStream receives from Google APIs ("Google user data") and applies in addition to the rest of this policy.</p>
                        <p><strong>Atlas Studio</strong> (atlas.dreamstreamstudio.ai), DreamStream's search workspace, connects to Google through the same DreamStream Studio Google apps. In its public beta it uses Sign in with Google (your name, email address and profile picture) and read-only access to Google Drive and Gmail (files, messages, attachments and labels) to index, search and preview them for you. Atlas Studio does not send Google user data to AI models, cannot change, send, draft or delete anything in your Google account, and follows the same Limited Use commitment below. Its full handling is described in the{' '}
                            <ExternalLink href={ATLAS_GOOGLE_USER_DATA_URL}>Atlas Studio Privacy Policy</ExternalLink>.</p>

                        <SubHeading>What we access, for each service</SubHeading>
                        <ul className="space-y-3">
                            <Service name="Every Google service you connect" scopes={['userinfo.email', 'userinfo.profile']}>
                                <p>Your Google account email address and name, so we can show which account is connected.</p>
                            </Service>
                            <Service name="Gmail (read-only)" scopes={['gmail.readonly']}>
                                <p>We keep an index of your messages' sender, subject, date, labels and Google's short preview text, so you can search and ask about your email in Chat Studio. When you open an email or a conversation, we fetch the full message (and any attachment you open) from Gmail at that moment to show it to you; message bodies and attachments are not saved in this index.</p>
                                <p>DreamStream cannot send, delete or change email. When you ask for a draft, DreamStream prepares it and gives you a link that opens it in Gmail, where you review and send it yourself.</p>
                            </Service>
                            <Service name="Google Drive (read-only)" scopes={['drive.readonly']}>
                                <p>We keep an index of your files' names, types, sizes, owners, last-modified dates and links, so you can find files from Chat Studio. DreamStream does not change or delete your Drive files.</p>
                            </Service>
                            <Service name="Google Drive: save recordings (Stream Studio)" scopes={['drive.file']}>
                                <p>Creates a "DreamStream Recordings" folder in your Drive and saves the Stream Studio recordings you choose to save there. With this permission DreamStream can see only the files and folder it created, never the rest of your Drive. Recording files upload from your browser directly to Google.</p>
                            </Service>
                            <Service name="Google Calendar" scopes={['calendar.events']}>
                                <p>Reads the events on your primary calendar (title, time, location, description, organizer, guests and your RSVP) to show your agenda and answer questions about your schedule, and keeps an index of events from 30 days ago onward.</p>
                                <p>DreamStream creates, edits or deletes an event, or RSVPs for you, only after you confirm it in the app. Google may email the event's guests about the change.</p>
                            </Service>
                            <Service name="Google Sheets (read-only)" scopes={['spreadsheets.readonly']}>
                                <p>Reads only the spreadsheet and range you ask about, when you ask. Sheet contents are not saved in our index.</p>
                            </Service>
                            <Service name="YouTube (read-only)" scopes={['youtube.readonly']}>
                                <p>We keep an index of your own channel's uploaded videos (title, description, publish date and thumbnail).</p>
                                <p>DreamStream uses YouTube API Services. Google's handling of your data is described in the{' '}
                                    <ExternalLink href={GOOGLE_PRIVACY_POLICY_URL}>Google Privacy Policy</ExternalLink>.</p>
                            </Service>
                        </ul>
                        <p className="text-sm text-[var(--ds-muted)]">Google Maps lookups use an API key (DreamStream's, or one you add), not your Google account; the place or address you search for is sent to Google Maps.</p>

                        <SubHeading>How we use it</SubHeading>
                        <p>We use Google user data only to provide the features you use and can see in DreamStream: showing your email, files, agenda, spreadsheets and videos; answering your questions about them in chat; suggesting follow-up questions after an answer; keeping the memory notes that personalize your later chats (described under AI processing); preparing calendar changes for you to confirm; and saving your recordings to Drive. We do not sell Google user data, and we do not use it for advertising, including personalized, retargeted or interest-based ads, or to determine creditworthiness or for lending.</p>

                        <SubHeading>AI processing</SubHeading>
                        <p>When you ask Chat Studio something that involves a connected account, the relevant items are included in the request to the AI model that writes the answer: for example the sender, subject, date and preview of matching emails, the events in your agenda, file names, or the spreadsheet rows you asked about. Chat can also include a few matching items from your connected accounts as background for a message you send. This information is sent to generate the response you asked for. After each answer, the last few messages of the conversation, including the answer, are also sent to an AI model, through the provider your chat uses, to suggest follow-up questions (shown under the answer as "You might ask"). Details from a connected account that appear in those messages are included.</p>
                        <p>On Auto, DreamStream picks the model and sends the request through OpenRouter, our AI gateway, which passes it to the company that runs that model (for example Anthropic, Google or OpenAI). You can choose a specific model or provider in Chat Studio instead. Depending on your choice, the request goes through OpenRouter to that model's provider, or directly to OpenAI, Anthropic, Google (Gemini), xAI, DeepSeek, Z.AI, MiniMax, Tencent (Hunyuan) or NVIDIA. If you add your own API key for a provider, requests that use it run under your own account with that provider.</p>
                        <p>While writing an answer, the model can also use tools that contact other services. It writes those requests itself, so a request can include details from a connected account: asked what the company in your latest email does, for example, it may search the web for that company's name. These services are web search (such as Tavily, Brave Search, Serper, Google Programmable Search, SearXNG, DuckDuckGo, Bing and Wikipedia), the websites whose pages it reads (directly, or through the Jina Reader service when a page can't be read directly), maps, weather, news and similar lookups, image generation, the Context7 and DeepWiki reference services, and any MCP servers you add in Chat Studio. The model makes these requests only to answer the message you sent.</p>
                        <p>When you're signed in, Chat Studio also keeps memory notes automatically: short facts about you, written from your conversations so later chats can be personalized. The notes can include details from a connected account. To write them, the latest messages of a conversation, including the answer, are sent to an AI model through the provider your chat uses. The notes are saved to your DreamStream account, and the text of each note is sent to Google's Gemini API to make it searchable. Your memory notes are then included in every request Chat Studio sends to the AI model in your later chats, not only the ones they relate to: the full list shown in Settings → Memory in Chat Studio, plus up to eight of the notes saved to your account (the ones closest to your message, or the most recent). You can edit or remove notes in that list, but removing a note there does not delete the copy saved to your account, and memory cannot yet be turned off in the app. To see, delete or turn off the memory saved to your account, email <PrivacyEmail />.</p>

                        <SubHeading>Who we share it with</SubHeading>
                        <p>We do not transfer Google user data to advertising platforms, data brokers or information resellers. We transfer it only:</p>
                        <ul className={LIST}>
                            <li>to the service providers that run DreamStream: Cloudflare, which hosts our website and the servers that handle your connected accounts; Supabase, our database, which stores your connections, encrypted tokens and the indexes described above, plus your memory notes and any chats saved to your account; and the AI providers described under AI processing, which receive it to generate the response you asked for, suggest follow-up questions, and write and index your memory notes;</li>
                            <li>to the services the AI model uses while answering you, described under AI processing: web search, the websites it reads and the page-reading service it uses, maps, weather, news and similar lookups, image generation, the Context7 and DeepWiki reference services, and MCP servers you add. They receive only the requests the model writes to answer your message;</li>
                            <li>when necessary for security purposes, such as investigating abuse;</li>
                            <li>to comply with applicable laws; or</li>
                            <li>as part of a merger, acquisition or sale of assets, only after obtaining your explicit prior consent.</li>
                        </ul>

                        <SubHeading>Who can read it</SubHeading>
                        <p>People at DreamStream do not read your Google user data unless you give us permission for specific items (for example, to help with a support request you send us), it is necessary for security purposes such as investigating abuse, or it is required to comply with applicable law.</p>

                        <SubHeading>How we protect it</SubHeading>
                        <ul className={LIST}>
                            <li>Google access and refresh tokens are encrypted with AES-256-GCM on our servers before they are stored. They are kept separately from your other data, and neither the tokens nor the encryption key are ever sent to your browser.</li>
                            <li>Connecting uses Google's OAuth with PKCE and a one-time state value, so an intercepted authorization code is useless to anyone else.</li>
                            <li>Your connected-account data is stored in database tables that only your own signed-in account and our servers can read, and every request our servers make for it is limited to your account.</li>
                            <li>Data travels over encrypted HTTPS connections.</li>
                            <li>We ask for read-only access wherever a feature only needs to read.</li>
                        </ul>

                        <SubHeading>How long we keep it, and how to remove it</SubHeading>
                        <ul className={LIST}>
                            <li>We keep a connection, its encrypted tokens and its index until you disconnect it or your DreamStream account is deleted.</li>
                            <li>To disconnect, open Chat Studio, go to Settings → Connectors and choose Disconnect. This deletes the connection, its encrypted tokens and every item indexed from it.</li>
                            <li>You can remove DreamStream's access from your Google Account at any time at{' '}
                                <ExternalLink href={GOOGLE_CONNECTIONS_URL}>myaccount.google.com/connections</ExternalLink>. After that DreamStream can no longer reach your Google data, and any connection still listed in DreamStream asks you to reconnect. Disconnect it in DreamStream as well to delete what we stored.</li>
                            <li>Disconnecting does not delete your chats or memory notes, which can include details from a connected account. Chats are kept in your browser and can also be synced to your DreamStream account; deleting a chat from the chat list removes both copies. Memory notes saved to your account stay until you ask us to delete them: email <PrivacyEmail /> (removing a note under Settings → Memory does not delete the saved copy).</li>
                            <li>To delete your DreamStream account, including every connection, token, index and memory note, email <PrivacyEmail />.</li>
                        </ul>

                        <SubHeading>Limited Use</SubHeading>
                        <div className="space-y-3 border-l-2 border-[var(--ds-accent)] pl-4">
                            <p>DreamStream Studio's use and transfer of information received from Google APIs to any other app will adhere to the{' '}
                                <ExternalLink href={GOOGLE_USER_DATA_POLICY_URL}>Google API Services User Data Policy</ExternalLink>, including the Limited Use requirements.</p>
                            <p>The use of information received from Google Workspace APIs will adhere to the{' '}
                                <ExternalLink href={GOOGLE_USER_DATA_POLICY_URL}>Google API Services User Data Policy</ExternalLink>, including the Limited Use requirements.</p>
                        </div>
                        <p>Questions about Google user data: <PrivacyEmail />.</p>
                    </Section>

                    <Section title="5. Keys and Security">
                        <ul className={LIST}>
                            <li>Data is transmitted over encrypted channels.</li>
                            <li>Bring-your-own API keys may be stored in browser local storage and sent to the backend in request headers for provider calls.</li>
                            <li>Flux keys can also be synced to the database in encrypted form; decryption occurs client-side after login.</li>
                            <li>Payment methods are stored as Stripe token references; DreamStream does not store raw card numbers.</li>
                            <li>Billing policy actions (for example cancellation scheduling, reactivation, credit checkout completion, and overage charge events) are logged for accounting/security auditability.</li>
                            <li>No client-side storage method is perfect. You are responsible for securing your device, rotating keys, and protecting account credentials.</li>
                        </ul>
                    </Section>

                    <Section title="6. Public vs Private Content">
                        <p>Projects are private unless you mark them public. Public projects, profile identifiers, comments, and engagement data (likes/views/follows) can be visible to other users.</p>
                        <p>Stream Studio viewer links are intended for people with the link. Private studio, guest, and recap links may grant control or private access; treat them like passwords and share them only with trusted collaborators.</p>
                    </Section>

                    <Section title="7. Cookies, Local Storage, and Device Data">
                        <p>The current app code relies on browser storage (localStorage/IndexedDB) for key settings, local caches, guest-mode data, and session-related client state. The codebase does not include third-party advertising trackers.</p>
                    </Section>

                    <Section title="8. Retention and Deletion">
                        <p>We keep account and project data while needed to operate the service and satisfy legal/security obligations. You can delete projects and some user content from the app; account deletion/support requests may be required for full removal workflows. Stream Studio replay segments are designed to expire after about 24 hours, and server-side recordings are designed to expire after about 7 days unless a newer product flow explicitly states otherwise. Certain logs may be retained where required for abuse prevention, accounting, or legal compliance.</p>
                        <p>Connected Google account data follows section 4.</p>
                    </Section>

                    <Section title="9. Children">
                        <p>The service is not intended for children under applicable legal age requirements. If you believe a child submitted personal data, email <PrivacyEmail /> for review/removal.</p>
                    </Section>

                    <Section title="10. International Processing">
                        <p>Depending on your location and selected providers, data may be processed in multiple countries where DreamStream and its processors operate infrastructure.</p>
                    </Section>

                    <Section title="11. Policy Updates">
                        <p>We may update this policy when features, processors, data flows, or legal requirements change. Material updates may be announced in-product.</p>
                    </Section>

                    <Section title="12. Contact">
                        <p>For privacy questions or deletion requests, email <PrivacyEmail />.</p>
                    </Section>

                    <Section title="Privacy FAQs">
                        <ul className={LIST}>
                            <li><strong>Do you sell my personal data?</strong> No.</li>
                            <li><strong>Do you train your own model on my private projects?</strong> Not by default in this product flow. Third-party model providers may process requests under their own terms.</li>
                            <li><strong>What is sent to AI providers?</strong> The request data needed to fulfill your action, such as prompts, selected model context, and any reference images you submit. If you've connected a Google account, section 4 explains which of its data can be included.</li>
                            <li><strong>Do you use my Gmail, Drive or Calendar data for ads?</strong> No. Connected Google data is used only for the features described in section 4.</li>
                            <li><strong>Where are my API keys stored?</strong> Keys can be stored in browser local storage; Flux keys may also be encrypted and synced to your account record for convenience.</li>
                            <li><strong>What billing data is stored?</strong> If paid billing is enabled for your account, DreamStream may store wallet balances, token usage events, subscription lifecycle state, and Stripe payment-method references required for billing operations.</li>
                            <li><strong>Can other users see my drafts?</strong> No, unless you intentionally make a project public.</li>
                            <li><strong>What data stays on my device?</strong> Local caches including key settings, guest projects, test runs/images, and reader/learning state can be stored in localStorage/IndexedDB.</li>
                            <li><strong>How do I delete my data?</strong> Delete content in-app where available, disconnect connected accounts in Chat Studio under Settings → Connectors, and email <PrivacyEmail /> to delete the memory saved to your account or for account-level or privacy deletion requests.</li>
                            <li><strong>Do you send marketing emails automatically?</strong> Marketing communication is optional and based on your signup consent choices.</li>
                        </ul>
                    </Section>
                </div>
            </main>
        </div>
    );
};
