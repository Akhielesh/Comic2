import React from 'react';
import { Callout, DataTable, DocLink, ExternalLink, LINK, LIST, LegalDocument, MailLink, SubHeading, type LegalSection } from './legal/LegalDocument';
import {
    ASSISTANT_SCRIPT_PREVIEW_CHARS,
    ATLAS_GOOGLE_USER_DATA_URL,
    COMIC_PG_CEILING_UNDER_AGE,
    CONFIRM_EMAIL_LIMITS,
    CONFIRM_LINK_DAYS,
    COVERED_SITES,
    DATABASE_REGION_LABEL,
    DIRECT_AI_PROVIDERS,
    EVENT_ROOM_KEPT,
    GOOGLE_CONNECTIONS_URL,
    GOOGLE_PRIVACY_POLICY_URL,
    GOOGLE_SECURITY_PERMISSIONS_URL,
    GOOGLE_USER_DATA_POLICY_URL,
    MEMORY_IMPORT_MAX_CHARS,
    MEMORY_IMPORT_MAX_ENTRIES,
    MEMORY_NOTE_MODEL,
    MEMORY_SEARCH_MAX_CHARS,
    MIN_SIGNUP_AGE_YEARS,
    OPERATOR_NAME,
    PEOPLE_SEARCH,
    PRIVACY_EMAIL,
    QUICK_FINDER,
    RECENT_CALLS_KEPT,
    RETENTION,
    SECURITY_ADVISORY_URL,
    SECURITY_EMAIL,
    SECURITY_SUBJECT,
    SECURITY_TXT_URL,
    SUPPORT_EMAIL
} from './legal/legalFacts';
import type { LegalPageProps } from './legal/LegalDocument';

// Privacy Policy. Every statement here describes what the code does today; the tests in
// components/legal/ and PrivacyPolicy.googleUserData.test.tsx tie the key ones to the code, and
// the legal suite's claims ledger cites the rest. The #google-user-data section is what Google's
// OAuth verification reads: keep its anchor and its Limited Use statements exactly as they are.

const PrivacyEmail: React.FC = () => <MailLink email={PRIVACY_EMAIL} />;

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

const googleUserData = (
    <>
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
                    <ExternalLink href={GOOGLE_PRIVACY_POLICY_URL}>Google Privacy Policy</ExternalLink>. By connecting YouTube you also agree to the YouTube Terms of Service (see our{' '}
                    <DocLink to="terms" hash="youtube">Terms of Service</DocLink>). You can revoke DreamStream's access to your YouTube data at any time from your{' '}
                    <ExternalLink href={GOOGLE_SECURITY_PERMISSIONS_URL}>Google security settings</ExternalLink>.</p>
            </Service>
        </ul>
        <p className="text-sm text-[var(--ds-muted)]">Google Maps lookups use an API key (DreamStream's, or one you add), not your Google account; the place or address you search for is sent to Google Maps.</p>

        <SubHeading>How we use it</SubHeading>
        <p>We use Google user data only to provide the features you use and can see in DreamStream: showing your email, files, agenda, spreadsheets and videos; answering your questions about them in chat and in the quick-finder; suggesting follow-up questions after an answer; keeping the memory notes that personalize your later chats (described under AI processing); preparing calendar changes for you to confirm; and saving your recordings to Drive. We do not sell Google user data, and we do not use it for advertising, including personalized, retargeted or interest-based ads, or to determine creditworthiness or for lending. DreamStream does not use Google user data to train AI models of its own.</p>

        <SubHeading>AI processing</SubHeading>
        <p>When you ask Chat Studio something that involves a connected account, the relevant items are included in the request to the AI model that writes the answer: for example the sender, subject, date and preview of matching emails, the events in your agenda, file names, or the spreadsheet rows you asked about. Chat Studio can also include a few matching items from your connected accounts as background for a message you send, and so can the quick-finder (the Explain, Summarize and similar actions offered when you select text on a page, described under AI processing). This information is sent to generate the response you asked for. After each answer, the last few messages of the conversation, including the answer, are also sent to an AI model, through the provider your chat uses, to suggest follow-up questions (shown under the answer as "You might ask"). Details from a connected account that appear in those messages are included.</p>
        <p>On Auto, DreamStream picks the model and sends the request through OpenRouter, our AI gateway, which passes it to the company that runs that model (for example Anthropic, Google or OpenAI). You can choose a specific model or provider in Chat Studio instead. Depending on your choice, the request goes through OpenRouter to that model's provider, or directly to OpenAI, Anthropic, Google (Gemini), xAI, DeepSeek, Z.AI, MiniMax, Tencent (Hunyuan) or NVIDIA. If you add your own API key for a provider, requests that use it run under your own account with that provider.</p>
        <p>While writing an answer, the model can also use tools that contact other services. It writes those requests itself, so a request can include details from a connected account: asked what the company in your latest email does, for example, it may search the web for that company's name. These services are web search (such as Tavily, Brave Search, Serper, Google Programmable Search, SearXNG, DuckDuckGo, Bing and Wikipedia), the websites whose pages it reads (directly, or through the Jina Reader service when a page can't be read directly), maps, weather, news and similar lookups, image generation, the Context7 and DeepWiki reference services, and any MCP servers you add in Chat Studio. The model makes these requests only to answer the message you sent.</p>
        <p>When you're signed in, Chat Studio also keeps memory notes automatically: short facts about you, written from your conversations (the quick-finder's included) so later chats can be personalized. The notes can include details from a connected account. To write them, the latest messages of a conversation, including the answer, are sent to an AI model in two ways: after an answer (at most once every five minutes), through the provider that answered it, with the same key, which can be your own; and from Chat Studio, through the provider you picked under Settings → API &amp; Models or, if you haven't picked one, OpenRouter. Through OpenRouter the model is one DreamStream picks, today {MEMORY_NOTE_MODEL.label}, or {MEMORY_NOTE_MODEL.fallbackLabel} when that one is unavailable. The notes are saved to your DreamStream account, and the text of each note is sent to Google's Gemini API to make it searchable. To find the notes closest to what you ask, the text of each message you send in Chat Studio or through the quick-finder while signed in (up to the first {MEMORY_SEARCH_MAX_CHARS.toLocaleString('en-US')} characters) is also sent to Google's Gemini API before the answer is written, whichever model or provider you chose, even when you have no saved notes. Your memory notes are then included in every request Chat Studio sends to the AI model in your later chats, not only the ones they relate to: the full list shown in Settings → Memory in Chat Studio, plus up to eight of the notes saved to your account (the ones closest to your message, or the most recent). You can edit or remove notes in that list, but removing a note there does not delete the copy saved to your account, and memory cannot yet be turned off in the app. You can also import memories from another AI tool (ChatGPT, Claude, Gemini or another) into that list. Your browser sends text you paste or a text file you upload as it is, up to its first {MEMORY_IMPORT_MAX_CHARS.toLocaleString('en-US')} characters. From JSON, such as ChatGPT's or Claude's conversations file, it sends the text it finds in memory and instruction entries, in messages the file marks as yours, and in other fields such as "text" or "content" that the file doesn't mark as the assistant's, but not messages the file marks as the assistant's: the first {MEMORY_IMPORT_MAX_ENTRIES} pieces of text it finds, up to {MEMORY_IMPORT_MAX_CHARS.toLocaleString('en-US')} characters. So an assistant's reply in a file that doesn't say who wrote what can be sent, and a JSON file in which it finds none of that, such as a Google Takeout activity file, is sent as it is, assistant replies included, up to its first {MEMORY_IMPORT_MAX_CHARS.toLocaleString('en-US')} characters. That is sent with the list to an AI model, the same way as the notes written from Chat Studio, to merge the two, and the merged list replaces yours only if you accept it. To see, delete or turn off the memory saved to your account, email <PrivacyEmail />. Once it is turned off, no notes are added to it, the notes in it are no longer sent with your requests, and your messages are no longer sent to Gemini to search them. If our server can't read that setting at the moment of a request (a temporary error), it handles the request as if memory were on. Turning it off doesn't stop the list in Settings → Memory in Chat Studio: Chat Studio still sends the latest messages to an AI model to write notes into that list, and the list is kept in your browser, synced to your account when you're signed in, and sent with your requests. After an answer, the latest messages are also still sent to an AI model to write notes for the memory on your account, but what it writes is not saved.</p>

        <SubHeading>Who we share it with</SubHeading>
        <p>We do not transfer Google user data to advertising platforms, data brokers or information resellers. We transfer it only:</p>
        <ul className={LIST}>
            <li>to the service providers that run DreamStream: Cloudflare, which hosts our website and the servers that handle your connected accounts; Supabase, our database, which stores your connections, encrypted tokens and the indexes described above, plus your memory notes and any chats saved to your account; and the AI providers described under AI processing, which receive it to generate the response you asked for, suggest follow-up questions, and write, index and search your memory notes;</li>
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
            <li>Data travels between your browser, our servers, Google and the AI providers over encrypted HTTPS connections.</li>
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
    </>
);

const sections: LegalSection[] = [
    {
        id: 'who-we-are',
        title: 'Who we are and what this policy covers',
        content: (
            <>
                <p>{OPERATOR_NAME} ("DreamStream", "we", "our" or "us") runs Comic Studio, Chat Studio and Stream Studio at {COVERED_SITES.join(', ')}. DreamStream is responsible for the personal information described in this policy.</p>
                <p>This policy applies to everyone whose information we handle: people with a DreamStream account; people who join a Stream Studio event, meeting or baby-monitor link without one; people who sign up for updates or register interest in a studio; and people someone invites to DreamStream by email. Atlas Studio (atlas.dreamstreamstudio.ai) has <ExternalLink href={ATLAS_GOOGLE_USER_DATA_URL}>its own privacy policy</ExternalLink>.</p>
            </>
        )
    },
    {
        id: 'information-we-collect',
        title: 'Information we collect',
        content: (
            <>
                <SubHeading id="account-data">Your account</SubHeading>
                <ul className={LIST}>
                    <li><strong>Account and profile data:</strong> your email address, username, first name, last name (optional), phone number (optional), date of birth (required), Stream Studio display name, and avatar if you add one.</li>
                    <li><strong>Password:</strong> when you create an account, your password travels to our server over an encrypted connection so we can check it against known data breaches (only the first five characters of a one-way hash of it leave our server, to the Pwned Passwords service), and it is stored by our authentication provider, Supabase, in hashed form.</li>
                    <li><strong>Consent and preferences:</strong> whether you accepted the Terms and this policy at sign-up (we store a yes/no, not which version or when), whether you agreed to marketing, and your email preferences.</li>
                    <li><strong>Devices:</strong> on the main site, a list of the browsers you've signed in from (a random device ID kept in your browser, a name such as "Mac · Chrome", the browser's user-agent string and when it was last seen), so you can review them in Settings. Our sign-in provider, Supabase, also records the IP address and browser of each sign-in session, and keeps a log of sign-in events with the IP address they came from.</li>
                    <li><strong>API keys you add:</strong> if you add your own key for an AI or image provider while you're signed in, it is stored with your account, encrypted with AES-256-GCM, so it works on all your devices. Our servers use it for your requests to that provider. Deleting the key in Settings removes the stored copy.</li>
                </ul>

                <SubHeading>What you create and share</SubHeading>
                <ul className={LIST}>
                    <li><strong>Comic Studio:</strong> projects, scripts, prompts, story and character notes, reference images you upload, generated pages and images, lettering, translations, versions and publication settings.</li>
                    <li><strong>Chat Studio:</strong> your conversations (kept in your browser, and synced to your account when you're signed in), memory notes (including memories you import from another AI tool), files you attach, custom agents and recipes you create, and MCP servers you add.</li>
                    <li><strong>Community:</strong> your public profile, comments, likes, follows, reviews and views of public projects, and the in-app notifications they create (for example who followed you, or liked or commented on your work, and whether you've read it).</li>
                    <li><strong>Connected Google accounts:</strong> the data described in <a href="#google-user-data" className={LINK}>Google User Data</a>.</li>
                    <li><strong>Stream Studio:</strong> described in its own section, <a href="#stream-studio" className={LINK}>Stream Studio, the baby monitor and calls</a>.</li>
                </ul>

                <SubHeading>When you contact us or report something</SubHeading>
                <ul className={LIST}>
                    <li><strong>Support:</strong> the messages you email us and anything you include in them. The Contact form in Settings sends our database the email address you enter, your message, a phone number if you add one, and your account, so we can reply by email.</li>
                    <li><strong>Feedback:</strong> feedback you give in the app (for example a thumbs up or down, a category and a comment). When a message you send to the site-wide assistant sounds frustrated or negative, that message is also saved automatically, as feedback and in our diagnostics log (with the details listed under Diagnostics).</li>
                    <li><strong>Reports:</strong> if you report a shared comic, the reason, any note and page you add, your account if you're signed in, and a salted hash of your IP address that changes every day, used only to spot duplicate reports (never the IP address itself).</li>
                </ul>

                <SubHeading>Information created as you use the Service</SubHeading>
                <ul className={LIST}>
                    <li><strong>Usage and cost records:</strong> which AI features and models your account used, when, and what they cost us, so usage allowances can be applied.</li>
                    <li><strong>Safety records:</strong> Comic Studio's automated safety checks record the category and decision of each check, a one-way fingerprint and its cost, never the text or image that was checked. We also keep the moderation status of accounts and the outcome of reports and appeals.</li>
                    <li><strong>Diagnostics and usage events:</strong> error reports from the app (what went wrong and where, with a random ID for that visit), and a usage event for each Chat Studio answer (which model and tools it used, how long it took and how long the answer was; never the text of your message or the answer). They are linked to your account if you're signed in, and stored with the page you were on, your IP address and your browser's user-agent string. Feedback is stored the same way.</li>
                    <li><strong>Request data:</strong> our servers and hosting provider handle your IP address, browser user agent and the address you request to deliver pages, block abuse and limit request rates.</li>
                    <li><strong>Approximate location:</strong> when you use Chat Studio and your browser hasn't shared its location, our server looks up an approximate city and rough coordinates for your IP address through the ip-api.com service, whose free service is reached over plain HTTP rather than HTTPS. That location, with your timezone and language, is included in each request to the AI model so that questions like "weather near me" work (see AI processing). It is also sent to the place-search services (Foursquare or OpenStreetMap) when you ask for places near you, and your country and language go to the news service for local headlines. Your precise location is used instead only if you allow it in your browser.</li>
                    <li><strong>Bot protection:</strong> on the main site, sign-in, sign-up and some forms use Cloudflare Turnstile, which checks signals from your browser to tell people from bots. Stream Studio uses it for password resets and resending emails; its sign-up uses a welcome code instead.</li>
                    <li><strong>Automated visitors:</strong> if an AI agent or automated browser asks for one of our pages, it is redirected to a check-in page, and the visit (IP address, user agent, country, network and some request headers) is logged in an analytics database that the operator of DreamStream also uses for other websites.</li>
                    <li><strong>On your device:</strong> the <DocLink to="cookies" /> notice lists what the apps store in your browser.</li>
                </ul>
                <p>DreamStream does not take payments today, so we hold no payment card or billing details.</p>
            </>
        )
    },
    {
        id: 'stream-studio',
        title: 'Stream Studio, the baby monitor and calls',
        content: (
            <>
                <SubHeading>Live streams and meetings</SubHeading>
                <ul className={LIST}>
                    <li><strong>Stream Studio live-event data:</strong> event titles, schedules, host and viewer display names, RSVP/lobby status, chat messages, reactions, moderation actions, stream status, recording metadata, replay segment references, and private host/guest capability-link state needed to run the event.</li>
                    <li>Viewers and guests join with just a name and are never asked for an account or their age. A live stream's video passes through our servers to its viewers, and replay segments are stored for about {RETENTION.replayHours} hours after the stream ends. Meetings and calls connect device to device where networks allow; otherwise an encrypted relay forwards them.</li>
                    <li><strong>Connecting devices:</strong> to set up a call, meeting, stream or baby-monitor connection, your browser asks STUN servers run by Cloudflare and Google for its public IP address, so they receive your IP address.</li>
                    <li><strong>What an event keeps:</strong> the event's chat (the last {EVENT_ROOM_KEPT.chatMessages} messages), the names of viewers and guests who joined or chatted, RSVP names, and an activity and moderation log (the last {EVENT_ROOM_KEPT.logEntries} entries). These stay with the event: there is no way to delete an event in the app today (see How long we keep information).</li>
                    <li><strong>Recordings</strong> are made on the host's own device. A host can save them to their device, share them, save them to Google Drive, or choose a 7-day cloud copy that is stored on our servers and deleted after about {RETENTION.cloudCopyDays} days. Stream Studio does not currently show viewers or guests that a host is recording.</li>
                </ul>

                <SubHeading>Baby monitor</SubHeading>
                <ul className={LIST}>
                    <li><strong>Nursery details:</strong> the nursery's name, your baby's name, and (if you add them) your baby's birth date and sex, the zones you draw, the people you add with their roles and labels, and your cameras' device names.</li>
                    <li><strong>Live video and sound are never recorded.</strong> They go device to device, end-to-end encrypted, wherever the network allows. For a moment while a connection starts, when a network blocks direct video, or when the camera is full, they pass through our server instead, in memory only and never stored, and we don't treat that path as end-to-end encrypted. Privacy pause stops the picture for everyone.</li>
                    <li><strong>Detection happens on the camera phone.</strong> Sound detection (Google's YAMNet model plus our own cry and alarm analysers) and smart vision (Google MediaPipe models) run on the phone itself; the audio and frames they analyse never leave it.</li>
                    <li><strong>What our servers keep:</strong> alerts and events (what was detected, when, by which camera, for how long, with what confidence and sound level), incidents and who responded, a minute-by-minute summary of the baby's state and the room's sound level, and sleep sessions. The weekly comparison in the app is calculated from these when you look at it; it isn't stored separately.</li>
                    <li><strong>Share links:</strong> the guest's name, when they last watched, and the passcode in scrambled form only. Your IP address is used to slow down repeated wrong passcodes.</li>
                </ul>

                <SubHeading>Baby tracker</SubHeading>
                <p>Entries you or your family log: breastfeeding (side and minutes), bottles, solids, pumping, diapers (including stool colour), sleep, growth (weight, length, head size), medicine, temperature, activities and notes, with who logged each one. Everyone in the nursery sees them. This can be health information about your child and, for breastfeeding and pumping, about you; we use it only to show the tracker to you and the people you share the nursery with.</p>

                <SubHeading>Calls</SubHeading>
                <ul className={LIST}>
                    <li>Who called whom, when, for how long and missed calls (your recent-calls list keeps the last {RECENT_CALLS_KEPT}), your favourites, the people you blocked, and your "Who can call you" setting.</li>
                    <li>Call audio and video go device to device, encrypted, or through an encrypted relay when a network blocks direct links. Calls are never recorded.</li>
                </ul>

                <SubHeading>Finding people</SubHeading>
                <p>Your Stream Studio display name can be found by any signed-in Stream Studio member who types {PEOPLE_SEARCH.minLetters} or more letters of it (up to {PEOPLE_SEARCH.maxResults} results at a time). Search results show display names only, never email addresses. There is no setting to hide from this search today. Unless you change "Who can call you" to only the people in your nurseries, anyone who finds you can call you; you can decline and block them.</p>

                <SubHeading>Alerts and usage</SubHeading>
                <ul className={LIST}>
                    <li><strong>Alerts on this device:</strong> if you turn them on, your browser gives us a push subscription (an address at your browser maker's push service, such as Apple's, Google's or Mozilla's) and keys. Alert contents are encrypted so only your browser can read them. Signing out removes the subscription from that device.</li>
                    <li><strong>Usage:</strong> how many minutes went which way (on your Wi-Fi, direct, relayed or through our server) and how much relay data and storage were used, per device and per nursery, so the app can show you what's free and apply fair-use allowances.</li>
                </ul>
            </>
        )
    },
    {
        id: 'emails',
        title: 'Emails, updates and interest registrations',
        content: (
            <>
                <ul className={LIST}>
                    <li><strong>Account and service emails:</strong> sign-up confirmations, sign-in links, password resets, security notices, invitations and welcome messages, and service announcements our team writes and sends by hand (for example about a change to the Service or to these documents). We send these when you need them, even if you opted out of marketing, and they have no unsubscribe link. An announcement can go to any address we have, including one that only signed up for updates, registered interest or asked for early access and later unsubscribed.</li>
                    <li><strong>Updates and interest registrations (double opt-in):</strong> if you sign up for updates or register interest in a studio, we store your email address, the studios you pick, the page you signed up from and any note you add (up to 1,000 characters). We then email you a confirmation link (none while our record of the emails we send can't be read; registering again once it can sends it), and no updates until you press Confirm (service announcements, above, can still reach the address). If the address is registered again, by you or by anyone who types it in, we send the confirmation email again, at most once every {CONFIRM_EMAIL_LIMITS.minIntervalMinutes} minutes and {CONFIRM_EMAIL_LIMITS.maxPerDay} times in any 24 hours. A link stops working {CONFIRM_LINK_DAYS} days after we first sent it, even when a later email carries it again. With the registration we also store whether you have confirmed; when you first registered, when we last sent you a confirmation email and when you confirmed; and the signed one-time code in your link, which we delete when you confirm or unsubscribe. If you already get updates and pick more studios, the new picks are kept apart and only added when you press Confirm in a new confirmation email. The registration itself stores no IP address, device details or account ID. Every update includes an unsubscribe link, which opens a page with an Unsubscribe button (so a mail scanner that opens links can't unsubscribe you by mistake); email apps with their own Unsubscribe button do it in one click.</li>
                    <li><strong>Early access requests:</strong> if you ask for early access, we store your email address, the studios or features you pick, any note you add (up to 1,000 characters), the page you signed up from and when you asked. When our server handles the request, it first checks whether your address already has an account, a pending invitation or an earlier request, so we can point you to sign-in, re-send your invitation or tell you you're already on the list; otherwise it usually emails you to confirm we received it: at most one such email a day to one address, counting the +tag and Gmail dot spellings of an address as the same address, and none while that day's or month's allowance for these emails is used up. If our server can't be reached, has an error or is too busy (for example while it starts up, or after many requests from one network), your browser saves the request directly instead, without that email or check.</li>
                    <li><strong>Unsubscribing</strong> stops updates and records when you unsubscribed. For updates and interest registrations it also deletes, at once, your studio picks (including any still waiting for your confirmation), your note and any unused confirmation link; an early-access request keeps its details, with the unsubscribe time added. Your address goes on a suppression list, which we keep so that we don't email you marketing again, unless you sign up and confirm again.</li>
                    <li><strong>Invitations you send:</strong> if you invite someone, we store their email address, who invited them and how many times, to send the invitation and avoid repeats.</li>
                    <li><strong>Delivery records:</strong> for every email our backend sends, we record the address, which email it was, whether it was sent (and if not, why, with any error message), when, the message ID our email provider gives it, an ID for the request that caused it, and the account it relates to, if any: yours when the email is about your account, or the sender's for an invitation or an email our team sends.</li>
                    <li><strong>Open tracking:</strong> emails our server sends contain a tiny image that tells us when the email is first opened, and we store that time with the delivery record. Sign-in links, sign-up confirmations, password-reset emails and the email that asks you to confirm updates or an interest registration never contain it. Blocking images in your email app prevents it.</li>
                </ul>
                <p>To stop marketing emails, use the unsubscribe link in any of them. The email preferences in Settings are saved with your account, but they don't yet change which emails we send. To have your sign-up, interest registration or early-access request deleted, email <PrivacyEmail />.</p>
            </>
        )
    },
    {
        id: 'how-we-use',
        title: 'How we use information',
        content: (
            <ul className={LIST}>
                <li>To create and run your account, sign you in, and keep the studios, your projects, chats and nurseries working across your devices.</li>
                <li>To do what you ask: generate text, images and pages, answer in chat, deliver streams, calls and alerts, save recordings and show the tracker.</li>
                <li>To share what you choose to share: published comics, public profiles, comments and nursery access.</li>
                <li>To keep people and the Service safe: bot protection, rate limits, safety checks, handling reports, investigating abuse, and enforcing our <DocLink to="terms" /> and <DocLink to="acceptable-use" />.</li>
                <li>To apply usage allowances and understand what the Service costs to run.</li>
                <li>To find and fix bugs and improve how the Service works.</li>
                <li>To send account and service emails, and updates you asked for.</li>
                <li>To meet legal obligations and respond to lawful requests.</li>
            </ul>
        )
    },
    {
        id: 'legal-bases',
        title: 'Legal bases (EEA, UK and similar laws)',
        content: (
            <>
                <p>Where laws such as the GDPR or UK GDPR apply, we rely on these legal bases:</p>
                <DataTable
                    caption="Legal bases for processing"
                    head={['Legal basis', 'What it covers']}
                    rows={[
                        ['Performing our contract with you', 'Running your account and the studios, doing what you ask, Stream Studio, connected accounts you choose to connect, and account emails; and steps you ask for before you have an account: an early-access request, its receipt email and the check for an existing account or invitation.'],
                        ['Legitimate interests', 'Security, bot protection, rate limits, safety checks and abuse investigations; diagnostics, chat usage events and fixing bugs; automatically saving assistant messages that sound frustrated as feedback and in diagnostics; usage allowances and cost control; approximate location for Chat Studio answers; logging automated visitors. We balance these against your rights, and you can object (see Your rights).'],
                        ['Consent', 'Updates and marketing emails, precise location if you allow it in your browser, and alerts on your device. You can withdraw consent at any time; that doesn\'t affect what happened before.'],
                        ['Legal obligation', 'Keeping records and responding to requests where the law requires it.']
                    ]}
                />
                <p>Baby tracker entries can be health information. We use them only to provide the tracker to you and your nursery's members. The tracker does not yet ask for separate, explicit consent before the first entry.</p>
            </>
        )
    },
    {
        id: 'ai-processing',
        title: 'AI processing',
        content: (
            <>
                <p>When you use generation features, relevant request data (for example prompts, selected model, and any reference images you submit) is sent to AI model providers to produce output.</p>
                <ul className={LIST}>
                    <li><strong>Comic Studio:</strong> the parts of your project a task needs, such as your prompts, script, story and character notes, reference images, and pages to check or translate, are sent to the model that does the work: Google's Gemini API, NVIDIA, or a model reached through OpenRouter, depending on the provider you picked under Settings → API &amp; Models and the keys available. In the classic editor and Page Studio, which older projects open in, an image step that uses no reference images can also go to Ideogram: when the Gemini image models fail, or when settings saved earlier chose an Ideogram model, and only with your own Ideogram key or an account that has access to it.</li>
                    <li><strong>Chat Studio:</strong> your messages, files you attach, memory notes, your approximate location (the city and rough coordinates looked up from your IP address, unless your browser shared a precise one), your timezone and language and, if you connected accounts, the items described in <a href="#google-user-data" className={LINK}>Google User Data</a>, are sent through OpenRouter or directly to the provider you choose: {DIRECT_AI_PROVIDERS.join(', ')}. While you're signed in, each message you send is also sent to Google's Gemini API to search your memory notes, whichever provider you choose (unless memory is turned off for your account), and the latest messages are sent to write memory notes, and memories you import from another AI tool to merge them into your list, as described under <a href="#google-user-data" className={LINK}>Google User Data</a> (AI processing). Image requests can also go to Ideogram or a Flux image service (Pixazo).</li>
                    <li><strong>The quick-finder:</strong> when you select text on a page while signed in and pick Explain, Define, What is this?, Summarize or Translate, the selected text (up to the first {QUICK_FINDER.selectionChars.toLocaleString('en-US')} characters) is sent to Chat Studio's AI with the same details about your timezone, language and approximate location as a Chat Studio message, through the provider you picked under Settings → API &amp; Models or, if you haven't picked one, OpenRouter. It works on every page of the main site and the Comic Studio site except the sign-in pages and shared or public comic pages: in Comic Studio, Page Studio, Settings, the legal pages and Chat Studio too. It is not in Stream Studio. It is handled like a Chat Studio message: it is sent to Google's Gemini API to search your memory notes, matching items from connected accounts can be added as background, and it can be used to write memory notes. Add to calendar and Ask the chat open Chat Studio with the text instead.</li>
                    <li><strong>The site-wide assistant:</strong> the floating assistant is also AI, whether or not you're signed in. It appears on the main site and on the Comic Studio site (comics.dreamstreamstudio.ai): on the home page, your comics, the legal pages, Settings, the classic editor and Page Studio that older projects open in, and other pages. It is not in Chat Studio, the current Comic Studio or shared comic pages, and its button is hidden in the comic reader. What you type to it, the conversation so far and the page you're on and, if you're signed in, your username, a masked form of your email address, your plan and usage, and a summary of your Comic Studio projects (names, counts and progress) are sent through OpenRouter to the model it picks: a free model, unless you added your own OpenRouter key. If you're signed in, it also sends, for the project you have open (or opened last), that project's story overview, the first {ASSISTANT_SCRIPT_PREVIEW_CHARS} characters of its script, its style, layout and cover prompts, and how far its generation has got.</li>
                    <li><strong>Your own keys:</strong> requests made with your own API key run under your account with that provider.</li>
                    <li><strong>Safety checks</strong> on Comic Studio content run on DreamStream's own provider account.</li>
                    <li><strong>On-device AI:</strong> Stream Studio's sound detection and smart vision run on the camera phone; nothing they analyse is sent to us or to an AI provider.</li>
                </ul>
                <p><strong>Training.</strong> DreamStream does not use your content to train AI models of its own. Providers receive requests under their own terms, and whether and how long a provider keeps a request, or uses it to improve its services, depends on that provider and the model or route used. Free models in particular may keep what they receive and learn from it, that is, use it to train or improve their models. The site-wide assistant picks a free model first, and other features can use one when you pick it or when DreamStream picks the model for you. The <DocLink to="subprocessors" /> page links each one.</p>
            </>
        )
    },
    {
        id: 'google-user-data',
        title: 'Google User Data (Connected Google Accounts)',
        content: googleUserData
    },
    {
        id: 'sharing',
        title: 'Who we share information with',
        content: (
            <>
                <p>We do not sell personal information, and we do not share it for cross-context behavioural or targeted advertising. There are no third-party advertising or analytics trackers in our apps. We share information only:</p>
                <ul className={LIST}>
                    <li><strong>With service providers</strong> that run parts of the Service for us: hosting, database and storage, email delivery, bot protection, AI models and the tools Chat Studio uses. The <DocLink to="subprocessors" /> page lists each one, what it receives and why.</li>
                    <li><strong>With other people, when you choose:</strong> readers of comics you publish, viewers and guests of your events, members of your nurseries, people you call, and anyone you share a link with.</li>
                    <li><strong>With services you connect or direct us to:</strong> Google (when you connect it or save to Drive), MCP servers you add, and websites the AI reads for you.</li>
                    <li><strong>For safety and the law:</strong> when we believe in good faith it is necessary to comply with the law or a valid legal request, to protect someone from harm, to report child sexual abuse material to the authorities where the law requires, or to investigate abuse and security problems.</li>
                    <li><strong>In a business transfer:</strong> if DreamStream is reorganised, merged or sold, information may pass to the new owner under this policy (Google user data only with your explicit prior consent, as described above).</li>
                </ul>
            </>
        )
    },
    {
        id: 'public',
        title: 'What other people can see',
        content: (
            <ul className={LIST}>
                <li>Projects are private unless you mark them public or publish them: other people can't find or open a private project. The images in your projects (generated pages and images, and reference photos uploaded with earlier versions of Comic Studio) are stored at long, unguessable web addresses, though, and anyone who has one of those addresses can open that image without signing in, even if the project is private. Public projects, published comics, your profile (username and avatar), comments, likes, follows and view counts can be seen by others. An unlisted share link works for anyone who has it.</li>
                <li>Stream Studio viewer links are intended for people with the link. Private studio, guest, and recap links may grant control or private access; treat them like passwords and share them only with trusted collaborators.</li>
                <li>Your email address is not shown on your profile or in search results. It isn't fully private, though: today, someone who knows your username can find out the email address that goes with it, and anyone who enters your email address in the early-access form is told whether it already has a DreamStream account or a pending invitation, or is already on the early-access list. (The form for updates and interest registrations gives the same answer for every address.)</li>
                <li>Your Stream Studio display name can be found by other members, as described above. Members of a nursery see its live picture, alerts, history and tracker, and who else is a member.</li>
                <li>A viewer's name and chat messages are seen by the host and the other people in the event.</li>
            </ul>
        )
    },
    {
        id: 'cookies',
        title: 'Cookies and device storage',
        content: (
            <p>Our own code doesn't set cookies. The apps keep your sign-in, preferences, caches, unsaved work and Stream Studio settings in your browser's storage. Your browser also loads some things straight from other companies: Supabase, our database and sign-in provider (signing in, loading and saving your data, and every Comic Studio image, including the pages of a comic someone shared with you), Cloudflare Turnstile, Google Fonts and, on the main site, two PDF libraries from Cloudflare's cdnjs; in Chat Studio, map tiles (CARTO), weather radar (RainViewer), site icons (Google), market logos (Parqet, Financial Modeling Prep), QR codes (goQR), the Python runtime (jsDelivr), code previews (CodeSandbox), videos (YouTube, Vimeo) and images from the websites they come from; and in Stream Studio, STUN servers (Cloudflare, Google) and Google Drive uploads. Each sees your IP address and browser details. There are no third-party advertising or analytics trackers. The <DocLink to="cookies" /> notice lists everything and how to clear it.</p>
        )
    },
    {
        id: 'retention',
        title: 'How long we keep information',
        content: (
            <>
                <DataTable
                    caption="Retention periods"
                    head={['Information', 'How long']}
                    rows={[
                        ['Account and profile', 'Until your account is deleted (on request, by email).'],
                        ['API keys you add (stored encrypted)', 'Until you delete the key in Settings or your account is deleted.'],
                        ['Sign-in sessions and sign-in log (IP address and browser), kept by Supabase', 'Sessions until you sign out or your account is deleted; the sign-in log under Supabase\'s own retention.'],
                        ['In-app notifications', 'Until your account is deleted.'],
                        ['Comic projects, uploads and generated images', `Until you delete them or your account. Stored images that no project uses any more are marked to expire after about ${RETENTION.imageUnusedDays} days unused and become due for removal about ${RETENTION.imageExpiryGraceDays} days later.`],
                        ['Chats', 'In your browser until you delete them; the copy synced to your account until you delete the chat or your account.'],
                        ['Memory notes', 'Until you ask us to delete them.'],
                        ['Connected accounts and their indexes', 'Until you disconnect or your account is deleted.'],
                        ['Live stream replays', `About ${RETENTION.replayHours} hours after the stream ends.`],
                        ['Live-event details (title, schedule, chat, viewer and guest names, RSVPs, activity and moderation log)', 'Kept with the event, which can\'t be deleted in the app today; it is not removed automatically, even when the host\'s account is deleted. Email us to have an event erased.'],
                        ['7-day cloud copies of recordings', `About ${RETENTION.cloudCopyDays} days. If deleting fails, our servers keep retrying for up to ${RETENTION.recordingSweepGraceDays} more days.`],
                        ['Baby monitor history', `Alerts, events and incidents ${RETENTION.monitorEventsDays} days; minute-by-minute summaries ${RETENTION.monitorMinutesDays} days; sleep sessions ${RETENTION.monitorSleepDays} days. Older entries are removed on a rolling basis while the nursery is in use.`],
                        ['Baby tracker entries', `About ${RETENTION.trackerYears} years, removed on a rolling basis while the nursery is in use. Entries you delete are removed from storage about ${RETENTION.trackerDeletedDays} days later.`],
                        ['A deleted nursery', 'Everyone loses access at once. Its stored history and tracker entries are not erased automatically at that moment; email us to have them erased.'],
                        ['Recent calls', `Your last ${RECENT_CALLS_KEPT} calls.`],
                        ['Alert subscriptions', 'Until you turn alerts off, sign out on that device, or your browser ends the subscription.'],
                        ['Comic Studio safety records', `Check records ${RETENTION.safetyEventsDays} days; closed reports and appeals ${RETENTION.closedSafetyCasesDays} days after they close; quarantined items ${RETENTION.quarantineDays} days.`],
                        ['Image-generation call logs', `${RETENTION.imageCallLogDays} days.`],
                        ['Devices list', `Until you remove a device or your account is deleted (Settings shows those seen in the last ${RETENTION.deviceActiveDays} days).`],
                        ['Diagnostics, chat usage events and feedback (with IP address and user agent)', 'Not deleted automatically today; email us to have yours deleted.'],
                        ['Messages sent with the Contact form in Settings', 'Not deleted automatically today; email us to have yours deleted.'],
                        ['Email delivery records and open times', 'Not deleted automatically today.'],
                        ['Invitations you send (the invitee\'s address, who invited them and how many times)', 'Not deleted automatically today; email us to have one removed.'],
                        ['Usage and cost records', 'Not deleted automatically today.'],
                        ['Update sign-ups and interest registrations', `Until you ask us to delete them. A confirmation link stops working ${CONFIRM_LINK_DAYS} days after we first sent it. Unsubscribing deletes their studio picks and note at once, and keeps a record of the opt-out so it is respected.`],
                        ['Early-access requests', 'Until you ask us to delete them. Unsubscribing adds the time you unsubscribed and keeps the request.'],
                        ['Welcome-code attempts (a hashed IP address and the time)', 'Not deleted automatically today.'],
                        ['Automated-visitor log', 'No automatic deletion is set up.']
                    ]}
                />
                <p>When information is deleted, copies may remain for a limited time in backups kept by our infrastructure providers, and anything others already saved (a downloaded comic or recording) stays with them.</p>
            </>
        )
    },
    {
        id: 'security',
        title: 'Security',
        content: (
            <>
                <ul className={LIST}>
                    <li>Traffic between your browser and our sites is encrypted (HTTPS), and our sites tell browsers to use HTTPS only. Our servers reach other services over HTTPS too, except a few free services that only offer plain HTTP: the approximate-location lookup (ip-api.com, which receives your IP address) and some of Chat Studio's public-data lookups, and websites the AI reads that are only available over plain HTTP.</li>
                    <li>Row-level security is switched on for every table our apps can reach, which limits what each signed-in account can read and change.</li>
                    <li>Google tokens, and API keys you store with your account, are encrypted with AES-256-GCM before they are stored.</li>
                    <li>Passwords chosen at sign-up are checked against known data breaches without the password itself leaving our server.</li>
                    <li>Bot protection and rate limits guard sign-in, sign-up, forms, share-link passcodes and welcome codes.</li>
                    <li>The baby monitor uses end-to-end encryption for device-to-device video and sound wherever the network allows, with keys our servers can't read.</li>
                    <li>Share-link passcodes are stored only in scrambled form.</li>
                </ul>
                <p>No system is perfectly secure. Protect your password and devices, and treat private Stream Studio links like passwords. If we learn of a breach that affects your personal information, we will notify you and the authorities where the law requires.</p>
                <p><strong>Found a security problem?</strong> Please tell us privately: email <MailLink email={SECURITY_EMAIL} subject={SECURITY_SUBJECT} /> or use our <ExternalLink href={SECURITY_ADVISORY_URL}>private security advisory form</ExternalLink>. Our <ExternalLink href={SECURITY_TXT_URL}>security.txt</ExternalLink> has the details.</p>
            </>
        )
    },
    {
        id: 'your-rights',
        title: 'Your choices and rights',
        content: (
            <>
                <SubHeading>In the app</SubHeading>
                <ul className={LIST}>
                    <li>Edit your profile in Settings, and unsubscribe from any update with the link in it.</li>
                    <li>Delete projects, chats and comments; unpublish a comic.</li>
                    <li>Disconnect a Google account (Chat Studio → Settings → Connectors).</li>
                    <li>In Stream Studio: choose who can call you, block people, remove people from a nursery, use privacy pause, delete a nursery, and download monitor history and tracker entries as CSV files.</li>
                    <li>Sign out: on Stream Studio, and when you sign out of DreamStream, your Stream Studio account data on that device is removed (the <DocLink to="cookies" hash="your-choices">Cookies &amp; Local Storage notice</DocLink> lists what stays). Recordings you made but haven't saved stay on the device until you save or delete them, with a note of the account each was made for. Each is offered only to the account its studio was opened for; one made while no one was signed in is offered to anyone who opens Stream Studio on that device. An earlier version of Stream Studio kept no such note, so a recording made with it, also in a tab still running it, belongs to no account: one this version finds on that version's list is offered to anyone who opens Stream Studio on that device, as that version offered it, and one that version had already stopped listing is offered to no one. So is any other recording whose account can't be told. Someone signed in there with another account sees only how many of your unsaved recordings there are and how much space they use, and can delete them; anyone there sees the same for recordings offered to no one.</li>
                </ul>
                <SubHeading>Your rights</SubHeading>
                <p>Depending on where you live, you may have the right to: access the personal information we hold about you and get a copy; correct it; delete it; receive it in a portable format; object to or restrict how we use it; withdraw consent; and not be treated differently for using these rights. Residents of US states with privacy laws can also ask what we collect and why, and appeal a decision we make on their request. We don't sell personal information or use it for targeted advertising, so there is nothing to opt out of there.</p>
                <SubHeading>How to make a request</SubHeading>
                <ul className={LIST}>
                    <li>Email <PrivacyEmail /> from the email address on your account (or tell us how to reach you if you don't have one). There is no self-service download or account deletion in the app yet; we handle requests by hand.</li>
                    <li>We may need to confirm it's you before acting. Someone you authorise can make a request for you if they can show they have your permission.</li>
                    <li>We respond within the time the law that applies to you sets (for example, one month under the GDPR and 45 days under the California Consumer Privacy Act), and we tell you if we need longer and why.</li>
                    <li>If you're in the EEA or the UK, you can also complain to your data protection authority.</li>
                </ul>
            </>
        )
    },
    {
        id: 'children',
        title: 'Children',
        content: (
            <>
                <p>The sign-up form accepts people aged {MIN_SIGNUP_AGE_YEARS} and over, based on the date of birth they enter. We do not run a separate process to get a parent's consent before a child under 13 creates an account. Accounts whose date of birth shows an age under {COMIC_PG_CEILING_UNDER_AGE} are held to a PG content limit in Comic Studio. Stream Studio viewers and guests are not asked their age.</p>
                <p>If you are a parent or guardian and believe your child has given us personal information without your consent, email <PrivacyEmail />. We will review it and delete the account and its information where appropriate.</p>
                <p>Information parents enter about their own baby in the baby monitor and tracker is covered in <a href="#stream-studio" className={LINK}>Stream Studio, the baby monitor and calls</a>.</p>
            </>
        )
    },
    {
        id: 'international',
        title: 'Where information is processed',
        content: (
            <p>Our database is hosted by Supabase in {DATABASE_REGION_LABEL}. Cloudflare serves our sites, Stream Studio and email from its global network. AI providers and the services Chat Studio's tools use process requests in the countries where they operate. If you use DreamStream from outside the United States, your information will be transferred to and processed in the United States and those other countries, whose laws may differ from yours.</p>
        )
    },
    {
        id: 'changes',
        title: 'Changes to this policy',
        content: (
            <p>We update this policy when features, providers or data flows change, and change the date at the top. If a change is material, we will tell you in the product or by email before it takes effect.</p>
        )
    },
    {
        id: 'contact',
        title: 'Contact',
        content: (
            <ul className={LIST}>
                <li>Privacy questions and requests: <PrivacyEmail />.</li>
                <li>Anything else: <MailLink email={SUPPORT_EMAIL} />.</li>
            </ul>
        )
    }
];

const intro = (
    <>
        <p>This Privacy Policy explains what personal information DreamStream processes, why, who receives it, how long we keep it, and the controls and rights you have. It describes how the Service works today.</p>
        <p className="rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-4 py-3 text-sm">
            Connected a Google account (Gmail, Google Drive, Google Calendar, Google Sheets or YouTube)?{' '}
            <a href="#google-user-data" className={LINK}>Google User Data</a> explains what we access, how we use it, and how to remove it.
        </p>
    </>
);

const summary = (
    <Callout title="The short version">
        <ul className={LIST}>
            <li>We don't sell your information, and there are no third-party ad or analytics trackers in our apps.</li>
            <li>What you ask an AI to do is sent to the AI provider that does it; we don't train AI models of our own on your content.</li>
            <li>The baby monitor never records. Live video goes device to device where it can; detection runs on the camera phone.</li>
            <li>Other Stream Studio members can find you by display name and, by default, call you.</li>
            <li>To see, correct or delete your information, email <PrivacyEmail />.</li>
        </ul>
    </Callout>
);

export const PrivacyPolicy: React.FC<LegalPageProps> = ({ onBack, onOpenDoc, onHistoryBack }) => (
    <LegalDocument doc="privacy" intro={intro} summary={summary} sections={sections} onBack={onBack} onOpenDoc={onOpenDoc} onHistoryBack={onHistoryBack} />
);
