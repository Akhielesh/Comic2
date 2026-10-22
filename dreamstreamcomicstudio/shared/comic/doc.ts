// ComicDoc — the single source of truth for a Comic Studio (v4) project.
//
// The conversational studio is built around ONE structured document that the
// server-side Comic Director keeps up to date as the user talks ("sticking the
// idea"). Every image the studio renders is COMPILED from this document — the
// chat transcript is never the source of truth. The client mirrors the doc and
// applies the same DocOps the server emits (shared/comic/ops.ts), so both sides
// stay in lockstep without re-sending the whole document.
//
// Rules for this file:
//  - Dependency-free (shared by the Node server and the Vite client).
//  - Every field added later must be OPTIONAL or defaulted in normalizeDoc(), so
//    stored documents keep loading.
//  - Images are referenced by storage path (AssetRef.path), never inlined as base64.

export const COMIC_DOC_VERSION = 1;

/** Page/frame aspect ratios the studio understands (superset; each model supports a subset). */
export type AspectRatio =
  | '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4'
  | '9:16' | '16:9' | '21:9' | '1:4' | '4:1' | '1:8' | '8:1';

export type Resolution = '512' | '1K' | '2K' | '4K';

export type ComicKind = 'comic' | 'manga' | 'webtoon' | 'strip' | 'storybook';
export type QualityTier = 'draft' | 'standard' | 'pro';
/** overlay = clean art + vector balloons we letter (editable, exact text). in_art = the model letters the page. */
export type LetteringMode = 'overlay' | 'in_art';
/** always = confirm every spend; big = confirm above settings.bigSpendUsd; never = only the budget cap stops it. */
export type ConfirmPolicy = 'always' | 'big' | 'never';
export type ColorMode = 'color' | 'bw' | 'limited';

/** A stored image (Supabase storage path in the comic-assets bucket). */
export interface AssetRef {
  path: string;
  w?: number;
  h?: number;
  source: 'upload' | 'generated';
  /** Image model that produced it (generated only). */
  model?: string;
  at: number;
}

export type RenderStatus = 'none' | 'queued' | 'rendering' | 'ready' | 'failed' | 'stale';

/** Normalized box on an image (0..1, origin top-left). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface QcReport {
  /** 0..1 — overall confidence the render matches its spec. */
  score: number;
  issues: string[];
  /** Panel rectangles in reading order (page renders). */
  panelBoxes?: Box[];
  /** Text the vision pass read off the image (in_art lettering verification / stray text). */
  textFound?: string[];
  checkedAt: number;
  model?: string;
}

export interface RenderState {
  status: RenderStatus;
  asset?: AssetRef;
  /** Previous renders, newest first (capped). Restoring swaps one back into `asset`. */
  history: AssetRef[];
  model?: string;
  resolution?: Resolution;
  costUsd?: number;
  error?: string;
  attempts?: number;
  updatedAt?: number;
  qc?: QcReport;
  /** Fingerprint of the spec this asset was rendered from — differs ⇒ the render is stale. */
  specHash?: string;
}

export interface Brief {
  title: string;
  logline?: string;
  premise?: string;
  genre?: string;
  tone?: string;
  audience?: string;
  setting?: string;
  themes?: string[];
  /** Free-form decisions/ideas the user has stated that don't fit a field ("no gore", "ends on a cliffhanger"). */
  notes: string[];
}

export interface Format {
  kind: ComicKind;
  pageCount: number;
  pageAspect: AspectRatio;
  /** 'auto' lets the writer vary density per page (3–6). */
  panelsPerPage: 'auto' | number;
  readingDirection: 'ltr' | 'rtl';
  lettering: LetteringMode;
  colorMode: ColorMode;
  /** BCP-47 language for dialogue (default 'en'). */
  language: string;
}

/** Raw material the user supplied (a pasted script, story, or notes). */
export interface Source {
  script?: string;
  updatedAt?: number;
}

export interface StyleOption {
  id: string;
  name: string;
  /** Prompt-ready description of the look (medium, linework, color, shading, influences). */
  spec: string;
  render: RenderState;
}

export interface StyleBible {
  status: 'empty' | 'drafted' | 'locked';
  name?: string;
  spec?: string;
  palette?: string[];
  linework?: string;
  /** Things the art must never do ("no photorealism", "no gore"). */
  avoid?: string[];
  presetId?: string;
  /** User-supplied style reference images. */
  refs: AssetRef[];
  /** The locked style board — the canonical visual anchor for every render. */
  board?: AssetRef;
  options: StyleOption[];
}

export interface CharacterLook {
  /** One dense visual sentence an artist could draw from. */
  summary: string;
  age?: string;
  gender?: string;
  build?: string;
  face?: string;
  hair?: string;
  eyes?: string;
  skin?: string;
  outfit?: string;
  palette?: string;
  props?: string;
  /** Distinguishing marks that must never drift (scar over left eye, red scarf). */
  marks?: string;
}

export type CastTier = 'lead' | 'support' | 'extra';

export interface Character {
  id: string;
  name: string;
  role?: string;
  /** lead/support get a model sheet; extras are text-locked only. */
  tier: CastTier;
  look: CharacterLook;
  personality?: string;
  /** How they talk — feeds dialogue writing. */
  voice?: string;
  /** User-supplied reference images (photos, drawings). */
  refs: AssetRef[];
  /** Model sheet (turnaround + expressions) — the identity anchor in every page render. */
  sheet: RenderState;
}

export interface Place {
  id: string;
  name: string;
  look: string;
  refs: AssetRef[];
  sheet: RenderState;
}

export type ShotType =
  | 'establishing' | 'wide' | 'full' | 'medium' | 'close_up'
  | 'extreme_close_up' | 'over_shoulder' | 'insert' | 'pov';

export type PanelSize = 'small' | 'medium' | 'large' | 'wide' | 'tall' | 'splash';

export type LineKind = 'speech' | 'thought' | 'caption' | 'sfx' | 'whisper' | 'shout';

export interface Line {
  id: string;
  kind: LineKind;
  /** Character id for speech/thought/whisper/shout; omitted for captions/sfx. */
  speakerId?: string;
  text: string;
}

export interface Panel {
  id: string;
  /** 1-based reading order within the page. */
  n: number;
  size: PanelSize;
  shot: ShotType;
  angle?: string;
  /** What is visibly happening in the frame — drawn, not narrated. */
  action: string;
  /** Characters visible in the panel (ids). Anyone not listed must not appear. */
  castIds: string[];
  placeId?: string;
  mood?: string;
  lines: Line[];
}

/** A lettered balloon placed on a page (overlay lettering). Coordinates are page-normalized 0..1. */
export interface Balloon {
  lineId: string;
  x: number;
  y: number;
  /** Width as a fraction of page width. */
  w: number;
  tailX?: number;
  tailY?: number;
  /** User moved it — never auto-relayout over it. */
  pinned?: boolean;
}

export interface Page {
  id: string;
  /** 1-based page number. */
  n: number;
  summary: string;
  /** Blueprint of the panel arrangement ("Row 1: one wide panel. Row 2: two equal panels."). */
  layout: string;
  /** What makes the reader turn the page (last panel's hook). */
  turnHook?: string;
  panels: Panel[];
  render: RenderState;
  balloons: Balloon[];
}

export interface Cover {
  title?: string;
  tagline?: string;
  direction?: string;
  render: RenderState;
}

export interface Settings {
  quality: QualityTier;
  confirm: ConfirmPolicy;
  /** Spend at or below this auto-runs under the 'big' policy. */
  bigSpendUsd: number;
  /** Hard cap for the whole project; nothing auto-spends past it. */
  budgetUsd?: number;
  /** Advanced: force a specific registry image model id. */
  imageModelOverride?: string;
}

export type SpendKind = 'chat' | 'plan' | 'style' | 'sheet' | 'page' | 'edit' | 'cover' | 'qc';

export interface SpendEntry {
  id: string;
  at: number;
  kind: SpendKind;
  label: string;
  usd: number;
  model?: string;
  /** Paid by the user's own key (not billed by DreamStream) — still tracked so the user sees real cost. */
  byok: boolean;
  /** True when the provider didn't report a cost and this is the registry estimate. */
  estimated: boolean;
}

export interface Spend {
  totalUsd: number;
  byKind: Partial<Record<SpendKind, number>>;
  /** Most recent first, capped. */
  entries: SpendEntry[];
}

/** A spend the studio is waiting on the user to approve. */
export interface Gate {
  id: string;
  /** The action to run on approval (always a spend action, see ops.ts StudioAction). */
  action: import('./ops.js').StudioAction;
  title: string;
  summary: string;
  estimateUsd: number;
  imageCount: number;
  model: string;
  createdAt: number;
  status: 'open' | 'approved' | 'declined';
  /** Why it stopped: policy=confirm setting, budget=would exceed the budget cap. */
  reason: 'policy' | 'budget';
}

export interface OptionChoice {
  id: string;
  label: string;
  description?: string;
  /** Message sent on the user's behalf when picked (defaults to label). */
  reply?: string;
}

/** Interactive cards that live inside the conversation. Most render LIVE doc state. */
export type Card =
  | { type: 'options'; id: string; question: string; choices: OptionChoice[]; multi?: boolean; allowCustom?: boolean; answered?: string[] }
  | { type: 'style_choice'; id: string }
  | { type: 'cast'; id: string; characterIds: string[] }
  | { type: 'plan'; id: string }
  | { type: 'gate'; id: string; gateId: string }
  | { type: 'renders'; id: string; targets: RenderTarget[]; label: string }
  | { type: 'notice'; id: string; tone: 'info' | 'warn' | 'error' | 'success'; text: string };

export type RenderTarget =
  | { kind: 'page'; id: string }
  | { kind: 'cover' }
  | { kind: 'sheet'; id: string }
  | { kind: 'place'; id: string }
  | { kind: 'style_option'; id: string };

export interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  attachments?: AssetRef[];
  cards?: Card[];
  /** Suggested next prompts shown as chips under the latest assistant message. */
  suggestions?: string[];
}

export interface ComicDoc {
  v: number;
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Monotonic revision, bumped by the server on every committed op batch. */
  rev: number;
  brief: Brief;
  format: Format;
  source: Source;
  style: StyleBible;
  cast: Character[];
  places: Place[];
  pages: Page[];
  cover: Cover;
  /** 'draft' = pages planned but not approved; 'approved' = user OK'd the page plan. */
  planStatus: 'none' | 'draft' | 'approved';
  settings: Settings;
  spend: Spend;
  gate: Gate | null;
  conversation: Msg[];
  /** Compressed memory of older conversation turns that scrolled out of the director's window. */
  memory?: string;
}

export const MAX_RENDER_HISTORY = 8;
export const MAX_SPEND_ENTRIES = 200;
export const MAX_CONVERSATION = 160;

export const emptyRender = (): RenderState => ({ status: 'none', history: [] });

export const DEFAULT_FORMAT: Format = {
  kind: 'comic',
  pageCount: 6,
  pageAspect: '2:3',
  panelsPerPage: 'auto',
  readingDirection: 'ltr',
  lettering: 'overlay',
  colorMode: 'color',
  language: 'en'
};

export const DEFAULT_SETTINGS: Settings = {
  quality: 'standard',
  confirm: 'big',
  bigSpendUsd: 0.5
};

export const createEmptyDoc = (id: string, title = 'Untitled comic', now = Date.now()): ComicDoc => ({
  v: COMIC_DOC_VERSION,
  id,
  createdAt: now,
  updatedAt: now,
  rev: 0,
  brief: { title, notes: [] },
  format: { ...DEFAULT_FORMAT },
  source: {},
  style: { status: 'empty', refs: [], options: [] },
  cast: [],
  places: [],
  pages: [],
  cover: { render: emptyRender() },
  planStatus: 'none',
  settings: { ...DEFAULT_SETTINGS },
  spend: { totalUsd: 0, byKind: {}, entries: [] },
  gate: null,
  conversation: []
});

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const asRender = (value: unknown): RenderState => {
  const r = (value && typeof value === 'object' ? value : {}) as Partial<RenderState>;
  return { ...r, status: r.status || 'none', history: asArray<AssetRef>(r.history) };
};

/**
 * Fill defaults on a stored/partial document so every consumer can rely on the full
 * shape. Idempotent and non-destructive (unknown extra keys are preserved).
 */
export const normalizeDoc = (input: Partial<ComicDoc> & { id: string }): ComicDoc => {
  const base = createEmptyDoc(input.id, input.brief?.title || 'Untitled comic', input.createdAt || Date.now());
  const doc = { ...base, ...input } as ComicDoc;
  doc.v = COMIC_DOC_VERSION;
  doc.rev = typeof input.rev === 'number' ? input.rev : 0;
  doc.brief = { ...base.brief, ...(input.brief || {}), notes: asArray<string>(input.brief?.notes) };
  doc.format = { ...DEFAULT_FORMAT, ...(input.format || {}) };
  doc.source = { ...(input.source || {}) };
  const style = (input.style || {}) as Partial<StyleBible>;
  doc.style = {
    ...base.style,
    ...style,
    refs: asArray<AssetRef>(style.refs),
    options: asArray<StyleOption>(style.options).map((o) => ({ ...o, render: asRender(o.render) }))
  };
  doc.cast = asArray<Character>(input.cast).map((c) => ({
    ...c,
    tier: c.tier || 'support',
    look: { summary: '', ...(c.look || {}) },
    refs: asArray<AssetRef>(c.refs),
    sheet: asRender(c.sheet)
  }));
  doc.places = asArray<Place>(input.places).map((p) => ({
    ...p,
    look: p.look || '',
    refs: asArray<AssetRef>(p.refs),
    sheet: asRender(p.sheet)
  }));
  doc.pages = asArray<Page>(input.pages).map((p, i) => ({
    ...p,
    n: typeof p.n === 'number' ? p.n : i + 1,
    summary: p.summary || '',
    layout: p.layout || '',
    panels: asArray<Panel>(p.panels).map((panel, j) => ({
      ...panel,
      n: typeof panel.n === 'number' ? panel.n : j + 1,
      size: panel.size || 'medium',
      shot: panel.shot || 'medium',
      action: panel.action || '',
      castIds: asArray<string>(panel.castIds),
      lines: asArray<Line>(panel.lines)
    })),
    render: asRender(p.render),
    balloons: asArray<Balloon>(p.balloons)
  }));
  doc.cover = { ...(input.cover || {}), render: asRender(input.cover?.render) };
  doc.planStatus = input.planStatus || (doc.pages.length ? 'draft' : 'none');
  doc.settings = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
  const spend = (input.spend || {}) as Partial<Spend>;
  doc.spend = {
    totalUsd: typeof spend.totalUsd === 'number' ? spend.totalUsd : 0,
    byKind: { ...(spend.byKind || {}) },
    entries: asArray<SpendEntry>(spend.entries)
  };
  doc.gate = input.gate || null;
  doc.conversation = asArray<Msg>(input.conversation);
  return doc;
};

// ── Lookups ──────────────────────────────────────────────────────────────────

export const findCharacter = (doc: ComicDoc, id?: string) => (id ? doc.cast.find((c) => c.id === id) : undefined);
export const findPlace = (doc: ComicDoc, id?: string) => (id ? doc.places.find((p) => p.id === id) : undefined);
export const findPage = (doc: ComicDoc, id?: string) => (id ? doc.pages.find((p) => p.id === id) : undefined);
export const pageByNumber = (doc: ComicDoc, n: number) => doc.pages.find((p) => p.n === n);

/** Case-insensitive character lookup by name (or id), for tool calls that name characters. */
export const resolveCharacter = (doc: ComicDoc, nameOrId?: string): Character | undefined => {
  if (!nameOrId) return undefined;
  const key = nameOrId.trim().toLowerCase();
  return doc.cast.find((c) => c.id === nameOrId || c.name.trim().toLowerCase() === key);
};

/** The render state a target points at (undefined when the target no longer exists). */
export const getRender = (doc: ComicDoc, target: RenderTarget): RenderState | undefined => {
  switch (target.kind) {
    case 'page':
      return findPage(doc, target.id)?.render;
    case 'cover':
      return doc.cover.render;
    case 'sheet':
      return findCharacter(doc, target.id)?.sheet;
    case 'place':
      return findPlace(doc, target.id)?.sheet;
    case 'style_option':
      return doc.style.options.find((o) => o.id === target.id)?.render;
    default:
      return undefined;
  }
};

export const renderTargetKey = (target: RenderTarget): string =>
  target.kind === 'cover' ? 'cover' : `${target.kind}:${target.id}`;

/** Every storage path the document references (asset GC, URL signing, export). */
export const collectAssetPaths = (doc: ComicDoc): string[] => {
  const out = new Set<string>();
  const add = (a?: AssetRef) => {
    if (a?.path) out.add(a.path);
  };
  const addRender = (r?: RenderState) => {
    if (!r) return;
    add(r.asset);
    r.history.forEach(add);
  };
  doc.style.refs.forEach(add);
  add(doc.style.board);
  doc.style.options.forEach((o) => addRender(o.render));
  doc.cast.forEach((c) => {
    c.refs.forEach(add);
    addRender(c.sheet);
  });
  doc.places.forEach((p) => {
    p.refs.forEach(add);
    addRender(p.sheet);
  });
  doc.pages.forEach((p) => addRender(p.render));
  addRender(doc.cover.render);
  doc.conversation.forEach((m) => m.attachments?.forEach(add));
  return [...out];
};

/** Short, stable, dependency-free string hash (FNV-1a 32-bit, hex). */
export const hashString = (input: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

/**
 * Fingerprint of everything a page render depends on. When it changes after a
 * render, the page is shown as "stale" (out of date with its script) — never
 * silently re-rendered.
 */
export const pageSpecHash = (doc: ComicDoc, page: Page): string => {
  const castIds = new Set(page.panels.flatMap((p) => p.castIds));
  const cast = doc.cast
    .filter((c) => castIds.has(c.id))
    .map((c) => [c.id, c.look, c.sheet.asset?.path || ''])
    .sort();
  const lettering = doc.format.lettering === 'in_art' ? page.panels.map((p) => p.lines) : [];
  return hashString(
    JSON.stringify([
      page.layout,
      page.panels.map((p) => [p.size, p.shot, p.angle, p.action, p.castIds, p.placeId, p.mood]),
      lettering,
      cast,
      doc.style.spec,
      doc.style.board?.path,
      doc.format.pageAspect,
      doc.format.colorMode,
      doc.format.lettering
    ])
  );
};

/** Pages whose current render no longer matches their spec. */
export const isPageStale = (doc: ComicDoc, page: Page): boolean =>
  page.render.status === 'ready' && !!page.render.specHash && page.render.specHash !== pageSpecHash(doc, page);

export const totalPanels = (doc: ComicDoc) => doc.pages.reduce((n, p) => n + p.panels.length, 0);

let idCounter = 0;
/** Short unique id (prefix_random). Safe on server and client. */
export const newId = (prefix: string): string => {
  idCounter = (idCounter + 1) % 1679616;
  const rand =
    typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `${prefix}_${rand}${idCounter.toString(36)}`;
};
