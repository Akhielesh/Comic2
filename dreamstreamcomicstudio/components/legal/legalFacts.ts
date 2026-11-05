/**
 * The facts the legal pages state, in one place. Every value here mirrors something in the code or
 * the production configuration, and components/legal/legalFacts.test.ts reads that code and fails
 * when the two drift apart. Change the product first, then the fact, then the page.
 *
 * This file is not legal advice. Wording that needs an owner or counsel decision is tracked outside
 * the product (the legal suite's OWNER-DECISIONS list), never as placeholder text on a page.
 */

/** The date every legal page shows. Bump it with any material change to a page. */
export const LEGAL_LAST_UPDATED = { iso: '2026-11-05', label: 'November 5, 2026' } as const;

/** The trading name used on every page (the operator's legal form and address are an owner decision). */
export const OPERATOR_NAME = 'DreamStream Studio';
/** Short name the pages use after the first mention. */
export const OPERATOR_SHORT = 'DreamStream';

/** The sites these documents cover (shared/streamHost.ts, services/productHost.ts). */
export const COVERED_SITES = ['dreamstreamstudio.ai', 'stream.dreamstreamstudio.ai', 'comics.dreamstreamstudio.ai'] as const;

/**
 * Mailboxes on our own domain. support@ and privacy@ are the Cloudflare Email Routing addresses the
 * setup guide creates (docs/connectors/google-setup.md "Professional contact addresses"); support@
 * is also the Contact in public/.well-known/security.txt.
 */
export const SUPPORT_EMAIL = 'support@dreamstreamstudio.ai';
export const PRIVACY_EMAIL = 'privacy@dreamstreamstudio.ai';
/** Security reports go where security.txt sends them (a test keeps the two equal). */
export const SECURITY_EMAIL = SUPPORT_EMAIL;
/** The private advisory form security.txt lists as its second Contact. */
export const SECURITY_ADVISORY_URL = 'https://github.com/Akhielesh/Comic2/security/advisories/new';
export const SECURITY_TXT_URL = 'https://dreamstreamstudio.ai/.well-known/security.txt';
/** Subject lines that route a request to the right pile in the shared inbox. */
export const COPYRIGHT_SUBJECT = 'Copyright notice';
export const COUNTER_NOTICE_SUBJECT = 'Copyright counter-notice';
export const SECURITY_SUBJECT = 'Security report';
export const ABUSE_SUBJECT = 'Report abuse';

/** Third-party pages the documents link to. */
export const YOUTUBE_TERMS_URL = 'https://www.youtube.com/t/terms';
export const GOOGLE_PRIVACY_POLICY_URL = 'https://policies.google.com/privacy';
export const GOOGLE_USER_DATA_POLICY_URL = 'https://developers.google.com/terms/api-services-user-data-policy';
export const GOOGLE_CONNECTIONS_URL = 'https://myaccount.google.com/connections';
/** The revocation page YouTube API Services' developer policies name (III.A.2.i). */
export const GOOGLE_SECURITY_PERMISSIONS_URL = 'https://security.google.com/settings/security/permissions';
export const ATLAS_GOOGLE_USER_DATA_URL = 'https://atlas.dreamstreamstudio.ai/privacy#google-user-data';

/**
 * Sign-up age floor: components/AuthPage.tsx, server/src/routes/authEmail.ts and
 * live/components/AuthSheet.tsx all check it. Accounts under 13 get Comic Studio's PG ceiling
 * (server/src/comic/safety/index.ts accountCeilingFor).
 */
export const MIN_SIGNUP_AGE_YEARS = 8;
export const COMIC_PG_CEILING_UNDER_AGE = 13;

/** Where the database lives (Supabase project "Comic", region us-west-2). */
export const DATABASE_REGION_LABEL = 'the United States (US West, Oregon)';

/**
 * Retention the code enforces. Units are spelled in the name; tests convert the code's
 * milliseconds and SQL intervals and compare.
 */
export const RETENTION = {
  /** live/protocol.ts REPLAY_WINDOW_MS; live-worker/src/eventRoom.ts. */
  replayHours: 24,
  /** live/protocol.ts RECORDING_RETENTION_MS; live-worker/src/eventRoom.ts. */
  cloudCopyDays: 7,
  /** live-worker/src/eventRoom.ts SWEEP_GRACE_MS: retries before R2's lifecycle rule takes over. */
  recordingSweepGraceDays: 2,
  /** live-worker/src/cloudCopyQuota.ts CLOUD_COPY_LIMIT_BYTES (GiB). */
  cloudCopyLimitGb: 10,
  /** live-worker/src/monitorStore.ts RETAIN. */
  monitorEventsDays: 90,
  monitorIncidentsDays: 90,
  monitorMinutesDays: 31,
  monitorSleepDays: 400,
  /** live-worker/src/trackerStore.ts TRACK_RETAIN_MS (3 × 366 days). */
  trackerYears: 3,
  /** live-worker/src/trackerStore.ts purge(): entries someone deleted are soft-deleted, then removed. */
  trackerDeletedDays: 60,
  /** server/sql/comic_safety.sql purge_comic_safety_events (pg_cron, daily). */
  safetyEventsDays: 180,
  closedSafetyCasesDays: 365,
  quarantineDays: 120,
  /** server/sql/comic_image_calls.sql purge_comic_image_calls (pg_cron, daily). */
  imageCallLogDays: 180,
  /** run_image_asset_retention: refresh_image_asset_references(30, 15). */
  imageUnusedDays: 30,
  imageExpiryGraceDays: 15,
  /** services/deviceSessions.ts ACTIVE_WINDOW_DAYS: how long a device shows as active. */
  deviceActiveDays: 45
} as const;

/** shared/stream/usage.ts FAIR_USE: allowances, never charges. */
export const STREAM_FAIR_USE = {
  relayDataGbPerAccountMonth: 10,
  relayDataGbPerNurseryMonth: 10,
  serverPictureHoursPerNurseryDay: 16,
  cloudCopyGbRolling: 10
} as const;

/** live-worker/src/directCalls.ts DIRECT_LOG_CAP: calls kept in a member's recent-calls list. */
export const RECENT_CALLS_KEPT = 60;

/**
 * What a Stream Studio event's room keeps (live-worker/src/eventRoom.ts CHAT_CAP, RSVP_CAP, LOG_CAP).
 * The room's storage is never wiped: there is no way to delete an event today, and the retention
 * sweep only removes replays and 7-day copies ("The event and its links stay").
 */
export const EVENT_ROOM_KEPT = { chatMessages: 200, rsvpNames: 500, logEntries: 400 } as const;

/**
 * How much of the open project's script the site-wide assistant receives (services/assistantContext.ts
 * buildProjectSnapshot scriptPreview). Its per-scene, per-panel, per-character and per-comment samples
 * never reach the model: server/src/ai/assistantPolicy.ts keeps three levels of nesting, which drops them.
 */
export const ASSISTANT_SCRIPT_PREVIEW_CHARS = 600;

/** Stream Studio's people search (server/sql/live_accounts_and_monitor.sql live_search_people). */
export const PEOPLE_SEARCH = { minLetters: 2, maxResults: 12 } as const;

/**
 * AI model providers a request can reach directly (server/src/ai/gateway.ts provider labels, plus
 * Anthropic's own client in server/src/ai/providers/anthropic.ts and NVIDIA's in nvidia.ts).
 */
export const DIRECT_AI_PROVIDERS = [
  'OpenAI',
  'Anthropic',
  'Google (Gemini)',
  'xAI',
  'DeepSeek',
  'Z.AI',
  'MiniMax',
  'Tencent (Hunyuan)',
  'NVIDIA'
] as const;

/** Production keeps Stripe billing off (api-proxy/wrangler.jsonc BILLING_ENABLED "false"). */
export const BILLING_LIVE = false;

/**
 * Services people's BROWSERS contact directly while they use our apps (not through our servers),
 * listed on the Cookies notice and the Subprocessors page. components/legal/legalFacts.test.ts scans
 * the client code, the HTML entries, the main site's CSP and Stream Studio's ICE servers, and fails
 * on any third-party host this list doesn't name.
 */
export interface BrowserThirdParty {
  name: string;
  /** Hostnames the browser contacts ("*.x" covers subdomains of x; "*" means any website). */
  hosts: readonly string[];
  /** When the browser contacts it. */
  when: string;
  /** What it receives, besides the IP address and browser details every request carries. */
  receives: string;
}

export const BROWSER_THIRD_PARTIES: readonly BrowserThirdParty[] = [
  {
    name: 'Cloudflare Turnstile',
    hosts: ['challenges.cloudflare.com'],
    when: "The bot check on the main site's sign-in and sign-up, Stream Studio's password reset and email resend, and some forms.",
    receives: 'Signals from your browser that tell people from bots. It may set its own cookies to do that.'
  },
  {
    name: 'Google Fonts',
    hosts: ['fonts.googleapis.com', 'fonts.gstatic.com'],
    when: 'Every page, for the typefaces it uses.',
    receives: 'Only the request for the font.'
  },
  {
    name: 'cdnjs (Cloudflare)',
    hosts: ['cdnjs.cloudflare.com'],
    when: 'The main site, for two libraries that make PDFs and images of pages (jsPDF and html2canvas).',
    receives: 'Only the request for the library.'
  },
  {
    name: 'jsDelivr',
    hosts: ['cdn.jsdelivr.net'],
    when: 'When you run Python code in Chat Studio: the Python runtime (Pyodide) and the packages the code needs load from it.',
    receives: 'Which packages the code needs.'
  },
  {
    name: 'CodeSandbox (Sandpack)',
    hosts: ['*.codesandbox.io'],
    when: 'When Chat Studio shows a live preview of web or React code.',
    receives: "The preview's code, which runs in CodeSandbox's frame in your browser and loads the packages it needs from CodeSandbox."
  },
  {
    name: 'CARTO',
    hosts: ['basemaps.cartocdn.com'],
    when: 'Maps and directions in Chat Studio.',
    receives: "The map tiles you view, which show the area you're looking at."
  },
  {
    name: 'RainViewer',
    hosts: ['api.rainviewer.com', 'tilecache.rainviewer.com'],
    when: 'The weather-radar layer on Chat Studio maps.',
    receives: "The radar tiles for the area you're looking at."
  },
  {
    name: 'Google (site icons)',
    hosts: ['www.google.com'],
    when: 'The small site icons next to sources and news in Chat Studio answers.',
    receives: 'The web address (domain) of each source shown.'
  },
  {
    name: 'Parqet, Financial Modeling Prep',
    hosts: ['assets.parqet.com', 'financialmodelingprep.com'],
    when: 'Company and coin logos on Chat Studio market cards.',
    receives: 'The ticker symbol shown.'
  },
  {
    name: 'goQR (api.qrserver.com)',
    hosts: ['api.qrserver.com'],
    when: 'QR codes on Chat Studio boarding-pass cards, and QR codes you ask Chat Studio to make.',
    receives: 'The text inside the QR code: the booking confirmation code (or flight number), or whatever you asked it to encode.'
  },
  {
    name: 'YouTube, Vimeo',
    hosts: ['www.youtube-nocookie.com', 'www.youtube.com', 'player.vimeo.com'],
    when: 'When you play a video Chat Studio shows (YouTube through youtube-nocookie.com where it can).',
    receives: 'Which video you play. Their own cookies may apply once it plays.'
  },
  {
    name: 'Google Drive',
    hosts: ['www.googleapis.com'],
    when: 'When you save a Stream Studio recording to Google Drive: your browser uploads it straight to Google.',
    receives: 'The recording, with your Google permission for the upload.'
  },
  {
    name: 'STUN servers (Cloudflare, Google)',
    hosts: ['stun.cloudflare.com', 'stun.l.google.com'],
    when: 'Stream Studio calls, meetings, streams and the baby monitor, to set up a direct connection between devices.',
    receives: 'Your IP address, which they report back so your devices can connect.'
  },
  {
    name: 'Images in answers',
    hosts: ['*'],
    when: 'Images in Chat Studio answers (search results, news, places, products and similar) load from the websites they come from.',
    receives: 'Which image is shown.'
  }
];
