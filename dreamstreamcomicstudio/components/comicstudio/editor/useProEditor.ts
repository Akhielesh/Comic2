// The Pro shell's state (master plan §2.2, §2.7; PE-SHELL): the Easy | Pro view, the tool, the coach cards, the shortcut
// sheet and which PE-0 parts mount. One hook for the page editor, so the header switch, the tool rail, the workspace and
// the keyboard agree.
//
// Rules it keeps:
//  - One concept (zero-confusion rule 1): switching calls studio.setMode and never sends an op — the document, the
//    engine and the undo stack are the same in Easy and in Pro.
//  - Flag off (COMIC_PRO_EDITOR_V2): `on` is false and the view is exactly today's (studio.mode, gated by caps.proEditor).
//  - Phones (D7, collisions C-18): the first open on a phone shows Easy, then the device's own last choice. The choice
//    is the ONE per-device key useStudioMode already keeps (localStorage `comicstudio.mode`, read here through its
//    readStoredMode, read-only): until it holds a value a phone opens in Easy, after that it follows studio.mode like
//    every other layout — so a Pro choice made on the Pages switch (DS-R10) or in another tab is the editor's too.
//  - A part mounts only when its `part.ready` is true AND the flag is on (an unfinished part never shows).
//  - "Pro" is never "paid": nothing here reads a price, a tier or the spend gate.
//  - This file is on the Easy path (the page editor imports it statically), so it reads the parts' flags only: the kit,
//    compose and stage parts by name (`part`, tree-shaken from their barrels), the panel parts as their tiny index
//    modules. Everything the Pro view draws loads through editor/proLazy.ts (master plan §2.8).
//
// The parts' mount contract (PE-INSPECT, PE-ASSETS, PE-ANIMATE fill their stubs; collisions B-16):
//   export const part: ProEditPart                                    (PE-0, already there)
//   export const loadPanel = () => import('./Panel')                  (inspector, layers, assets, animate: the panel
//                                                                       module exports `Panel: ComponentType<ProPanelProps>`;
//                                                                       the shell mounts it lazily, so index.ts stays tiny
//                                                                       and the panel never rides in the Easy path)
//   export const Panel: React.ComponentType<ProPanelProps>            (accepted too — a stand-in or a test stub — but a
//                                                                       real panel exported statically from index.ts
//                                                                       would load with every page editor)
//   export const samples: readonly ProSample[]                        (assets only: the "Start from a sample" entry)
// The shell reads them through `partModule` below, so a stub without a panel simply mounts nothing.

import { createContext, lazy, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type { ComicDoc, Page } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import type { LetterPlan } from '../../../shared/comic/lettering/layout';
import { proEditorV2On, proMotionOn, readerMotionOn, type StudioMode } from '../../../shared/comic/capabilities';
import { IN_ART_LETTERING_NOTE, type ProEditPart, type ProEditPartId, type ProSample } from '../../../shared/comic/pro/types';
import type { PatchOptions, StudioController, StudioPresence } from '../types';
import type { EditorLayoutKind, ProWorkspaceLayout } from '../mobile/editor/editorModel';
import type { Placements } from '../lettering/useLetterPlans';
import { readStoredMode } from '../useStudioMode';
import * as inspectorModule from './inspector';
import * as layersModule from './layers';
import * as assetsModule from './assets';
import * as animateModule from './animate';
import { part as stagePart } from './stage';
import { part as kitPart } from './kit/part';
import { part as composePart } from '../compose';
import { PRO_TOOL_IDS, isLetteringTool, type ProTool } from './keys';

// ── The parts ────────────────────────────────────────────────────────────────

/** What the shell hands a mounted Pro panel (Properties, Layers, Assets, Animate). Every edit it makes is free. */
export interface ProPanelProps {
  studio: StudioController;
  /** The doc as shown (a translated edition applied when one is being edited). */
  doc: ComicDoc;
  /** The stored doc (writes go to it; editions through `apply`). */
  sourceDoc: ComicDoc;
  /** The page as shown, and as stored. */
  page: Page;
  sourcePage: Page;
  /** Page aspect (width / height) and the plan height (width is 1000). */
  aspect: number;
  H: number;
  /** The drawn plans (not drafts) and the placements behind them (useLetterPlans). */
  plans: readonly LetterPlan[];
  placements: Placements;
  /** The selected balloons (reading order, primary first). */
  selection: { ids: readonly string[]; set(ids: string[]): void; clear(): void };
  /**
   * Select overlays (the Layers panel): the balloon selection is cleared first, then the studio selection becomes
   * {pageId, lineIds: [], layerIds}, so the arrows nudge them (graft 4) and the balloon mirror never wipes it. [] clears.
   */
  selectLayers(ids: readonly string[]): void;
  /** Free, undoable, labelled edits (in an edition they land in it). Never editActionFor, never studio.act. */
  apply(ops: DocOp[], opts?: PatchOptions): void;
  /** Open the inline text editor on a balloon. */
  onEditText(lineId: string): void;
  /** The translated edition being edited (undefined for the original). */
  editionLang?: string;
  /** The editor's view and layout. */
  mode: StudioMode;
  layout: EditorLayoutKind;
  /** Where the director is editing (A4), for the Layers badge. */
  presence?: StudioPresence | null;
  /** The footer every Pro panel reads (PRO_FREE_FOOTER); the shell draws it under the panel. */
  footer: string;
}

/** A PE-0 part module as the shell reads it (see the header). */
export interface ProPartModule {
  part: ProEditPart;
  /** The panel, loaded lazily (the module it imports exports `Panel`). */
  loadPanel?: () => Promise<{ Panel: React.ComponentType<ProPanelProps> }>;
  /** The panel, there already (stand-ins, test stubs). */
  Panel?: React.ComponentType<ProPanelProps>;
  samples?: readonly ProSample[];
}

// The flag-only parts, by name (their barrels' controls are tree-shaken away).
const KIT: ProPartModule = { part: kitPart };
const STAGE: ProPartModule = { part: stagePart };
const COMPOSE: ProPartModule = { part: composePart };

/** The part modules, read through one door (tests mock the stub files to stub a ready part). */
export const partModule = (id: ProEditPartId): ProPartModule => {
  switch (id) {
    case 'inspector':
      return inspectorModule as unknown as ProPartModule;
    case 'layers':
      return layersModule as unknown as ProPartModule;
    case 'assets':
      return assetsModule as unknown as ProPartModule;
    case 'animate':
      return animateModule as unknown as ProPartModule;
    case 'stage':
      return STAGE;
    case 'kit':
      return KIT;
    case 'compose':
    default:
      return COMPOSE;
  }
};

/** One lazy component per part module (React.lazy must not be recreated per render). */
const lazyPanels = new WeakMap<object, React.ComponentType<ProPanelProps>>();
/** A part's panel: its `Panel`, else a lazy one over `loadPanel`, else none. Render it under a <Suspense>. */
export const panelOf = (mod: ProPartModule): React.ComponentType<ProPanelProps> | undefined => {
  if (mod.Panel) return mod.Panel;
  const load = mod.loadPanel;
  if (typeof load !== 'function') return undefined;
  let p = lazyPanels.get(mod);
  if (!p) {
    p = lazy(() => load().then((m) => ({ default: m.Panel })));
    lazyPanels.set(mod, p);
  }
  return p;
};

/**
 * A stand-in for the part modules (the QA harness's Pro scenes and tests mount stubbed READY parts through it); null =
 * the real modules. Production code never provides it.
 */
export const ProPartsContext = createContext<((id: ProEditPartId) => ProPartModule) | null>(null);

/** A part mounts only when it says it is ready AND the workspace flag is on. */
export const partMounts = (mod: Pick<ProPartModule, 'part'> | undefined, flag: boolean): boolean => flag && !!mod && mod.part?.ready === true;

/** The mounted panels (absent ones are undefined): what the dock, the left rail and the phone sheet show. */
export interface MountedParts {
  inspector?: React.ComponentType<ProPanelProps>;
  layers?: React.ComponentType<ProPanelProps>;
  assets?: React.ComponentType<ProPanelProps>;
  animate?: React.ComponentType<ProPanelProps>;
  /** Overlays draw (the compose tree is ready): the Shapes tool can add one the creator will see. */
  compose: boolean;
  /** "Start from a sample" exists only when the assets part has samples (PE-ASSETS, S3). */
  samples: readonly ProSample[];
}

export const mountedParts = (flag: boolean, motion: boolean, read: (id: ProEditPartId) => ProPartModule = partModule): MountedParts => {
  const panel = (id: ProEditPartId) => {
    const mod = read(id);
    return partMounts(mod, flag) ? panelOf(mod) : undefined;
  };
  const assets = read('assets');
  return {
    inspector: panel('inspector'),
    layers: panel('layers'),
    assets: panel('assets'),
    animate: motion ? panel('animate') : undefined,
    compose: partMounts(read('compose'), flag),
    samples: partMounts(assets, flag) && Array.isArray(assets.samples) ? assets.samples : []
  };
};

// ── The view (D7) ────────────────────────────────────────────────────────────

/**
 * The editor's view. Flag off: exactly today (studio.mode, Easy without caps.proEditor). Flag on: a phone shows Easy
 * until this device has a stored choice (`stored`: useStudioMode's readStoredMode(), null on the first open), then
 * studio.mode; every other layout follows studio.mode. Pure.
 */
export const editorViewFor = (o: { flag: boolean; canPro: boolean; phone: boolean; studioMode: StudioMode | undefined; stored: StudioMode | null }): StudioMode => {
  if (!o.canPro) return 'easy';
  if (!o.flag || !o.phone) return o.studioMode ?? 'easy';
  return o.stored !== null ? o.studioMode ?? 'easy' : 'easy';
};

// ── Coach cards (§2.2 rule 5) ────────────────────────────────────────────────

export type ProCoachId = 'layers' | 'effects' | 'animate';
export interface ProCoachCard {
  id: ProCoachId;
  title: string;
  body: string;
}

export const PRO_COACH_CARDS: readonly ProCoachCard[] = [
  { id: 'layers', title: 'Layers', body: 'Every balloon and overlay on the page in reading order. Pick one, hide it in this view, or lock it so it stays put.' },
  { id: 'effects', title: 'Effects & assets', body: 'Speed lines, bursts, looks and sound-effect words, ready to drop on the page. Each one is a free edit you can undo.' },
  // Readers play motion only with COMIC_READER_MOTION (master plan §2.10; off by default): the honest default copy
  // promises the preview and the video, and "Readers see it too." joins it only when reader motion is on.
  { id: 'animate', title: 'Animate', body: 'Give a balloon or an effect an entrance you can preview here and export as video.' }
];

/** The Animate card's extra line, only while readers play motion (caps.readerMotion). */
export const PRO_COACH_READERS_LINE = 'Readers see it too.';

const COACH_IDS: readonly ProCoachId[] = ['layers', 'effects', 'animate'];
const isCoachId = (v: unknown): v is ProCoachId => typeof v === 'string' && (COACH_IDS as readonly string[]).includes(v);

/**
 * localStorage key: the Pro tips dismissed on this device, as a JSON array of card ids (a card for a part that mounts
 * later — Effects & assets, Animate — still shows once). "Show the Pro tips again" clears it.
 */
export const PRO_COACH_KEY = 'comicstudio.editor.proTips';

/** The dismissed card ids (try/catch: blocked storage or a bad value is "none dismissed"). */
export const readDismissedTips = (): ProCoachId[] => {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(PRO_COACH_KEY) : null;
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? [...new Set(v.filter(isCoachId))] : [];
  } catch {
    return [];
  }
};

export const writeDismissedTips = (ids: readonly ProCoachId[]): void => {
  try {
    if (ids.length) window.localStorage.setItem(PRO_COACH_KEY, JSON.stringify([...new Set(ids)]));
    else window.localStorage.removeItem(PRO_COACH_KEY);
  } catch {
    /* not persisted: the tips come back next time */
  }
};

/**
 * The cards whose part is mounted (a tip about something the creator cannot see yet is never shown); the Animate card
 * says readers see it only with reader motion on. Pure.
 */
export const coachCardsFor = (parts: Pick<MountedParts, 'layers' | 'assets' | 'animate'>, opts: { readerMotion?: boolean } = {}): ProCoachCard[] =>
  PRO_COACH_CARDS.filter((c) => (c.id === 'layers' ? !!parts.layers : c.id === 'effects' ? !!parts.assets : !!parts.animate)).map((c) =>
    c.id === 'animate' && opts.readerMotion ? { ...c, body: `${c.body} ${PRO_COACH_READERS_LINE}` } : c
  );

/**
 * The mounted panels the creator can REACH on this layout (a tip never describes a panel with no way in): docked, the
 * dock and the left rail hold Layers, Assets and the timeline; the 768 tablet's tool row opens Layers and Assets in its
 * drawer (no timeline there in S2); phones have the thumb bar's Layers button only. Pure.
 */
export const reachableParts = (parts: Pick<MountedParts, 'layers' | 'assets' | 'animate'>, workspace: ProWorkspaceLayout['kind']): Pick<MountedParts, 'layers' | 'assets' | 'animate'> =>
  workspace === 'docked'
    ? { layers: parts.layers, assets: parts.assets, animate: parts.animate }
    : workspace === 'tool-row'
      ? { layers: parts.layers, assets: parts.assets }
      : { layers: parts.layers };

// ── The hook ─────────────────────────────────────────────────────────────────

export interface ProEditorState {
  /** COMIC_PRO_EDITOR_V2 is on for this user. */
  on: boolean;
  /** caps.proEditor (true for everyone today). */
  canPro: boolean;
  /** The editor's view. */
  view: StudioMode;
  /** on && view === 'pro': the Pro workspace shows. */
  pro: boolean;
  /** Switch the view: studio.setMode (and, on phones, this device's memory). Never an op. */
  setView(mode: StudioMode): void;
  toggleView(): void;
  tool: ProTool;
  setTool(tool: ProTool): void;
  /** Tools the rail shows (the Shapes tool needs the compose part) and the reason a shown one is off. */
  tools: readonly ProTool[];
  disabled: Partial<Record<ProTool, string>>;
  parts: MountedParts;
  /** `cards`: the tips to show now (reachable, not dismissed); `all`: every reachable tip (what "again" brings back). */
  coach: { cards: ProCoachCard[]; all: ProCoachCard[]; open: boolean; dismiss(): void; reopen(): void };
  help: { open: boolean; toggle(): void; close(): void };
}

export interface ProEditorOptions {
  pageId: string;
  phone: boolean;
  /** The comic's lettering is drawn into the art (no editable text). */
  inArt: boolean;
  /** The page has no drawing yet, or its art is blocked: Mark up needs art. */
  markupOff?: string;
  /** How the Pro view lays out this window (proWorkspaceFor): which panels a coach card can point at. Default: phone ? 'phone' : 'docked'. */
  workspace?: ProWorkspaceLayout['kind'];
}

export function useProEditor(studio: Pick<StudioController, 'caps' | 'mode' | 'setMode'>, opts: ProEditorOptions, readArg?: (id: ProEditPartId) => ProPartModule): ProEditorState {
  const override = useContext(ProPartsContext);
  const read = readArg ?? override ?? partModule;
  const on = proEditorV2On(studio.caps);
  const canPro = studio.caps?.proEditor !== false;
  const motion = proMotionOn(studio.caps);
  const readerMotion = readerMotionOn(studio.caps);
  // D7: has this device a stored Easy/Pro choice yet (useStudioMode's key)? Re-read when the studio's view changes
  // (a switch here, on the Pages toolbar or in another tab writes it).
  const [chosen, setChosen] = useState(() => readStoredMode() !== null);
  useEffect(() => {
    if (!chosen && readStoredMode() !== null) setChosen(true);
  }, [studio.mode, chosen]);
  const view = editorViewFor({ flag: on, canPro, phone: opts.phone, studioMode: studio.mode, stored: chosen ? studio.mode ?? 'easy' : null });
  const pro = on && view === 'pro';

  const setView = useCallback(
    (mode: StudioMode) => {
      if (mode !== 'easy' && mode !== 'pro') return;
      if (mode === 'pro' && !canPro) return;
      // studio.setMode stores the choice on this device (useStudioMode); from now on a phone follows it.
      if (on && opts.phone) setChosen(true);
      studio.setMode?.(mode);
    },
    [studio, on, canPro, opts.phone]
  );
  const toggleView = useCallback(() => setView(view === 'pro' ? 'easy' : 'pro'), [setView, view]);

  const parts = useMemo(() => mountedParts(on, motion, read), [on, motion, read]);
  const tools = useMemo(() => PRO_TOOL_IDS.filter((id) => id !== 'shapes' || parts.compose), [parts.compose]);
  const disabled = useMemo(() => {
    const out: Partial<Record<ProTool, string>> = {};
    if (opts.inArt) for (const t of PRO_TOOL_IDS) if (isLetteringTool(t)) out[t] = IN_ART_LETTERING_NOTE;
    if (opts.markupOff) out.markup = opts.markupOff;
    return out;
  }, [opts.inArt, opts.markupOff]);

  const [tool, setToolState] = useState<ProTool>('select');
  const setTool = useCallback((t: ProTool) => setToolState(t), []);
  // A tool that went away (the part unmounted) or turned off falls back to Select.
  useEffect(() => {
    if (!tools.includes(tool) || disabled[tool]) setToolState('select');
  }, [tools, tool, disabled]);

  const workspace = opts.workspace ?? (opts.phone ? 'phone' : 'docked');
  const all = useMemo(() => coachCardsFor(reachableParts(parts, workspace), { readerMotion }), [parts, workspace, readerMotion]);
  const [dismissed, setDismissed] = useState<ProCoachId[]>(readDismissedTips);
  const cards = useMemo(() => all.filter((c) => !dismissed.includes(c.id)), [all, dismissed]);
  const coachOpen = pro && cards.length > 0;
  const coach = useMemo(
    () => ({
      cards,
      all,
      open: coachOpen,
      // "Got it" dismisses the tips shown now; a tip for a part that mounts later still shows once.
      dismiss: () => {
        const next = [...new Set([...dismissed, ...cards.map((c) => c.id)])];
        setDismissed(next);
        writeDismissedTips(next);
      },
      reopen: () => {
        setDismissed([]);
        writeDismissedTips([]);
      }
    }),
    [cards, all, coachOpen, dismissed]
  );

  const [helpOpen, setHelpOpen] = useState(false);
  const help = useMemo(() => ({ open: on && helpOpen, toggle: () => setHelpOpen((v) => !v), close: () => setHelpOpen(false) }), [on, helpOpen]);

  return { on, canPro, view, pro, setView, toggleView, tool, setTool, tools, disabled, parts, coach, help };
}
