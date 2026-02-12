export const PUBLIC_FAQ_ENTRIES = [
  {
    question: 'Is DreamStream free?',
    answer: 'Free Starter is available with monthly/daily Comic Token (CT) limits and no required card to begin.'
  },
  {
    question: 'What is the platform usage metric?',
    answer: 'DreamStream uses Comic Tokens (CT). 10,000 CT equals $1.00 billable value.'
  },
  {
    question: 'How are costs shown?',
    answer: 'Users see estimated CT before generation and actual CT + USD settlement after generation.'
  },
  {
    question: 'Can users bring their own API keys?',
    answer: 'Yes. Users can configure Gemini and Flux/Pixazo keys in Settings. BYOK usage is tracked but does not deduct platform CT.'
  },
  {
    question: 'Do users own comics created on the platform?',
    answer: 'DreamStream states users own their generated comics, subject to provider terms.'
  },
  {
    question: 'Which export formats are supported?',
    answer: 'ZIP (raw images), HTML (web reader), and PDF (print-ready).'
  }
];

export const PUBLIC_SETUP_STEPS = [
  'Sign in or create an account.',
  'Review your CT wallet, daily guardrail, and plan limits in Account Settings > Billing.',
  'Open Studio and create a project.',
  'Write/paste a script, then run analysis.',
  'Build references, choose layout, and check estimated CT before generating.',
  'Generate panels and review actual CT usage after each operation.',
  'Review/export when generation is complete.',
  'If limits are reached, upgrade, add credits, or wait for reset.'
];

export const PUBLIC_LEGAL_POINTERS = [
  'Privacy Policy is available from app footer/legal links.',
  'Terms of Service are available from app footer/legal links.',
  'Users are responsible for lawful use and rights clearance.',
  'Stored payment information is managed by Stripe tokenized methods, not raw card storage on DreamStream.'
];

export const OFF_TOPIC_REDIRECT_TIPS = [
  'Ask about project setup, script analysis, world-building, layout, generation, export, account settings, plans, or troubleshooting.',
  'For general knowledge unrelated to DreamStream, use a general-purpose assistant.'
];

export const ASSISTANT_IDENTITY_FACTS = [
  'You are DreamStream Universal Assistant.',
  'You help with DreamStream workflows, troubleshooting, account/settings guidance, and feature explanations.',
  'You enforce platform-only scope and cannot answer unrelated general-knowledge queries.',
  'You cannot access sensitive secrets (API keys, tokens, passwords) and only use safe, allowlisted context.'
];

export const buildPublicKnowledgeBlock = () => {
  const faq = PUBLIC_FAQ_ENTRIES
    .map((entry) => `- Q: ${entry.question}\n  A: ${entry.answer}`)
    .join('\n');
  const setup = PUBLIC_SETUP_STEPS.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const legal = PUBLIC_LEGAL_POINTERS.map((line) => `- ${line}`).join('\n');
  const identity = ASSISTANT_IDENTITY_FACTS.map((line) => `- ${line}`).join('\n');
  return [
    'Assistant identity and capabilities:',
    identity,
    '',
    'Public product facts:',
    faq,
    '',
    'Common setup flow:',
    setup,
    '',
    'Policy/legal pointers:',
    legal
  ].join('\n');
};
