/**
 * The home page's words, in one place so they can be checked against the product (HomePage.test.tsx).
 *
 * Honesty rules for this file:
 * - Only shipped behaviour. Each line below points at where it is true: Comic Studio's own front page
 *   (components/comicshost/ComicsLanding.tsx), Stream Studio (docs/features/baby-monitor.md,
 *   docs/features/accounts-and-access.md, live/LiveApp.tsx), Chat Studio's access gate (App.tsx
 *   isProtectedViewStrict, AuthPage SIGNUPS_ENABLED), the shared studio list (services/studioInterests.ts).
 * - No stage counts for Comic Studio (the how-it-works page owns the detailed pipeline), no dates, no
 *   model names in mock-ups, no retired studio.
 * - The baby monitor's privacy sentence is the one the app itself shows (live/monitor/privacyCopy.unit.test.ts).
 */
import type { Studio } from '../brand/studios';

/** Atlas Studio's own site (the studio switcher's fourth mark). */
export const ATLAS_STUDIO_URL = 'https://atlas.dreamstreamstudio.ai';
export const CONTACT_EMAIL = 'contact@dreamstreamstudio.ai';

export type StudioBandId = 'comic-studio' | 'stream-studio' | 'chat-studio' | 'atlas-studio';

export interface StudioBandCopy {
  id: StudioBandId;
  studio: Studio;
  name: string;
  /** The h2. */
  title: string;
  lead: string;
  points: readonly string[];
  /** The moment's accessible description (it is drawn as an image). */
  momentLabel: string;
  /** The small caption over the moment, beside the studio's mark. */
  momentTitle: string;
}

export const STUDIO_BANDS: readonly StudioBandCopy[] = [
  {
    id: 'comic-studio',
    studio: 'comic',
    name: 'Comic Studio',
    title: 'Talk it through. Get a finished comic.',
    lead: 'Tell the Comic Director your idea: a script, an outline or a single line. It plans every page with you, keeps your cast on-model and letters every balloon.',
    points: [
      'See the plan and the cost before anything is drawn.',
      'Reference sheets and a locked style keep faces and outfits consistent, cover to last page.',
      'Balloons and captions are real text: restyle or rewrite them without redrawing.'
    ],
    momentLabel: 'Example: a comic page draws itself panel by panel, then a speech balloon and a caption are lettered in.',
    momentTitle: 'Page 1'
  },
  {
    id: 'stream-studio',
    studio: 'stream',
    name: 'Stream Studio',
    title: 'Go live, watch the nursery, call the family.',
    lead: 'Stream Studio runs in your browser. Host a private live event, turn a spare phone into a baby monitor, or call the people you share it with.',
    points: [
      'Live events: share a viewer link, approve the lobby, bring guests on air and record the session.',
      'Baby monitor: one phone is the camera, any family device watches, with cry and sound alerts. It never records.',
      'Family calls: video and voice calls with your family, or with anyone on Stream Studio, found by name.'
    ],
    momentLabel: 'Example: a live event with a LIVE badge, a viewer count and chat, then a baby monitor reporting a quiet nursery, then a family video call.',
    momentTitle: 'Stream Studio'
  },
  {
    id: 'chat-studio',
    studio: 'dreamstream',
    name: 'Chat Studio',
    title: 'An assistant that works with your apps.',
    lead: 'Ask anything and get answers you can use: charts, maps, weather and tables, not just text. Connect your calendar, mail or files and it works with them too.',
    points: [
      'Choose from 100+ models, including Claude, Gemini and GPT.',
      'Rich answers arrive as cards you can resize, from a forecast to a chart.',
      'Connected apps: it reads only what you allow, and asks before it changes anything.'
    ],
    momentLabel: 'Example: a question is typed, the assistant thinks, then answers with a short plan and a three-day weather card.',
    momentTitle: 'Chat Studio'
  },
  {
    id: 'atlas-studio',
    studio: 'atlas',
    name: 'Atlas Studio',
    title: 'Find any file across your accounts.',
    lead: 'Atlas Studio is our search app: one search across the files and mail in your connected accounts, with previews. It has its own site and its own sign-up.',
    points: [
      'One search across Google Drive, Gmail, OneDrive, Dropbox and more.',
      'Preview documents and threads without opening another tab.',
      'Changes only when you ask.'
    ],
    momentLabel: 'Example: a search for an invoice returns matches from Gmail, Google Drive and Dropbox in one list.',
    momentTitle: 'Atlas Studio'
  }
];

/** How access works today, said the same way everywhere on the page. */
export const ACCESS_NOTE = 'New accounts are invite-only during the beta.';
export const CHAT_ACCESS_NOTE = 'Chat Studio is for DreamStream members. New accounts are invite-only during the beta.';
export const STREAM_ACCESS_NOTE = 'People you send a link to join with just a name. Hosting, the monitor and calls need a DreamStream account.';

export interface FaqEntry {
  q: string;
  a: string;
}

export const FAQ: readonly FaqEntry[] = [
  {
    q: 'How do I get an account?',
    a: 'New accounts are invite-only during the beta. If someone sent you an invite link, open it to create your account. Otherwise, request access from the sign-in page, or register interest above to hear about the studios you picked. One DreamStream account opens Comic Studio, Stream Studio and Chat Studio.'
  },
  {
    q: 'Does the baby monitor record?',
    a: 'No. The baby monitor never records. Picture and sound go device to device, end-to-end encrypted, wherever the network allows. For a moment while a connection starts, when a network blocks direct video, or when the camera is full, they pass through our server in memory only, never stored, not end-to-end encrypted.'
  },
  {
    q: 'Do the people I invite need an account?',
    a: 'No. Viewers and guests of a live event join from the link you send, with just a name, and a nursery share link works with its passcode. Hosting an event, setting up the monitor and making calls need a DreamStream account.'
  },
  {
    q: 'What happens to my email when I register interest?',
    a: 'We send one email to confirm your address. After you confirm, we send occasional updates about the studios you picked. Every email has a one-click unsubscribe, and we never sell your address.'
  }
];
