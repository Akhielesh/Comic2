import React from 'react';
import { Callout, DataTable, DocLink, LIST, LegalDocument, MailLink, type LegalSection } from './LegalDocument';
import { DATABASE_REGION_LABEL, DIRECT_AI_PROVIDERS, PRIVACY_EMAIL } from './legalFacts';
import type { LegalDocId } from './legalRoutes';

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
        purpose: 'Hosts our sites and servers: the website, our API and the backend it runs, Stream Studio\'s real-time rooms, storage for live-stream replays and 7-day copies, the encrypted relay for calls and meetings, email sending, bot protection (Turnstile) and the cdnjs library mirror.',
        data: 'Everything sent to or from the Service, including IP addresses and browser details; Stream Studio room data (events and chat, nursery history and tracker entries, call lists and settings); replays and 7-day copies; email addresses and the emails we send.',
        where: 'Cloudflare\'s global network'
    },
    {
        name: 'Supabase',
        purpose: 'Accounts and sign-in, our database, and file storage for Comic Studio images.',
        data: 'Account and profile data, projects and images, synced chats and memory notes, encrypted connected-account tokens and indexes, Stream Studio accounts and nurseries, email sign-ups and delivery records, diagnostics and feedback.',
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
        purpose: 'Our AI gateway. On Auto, and whenever you pick a model it serves, it passes the request to the company that runs the model.',
        data: 'What a request needs: your prompt and conversation, attached files, memory notes, items from connected accounts included in it, and Comic Studio project content.',
        where: 'OpenRouter, and the model provider it routes to'
    },
    {
        name: 'Google (Gemini API)',
        purpose: 'Text, image and vision models for Comic Studio and Chat Studio, and making memory notes searchable.',
        data: 'The same request content as above when a Gemini model does the work, and the text of each memory note.',
        where: PROVIDER_LOCATION
    },
    {
        name: DIRECT_AI_PROVIDERS.filter((p) => p !== 'Google (Gemini)').join(', '),
        purpose: 'Answer Chat Studio requests directly when you choose one of their models.',
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
        data: 'The place, address or route you ask about.',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Weather: MET Norway, Open-Meteo',
        purpose: 'Forecasts and conditions.',
        data: 'The location asked about (a city or coordinates).',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Approximate location: ip-api.com; IP lookups: IPinfo',
        purpose: 'ip-api.com turns your IP address into an approximate city when you use Chat Studio without sharing your location. IPinfo answers questions about an IP address or domain you ask about.',
        data: 'Your IP address (ip-api.com); the IP address or domain you ask about (IPinfo).',
        where: PROVIDER_LOCATION
    },
    {
        name: 'News and finance: Google News, Yahoo Finance, Stooq, Alpaca, CoinGecko, Frankfurter',
        purpose: 'Headlines, prices and exchange rates.',
        data: 'The topic, ticker or currency asked about.',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Knowledge and open data: Wikipedia, Open Library, USGS, TheMealDB, TheCocktailDB, GitHub, npm, PyPI, Hacker News, TVmaze, Hugging Face and similar public sources',
        purpose: 'Facts, books, science, recipes, developer and entertainment lookups.',
        data: 'The lookup the AI writes.',
        where: PROVIDER_LOCATION
    },
    {
        name: 'Reference services: Context7, DeepWiki; MCP servers you add',
        purpose: 'Documentation lookups, and any tools you connect yourself.',
        data: 'The request the AI writes. MCP servers you add receive whatever the AI sends them, under your control.',
        where: PROVIDER_LOCATION
    }
];

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
                <p>While answering in Chat Studio, the AI can use tools that contact the services below. These requests are made by our server, not your browser, and contain only what the AI writes for that request (apart from ip-api.com, which receives your IP address).</p>
                {table('Chat Studio tool services', TOOL_SERVICES)}
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

export const SubprocessorsPage: React.FC<{ onBack: () => void; onOpenDoc?: (id: LegalDocId) => void }> = ({ onBack, onOpenDoc }) => (
    <LegalDocument doc="subprocessors" intro={intro} sections={sections} onBack={onBack} onOpenDoc={onOpenDoc} />
);
