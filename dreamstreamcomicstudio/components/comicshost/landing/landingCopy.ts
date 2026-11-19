// Every sentence the landing's sections below the hero show, in one place, so a later edit cannot slip an unchecked
// claim onto the page without changing this file (landingCopy.test.tsx reads the rendered page back against these
// strings and bans the words the page must never use).
//
// Rules for anything added here: true today, in production, for the reader it addresses; no price, amount, allowance,
// plan name or date; no promise of an email, a reply, early access or a time; numbers and model names are never typed:
// a `{NAME}` placeholder is filled from landingModels.ts (the studio's registries) by `fill()`. The interest form is the
// app's own (components/WaitlistForm.tsx) with its own questions and thank-you, which promise nothing either.

/** Fill `{NAME}` placeholders. A missing value throws, so a typo never ships as a literal brace. */
export const fill = (text: string, values: Readonly<Record<string, string | number>> = {}): string =>
  text.replace(/\{([A-Z_]+)\}/g, (_m, key: string) => {
    if (!(key in values)) throw new Error(`landing copy: no value for {${key}}`);
    return String(values[key]);
  });

/** The join action, named the same everywhere on the page. */
export const JOIN = { action: 'Register your interest', short: 'Register interest' } as const;

/** The hero's words under the title: what the product is, in one look (an AI makes the pages, the creator steers). */
export const HERO = {
  lead: 'Start with an idea or a script. The Comic Director, an AI, plans, draws and letters your pages with you.',
  invitation: 'New accounts are by invitation while we’re in beta.'
} as const;

export const FEATURES_HEAD = {
  eyebrow: 'Features',
  title: 'From an idea to finished, lettered pages',
  intro: 'Everything below is in Comic Studio today, for members. The pictures are real studio screens from a sample project.'
} as const;

export interface FeatureCopy {
  title: string;
  lines: readonly string[];
}

export const FEATURES: readonly FeatureCopy[] = [
  {
    title: 'Plan it with the Comic Director',
    lines: [
      'Start with a line, an outline or a whole script. Attach it as Word, PDF, Final Draft, Fountain, Markdown or plain text.',
      'Before anything is drawn, the Director sets out the story, format, audience, setting, look and cast. Change any of it by asking.',
      'Up to {PAGES_MAX} pages in one comic.'
    ]
  },
  {
    title: 'Letter it your way',
    lines: [
      'Speech, thoughts, captions and sound effects sit on the art as real text. Drag, restyle or rewrite them without redrawing the page.',
      'Switch between Easy and Pro lettering tools, and go back to an earlier version of any drawn page.'
    ]
  },
  {
    title: 'Translate it',
    lines: [
      'Translate a comic into any of {LANGS} other languages, from Hindi and Tamil to Japanese and Arabic, with a glossary for how names are written in each.',
      'Readers can switch language on a comic published in more than one.'
    ]
  },
  {
    title: 'Publish and share',
    lines: [
      'Your comic isn’t public until you publish it. Then share a read-only link, or list it in the public Library as well.',
      'You choose whether readers can download it and whether other sites can embed it.',
      'Export a print-ready PDF, every page as an image, or a motion comic video.'
    ]
  }
];

export const HOW = {
  eyebrow: 'How it works',
  title: 'Three steps to a finished comic',
  steps: [
    { title: 'Tell the Director your idea', body: 'Type it, paste a script or attach one. The Director asks what matters and writes the plan.' },
    { title: 'Agree the plan and the look', body: 'Settle the pages, cast and look together. Character sheets and a locked look help keep faces and outfits consistent.' },
    { title: 'Draw, letter and share', body: 'Approve the drawing, fix any words in the editor, then publish a link or export it.' }
  ]
} as const;

export const MODELS = {
  eyebrow: 'Models',
  title: 'The models behind it',
  items: [
    {
      title: 'The image model',
      body: 'New comics are drawn with {DEFAULT_MODEL}. It takes reference sheets for up to {CHARACTERS} characters in each image.'
    },
    {
      title: 'More in the model picker',
      body: 'Members who use their own API key can also pick {OTHER_MODELS}.{OTHER_MODELS_STATUS}'
    },
    {
      title: 'Draft and Standard quality',
      body: '{DRAFT} makes quick, lower-resolution pages to try the story. {STANDARD} makes sharper, higher-resolution pages.'
    },
    {
      title: 'One model for each comic',
      body: 'The model locks when the first image is drawn, so every page matches. Changing it later is your choice, and the studio asks first.'
    },
    {
      title: 'Models that talk and check',
      body: 'Other AI models hold the conversation, write the plan and the translations, and check each drawn page.'
    }
  ],
  note: 'The line-up can change as models improve.'
} as const;

export const PRICING = {
  title: 'Pricing',
  lines: [
    'Comic Studio is in an invite-only beta.',
    'Sign-up is not open yet.',
    'Prices have not been announced.',
    'Registering your interest costs nothing.'
  ]
} as const;

export const READ = {
  eyebrow: 'Read',
  title: 'Read comics made in Comic Studio',
  line: 'The Library is open to everyone, and so is every shared comic link. No account needed.',
  library: 'Open the Library',
  featured: 'Read now',
  readIn: 'Read',
  englishEdition: 'Opens the English edition.'
} as const;

export const REGISTER = {
  title: JOIN.action,
  line: 'New accounts are by invite while Comic Studio is in beta. Registering your interest costs nothing.',
  memberAsk: 'Already a member?',
  signIn: 'Sign in',
  signedInTitle: 'You’re a member',
  signedInLine: 'Your comics and drafts are in My comics.',
  openComics: 'Open My comics'
} as const;

export interface FaqCopy {
  q: string;
  a: string;
}

export const FAQ_HEAD = { title: 'Questions and answers', seePricing: 'See pricing', seeModels: 'See models' } as const;

export const FAQ: readonly FaqCopy[] = [
  {
    q: 'Can I read comics without an account?',
    a: 'Yes. The Library and any shared comic link open without an account.'
  },
  {
    q: 'How do I get an account?',
    a: 'New accounts are by invite during the beta. Register your interest on this page. If you receive an invite link, open it to create your account.'
  },
  {
    q: 'What happens after I register my interest?',
    a: 'Your interest is recorded, with any answers you add. Nobody is emailed for registering. Accounts open by invite, and there is no date yet.'
  },
  {
    q: 'Does it cost anything?',
    a: 'Prices have not been announced. Registering your interest costs nothing.'
  },
  {
    q: 'Which models draw the pictures?',
    a: 'New comics are drawn with {DEFAULT_MODEL}. Members who use their own API key can pick others, listed in the Models section; the line-up can change.'
  },
  {
    q: 'Who can see my comic?',
    a: 'It isn’t public until you publish it. If the automatic safety check flags a picture, our moderators may look at that picture. Once it’s published, you share a read-only link, and you can also list it in the public Library.'
  },
  {
    q: 'What ratings are allowed?',
    a: 'Comics are rated G, PG or PG-13. Nothing above PG-13 is published.'
  },
  {
    q: 'Which languages?',
    a: 'English and {LANGS} more, including Hindi, Tamil, Spanish, Japanese and Arabic.'
  },
  {
    q: 'I already have an account.',
    a: 'Sign in with the button at the top of the page.'
  },
  { q: 'How do I contact you?', a: 'Email' }
];

export const FOOTER = {
  pageNav: 'On this page',
  features: 'Features',
  how: 'How it works',
  models: 'Models',
  pricing: 'Pricing',
  read: 'Read',
  register: JOIN.short,
  faq: 'FAQ'
} as const;
