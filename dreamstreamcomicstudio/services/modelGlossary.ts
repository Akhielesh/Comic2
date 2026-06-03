// Plain-language glossary for the Model Library.
//
// Every piece of jargon shown in the UI (benchmark names, capability terms, units) maps to a
// short, human definition here so we can wrap it in a hover tooltip. The goal: a newcomer can
// hover any term and understand what it means and why it matters — no prior ML knowledge needed.

export interface GlossaryEntry {
  /** Short headline shown bold at the top of the tooltip. */
  title: string;
  /** One or two plain sentences. Avoid jargon; if you must use a term, define it. */
  body: string;
  /** Optional "higher is better" / unit hint shown as a footnote. */
  scale?: string;
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
  // ── Benchmarks ────────────────────────────────────────────────────────────
  arena_elo: {
    title: 'Arena Elo (LMArena)',
    body: 'A score from millions of blind human votes: two AI answers are shown side by side and people pick the better one. Like a chess rating — it rises when a model wins more head-to-head matchups.',
    scale: 'Higher is better · ~1000 average, ~1400+ is top-tier'
  },
  mmlu: {
    title: 'MMLU',
    body: 'A 14,000-question exam across 57 subjects (history, law, medicine, math…). Measures broad general knowledge and reasoning. "MMLU-Pro" is the harder, newer version.',
    scale: 'Higher is better · % of questions answered correctly'
  },
  gpqa: {
    title: 'GPQA Diamond',
    body: 'PhD-level science questions in physics, chemistry and biology — so hard that non-expert humans with Google still mostly fail. The best test of real science/physics reasoning.',
    scale: 'Higher is better · % correct'
  },
  humaneval: {
    title: 'HumanEval',
    body: 'A coding test: the model writes Python functions from a description, then the code is actually run against hidden tests. Measures whether generated code really works.',
    scale: 'Higher is better · % of problems solved (pass@1)'
  },
  swebench: {
    title: 'SWE-bench Verified',
    body: 'The hardest, most realistic coding benchmark: the model must fix real bugs in real open-source GitHub projects. Tests practical software-engineering ability, not toy snippets.',
    scale: 'Higher is better · % of real issues resolved'
  },
  math: {
    title: 'MATH',
    body: 'Competition-level math problems (algebra, geometry, number theory). Tests step-by-step mathematical reasoning, not just arithmetic.',
    scale: 'Higher is better · % solved'
  },

  // ── Capabilities / terms ──────────────────────────────────────────────────
  context_length: {
    title: 'Context window',
    body: "How much text the model can 'hold in its head' at once — your prompt plus its reply. Bigger means it can read a whole long script without forgetting the start.",
    scale: 'Measured in tokens (~¾ of a word each). 200K ≈ a long novel.'
  },
  reasoning: {
    title: 'Reasoning model',
    body: "A model that 'thinks step by step' before answering (like o3 or DeepSeek-R1). Slower and pricier, but much stronger on hard logic, math and multi-step planning.",
  },
  structured_json: {
    title: 'Structured JSON output',
    body: 'The model can return data in a strict, machine-readable format (JSON) on demand. The app relies on this to reliably plan panels, characters and layouts without guesswork.',
  },
  tool_use: {
    title: 'Tool use / function calling',
    body: 'The model can call external tools or functions you give it (search, code execution, APIs) instead of only writing text — the basis of "agents".',
  },
  multimodal: {
    title: 'Multimodal / vision',
    body: 'The model can look at images you send, not just read text — useful for reference images, describing art, or checking a panel.',
  },
  image_output: {
    title: 'Image generation',
    body: 'The model creates images from a text description (and sometimes reference images), rather than only writing text.',
  },
  multi_ref: {
    title: 'Multi-reference consistency',
    body: 'How well an image model keeps the same character looking the same across many panels when given reference images. Critical for comics.',
  },
  moe: {
    title: 'Mixture-of-Experts (MoE)',
    body: 'An efficiency design: the model has many specialist "expert" sub-networks but only activates a few per request — so it can be huge yet run cheaply and fast.',
  },
  params: {
    title: 'Parameters',
    body: "The model's internal 'knobs' learned during training, in billions (B). Loosely, more can mean more capable — but architecture and training matter far more than raw size.",
  },

  // ── Cost ──────────────────────────────────────────────────────────────────
  token: {
    title: 'Token',
    body: 'The unit AI bills in — roughly ¾ of a word, or about 4 characters. "$/M tokens" means dollars per one million tokens of input or output.',
  },
  free_verified: {
    title: 'Verified free',
    body: 'Confirmed $0 on every cost axis (input, output, per-image, per-request) against the live source — genuinely free to run, not just a $0 sticker price.',
  },
  token_billed: {
    title: 'Token-billed (NOT free)',
    body: "Shows a $0 sticker price but still charges per token behind the scenes — so it is NOT actually free. The app flags these so you're never surprised.",
  }
};

export const glossary = (key: string): GlossaryEntry | undefined => GLOSSARY[key];
