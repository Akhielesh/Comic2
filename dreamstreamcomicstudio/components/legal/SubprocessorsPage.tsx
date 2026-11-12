import React from 'react';
import { Callout, DataTable, DocLink, LINK, LIST, LegalDocument, MailLink, type LegalSection } from './LegalDocument';
import { ASSISTANT_SCRIPT_PREVIEW_CHARS, BROWSER_THIRD_PARTIES, DATABASE_REGION_LABEL, DIRECT_AI_PROVIDERS, MEMORY_NOTE_MODEL, PRIVACY_EMAIL } from './legalFacts';
import type { LegalPageProps } from './LegalDocument';

// Subprocessors: every third party that receives personal information when DreamStream runs,
// derived from the code and configuration (the legal suite's claims ledger cites each row).

export interface Subprocessor {
    name: string;
    purpose: string;
    data: string;
    where: string;
}

const PROVIDER_LOCATION = 'Where the provider operates';

export const CORE: Subprocessor[] = [
    {
        name: 'Cloudflare',
        purpose: 'Hosts our sites and servers: the website, our API and the backend it runs, Stream Studio\'s real-time rooms, storage for live-stream replays and 7-day copies, the encrypted relay for calls and meetings, the STUN service that helps devices connect directly, email sending, bot protection (Turnstile) and the cdnjs library mirror.',
        data: 'Everything sent to or from the Service, including IP addresses and browser details; Stream Studio room data (events and chat, nursery history and tracker entries, call lists and settings); replays and 7-day copies; email addresses and the emails we send. Its STUN service sees your IP address when your devices set up a call, meeting or monitor connection.',
        where: 'Cloudflare\'s global network'
    },
    {
        name: 'Supabase',
        purpose: 'Accounts and sign-in, our database, and file storage for Comic Studio images.',
        data: 'Account and profile data, the IP address and browser details of every request your browser makes to it (signing in, loading and saving your data, and every Comic Studio image, shared comics included), projects and images, synced chats and memory notes, API keys you add (encrypted), encrypted connected-account tokens and indexes, Stream Studio accounts and nurseries, notifications, email sign-ups and delivery records, diagnostics, chat usage events and feedback.',
        where: DATABASE_REGION_LABEL
    },
    {
        name: 'Google Fonts',
        purpose: 'Serves the typefaces our pages use.',
        data: 'Your IP address and browser details when a page loads its fonts.',
        where: PROVIDER_LOCATION
    }
];

export const AI_PROVIDERS: Subprocessor[] = [
    {
        name: 'OpenRouter',
        purpose: `Our AI gateway. On Auto, and whenever you pick a model it serves, it passes the request to the company that runs the model. The site-wide assistant always runs through it, and Chat Studio's memory notes are written through it (today by ${MEMORY_NOTE_MODEL.label}) unless you picked another provider under Settings → API & Models.`,
        data: `What a request needs: your prompt and conversation, attached files, memory notes, your approximate location, timezone and language, items from connected accounts included in it, and Comic Studio project content. For the site-wide assistant: what you type, the page you're on and, if you're signed in, your username, masked email, plan and a summary of your Comic Studio projects, plus, for the project you have open, its story overview, the first ${ASSISTANT_SCRIPT_PREVIEW_CHARS} characters of its script and its style, layout and cover prompts.`,
        where: 'OpenRouter, and the model provider it routes to'
    },
    {
        name: 'Google (Gemini API)',
        purpose: 'Text, image and vision models for Comic Studio and Chat Studio, and making memory notes searchable and searching them.',
        data: 'The same request content as above when a Gemini model does the work; the text of each memory note; and the text of each Chat Studio message you send while signed in (to search your memory notes), whichever model answers it.',
        where: PROVIDER_LOCATION
    },
    {
        name: DIRECT_AI_PROVIDERS.filter((p) => p !== 'Google (Gemini)').join(', '),
        purpose: "Answer Chat Studio requests directly when you choose one of their models. NVIDIA also does Comic Studio's writing steps (script analysis, story outlines and drafts, world and panel breakdowns, continuity checks) when you pick it under Settings → API & Models, or when no OpenRouter key is available.",
        data: 'The request content described above.',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Ideogram, Pixazo (Flux)',
        purpose: 'Image generation when you choose these image models.',
        data: 'Your image prompt and settings.',
        where: PROVIDER_LOCATION
    }
];

export const TOOL_SERVICES: Subprocessor[] = [
    {
        name: 'Web search: SearXNG (public instances such as searx.be), Tavily, Brave Search, Serper, Google Programmable Search, DuckDuckGo, Bing, Wikipedia',
        purpose: 'Search the web for Chat Studio answers.',
        data: 'The search query the AI writes, which can include details from your conversation or connected accounts.',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Reading pages: the website itself, or Jina Reader',
        purpose: 'Fetch a page the AI wants to read; Jina Reader is used when a page can\'t be read directly.',
        data: 'The page address.',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Maps and places: OpenStreetMap (Nominatim, Overpass), FOSSGIS routing, Foursquare, Google Maps',
        purpose: 'Find places and addresses and plan routes.',
        data: 'The place, address or route you ask about, or your location (approximate, or precise if you shared it) when you search for places near you.',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Weather: MET Norway, Open-Meteo',
        purpose: 'Forecasts and conditions.',
        data: 'The location asked about (a city or coordinates).',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Approximate location: ip-api.com; IP lookups: IPinfo, ip-api.com',
        purpose: 'ip-api.com turns your IP address into an approximate city when you use Chat Studio without sharing your location; its free service is reached over plain HTTP, not HTTPS. IPinfo (or ip-api.com) answers questions about an IP address or domain you ask about.',
        data: 'Your IP address (approximate location); the IP address or domain you ask about (lookups).',
        where: PROVIDER_LOCATION
    },
    {
        name: 'News, markets and economic data: for example Google News, Yahoo Finance, Stooq, Alpaca, Finnhub (when enabled), CoinGecko, Binance, OKX, DefiLlama, Polymarket, Manifold, CNN and alternative.me (market sentiment), FRED (Federal Reserve Bank of St. Louis), the US Treasury, the CFTC, Frankfurter, and similar public sources',
        purpose: 'Headlines, prices, market and economic data, prediction markets and exchange rates.',
        data: 'The topic, ticker, market or currency asked about; for news, also your country and language.',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Knowledge and open data: for example Wikipedia, Open Library, arXiv, NASA, USGS, TheMealDB, TheCocktailDB, GitHub, npm, PyPI, Hacker News, TVmaze, Hugging Face, and similar public sources',
        purpose: 'Facts, books, science, recipes, developer and entertainment lookups. A few of these free services are reached over plain HTTP, not HTTPS.',
        data: 'The lookup the AI writes.',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Names: agify, genderize, nationalize',
        purpose: 'Statistical guesses of the age, gender and nationality associated with a first name, when you ask about a name.',
        data: 'The first name asked about.',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Travel: Amadeus (when enabled)',
        purpose: 'Flight search.',
        data: 'The route, dates and number of travellers asked about.',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Reference services: Context7, DeepWiki; MCP servers you add (including those from the catalog in Chat Studio)',
        purpose: 'Documentation lookups, and any tools you connect yourself.',
        data: 'The request the AI writes. MCP servers you add receive whatever the AI sends them, under your control.',
        where: PROVIDER_LOCATION
    }
];

/** What people's browsers load straight from other companies (components/legal/legalFacts.ts). */
export const BROWSER_SERVICES: Subprocessor[] = BROWSER_THIRD_PARTIES.map((p) => ({
    name: p.hosts[0] === '*' ? p.name : `${p.name} (${p.hosts.join(', ')})`,
    purpose: p.when,
    data: `Your IP address and browser details. ${p.receives}`,
    where: p.hosts[0] === '*' ? 'The website the image comes from' : PROVIDER_LOCATION
}));

export const OTHER_SERVICES: Subprocessor[] = [
    {
        name: 'Google APIs (Gmail, Google Drive, Google Calendar, Google Sheets, YouTube)',
        purpose: 'Only when you connect a Google account: read the data you allowed, make calendar changes you confirm, and receive recordings you save to Drive (uploaded straight from your browser).',
        data: 'Your access tokens and the requests made for you.',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Pwned Passwords (Have I Been Pwned)',
        purpose: 'Checks a new password against known data breaches at sign-up.',
        data: 'Only the first five characters of a one-way (SHA-1) hash of the password, never the password.',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Browser push services (for example Apple, Google and Mozilla)',
        purpose: 'Deliver baby-monitor alerts and call rings to your device when you turn alerts on.',
        data: 'Your browser\'s push address and the alert, encrypted so only your browser can read it.',
        where: 'Your browser maker\'s push service'
    }
];

export const NOT_IN_USE: Subprocessor[] = [
    {
        name: 'Stripe',
        purpose: 'Would process payments if paid plans were switched on.',
        data: 'Nothing today: billing is switched off.',
        where: 'Not in use'
    },
    {
        name: 'Railway',
        purpose: 'A stand-by host for our backend.',
        data: 'Nothing today: the backend runs on Cloudflare.',
        where: 'Not in use'
    }
];

const table = (caption: string, rows: Subprocessor[]) => (
    <DataTable caption={caption} head={['Provider', 'What it does for DreamStream', 'Personal information it receives', 'Where']} rows={rows.map((r) => [r.name, r.purpose, r.data, r.where])} />
);

const sections: LegalSection[] = [
    {
        id: 'running-the-service',
        title: 'Running the Service',
        content: table('Infrastructure providers', CORE)
    },
    {
        id: 'ai-models',
        title: 'AI models',
        content: (
            <>
                <p>Which provider receives a request depends on the model: Auto picks one for you, or you choose. Requests made with your own API key go to that provider under your own account.</p>
                {table('AI model providers', AI_PROVIDERS)}
                <p>Each provider handles requests under its own terms, including how long it keeps them. DreamStream does not train AI models of its own on your content.</p>
            </>
        )
    },
    {
        id: 'chat-tools',
        title: 'Chat Studio tools',
        content: (
            <>
                <p>While answering in Chat Studio, the AI can use tools that contact the services below. Our server sends these requests. They contain what the AI writes for that request, plus your location (approximate, or precise if you shared it) when you search for places near you, and your country and language for news; the approximate-location lookup receives your IP address. Maps, images, logos, QR codes and code previews in an answer are loaded by your browser instead: see <a href="#loaded-by-your-browser" className={LINK}>Loaded by your browser</a>.</p>
                {table('Chat Studio tool services', TOOL_SERVICES)}
            </>
        )
    },
    {
        id: 'loaded-by-your-browser',
        title: 'Loaded by your browser',
        content: (
            <>
                <p>Some services are contacted by your browser itself, not by our servers, when a page or a feature needs them. Each one sees your IP address and browser details, plus what the table says. The <DocLink to="cookies" /> notice lists them too.</p>
                {table('Services your browser loads', BROWSER_SERVICES)}
            </>
        )
    },
    {
        id: 'accounts-and-delivery',
        title: 'Connected accounts, security and alerts',
        content: table('Other services', OTHER_SERVICES)
    },
    {
        id: 'not-in-use',
        title: 'Set up but not in use',
        content: table('Services not currently in use', NOT_IN_USE)
    },
    {
        id: 'changes',
        title: 'Changes to this list',
        content: (
            <>
                <ul className={LIST}>
                    <li>This list describes the Service as of the date at the top. The tools available in Chat Studio change more often than the rest; when we add a provider that receives personal information, we update this page.</li>
                    <li>How each provider is used, and what you can do about it, is explained in the <DocLink to="privacy" />.</li>
                </ul>
                <Callout>
                    <p>Questions about a provider, or want to know more about how your information reaches one? Email <MailLink email={PRIVACY_EMAIL} />.</p>
                </Callout>
            </>
        )
    }
];

const intro = (
    <p>The companies and services that receive personal information when DreamStream runs, what each one does for us, what it receives, and where. Atlas Studio is covered by its own policy.</p>
);

export const SubprocessorsPage: React.FC<LegalPageProps> = ({ onBack, onOpenDoc, onHistoryBack }) => (
    <LegalDocument doc="subprocessors" intro={intro} sections={sections} onBack={onBack} onOpenDoc={onOpenDoc} onHistoryBack={onHistoryBack} />
);
