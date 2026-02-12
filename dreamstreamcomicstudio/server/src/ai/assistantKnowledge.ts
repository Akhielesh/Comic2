export const PUBLIC_FAQ_ENTRIES = [
  {
    question: 'Is DreamStream free?',
    answer: 'Free Starter is available with no credit card required.'
  },
  {
    question: 'Can users bring their own API keys?',
    answer: 'Yes. Users can configure Gemini and Flux/Pixazo keys in Settings.'
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
  'Open Studio and create a project.',
  'Write/paste a script, then run analysis.',
  'Build references, choose layout, and generate panels.',
  'Review/export when generation is complete.',
  'Optional: Add your own Gemini or Flux/Pixazo API keys in Settings.'
];

export const PUBLIC_LEGAL_POINTERS = [
  'Privacy Policy is available from app footer/legal links.',
  'Terms of Service are available from app footer/legal links.',
  'Users are responsible for lawful use and rights clearance.'
];

export const OFF_TOPIC_REDIRECT_TIPS = [
  'Ask about project setup, script analysis, world-building, layout, generation, export, account settings, plans, or troubleshooting.',
  'For general knowledge unrelated to DreamStream, use a general-purpose assistant.'
];

export const buildPublicKnowledgeBlock = () => {
  const faq = PUBLIC_FAQ_ENTRIES
    .map((entry) => `- Q: ${entry.question}\n  A: ${entry.answer}`)
    .join('\n');
  const setup = PUBLIC_SETUP_STEPS.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const legal = PUBLIC_LEGAL_POINTERS.map((line) => `- ${line}`).join('\n');
  return [
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
