// The Pro shell's state (master plan §2.2, §2.7; PE-SHELL): the Easy | Pro view, the tool, the coach cards, the shortcut
// sheet and which PE-0 parts mount. One hook for the page editor, so the header switch, the tool rail, the workspace and
// the keyboard agree.
//
// Rules it keeps:
//  - One concept (zero-confusion rule 1): switching calls studio.setMode and never sends an op — the document, the
//    engine and the undo stack are the same in Easy and in Pro.
//  - Flag off (COMIC_PRO_EDITOR_V2): `on` is false and the view is exactly today's (studio.mode, gated by caps.proEditor).
//  - Phones (D7, collisions C-18): the first open on a phone shows Easy, then the editor remembers the last choice on
//    that device (localStorage `comicstudio.editor.mode`, try/catch). useStudioMode.ts is not this package's, so the
//    per-device memory lives here; other layouts follow studio.mode as today.
//  - A part mounts only when its `part.ready` is true AND the flag is on (an unfinished part never shows).
//  - "Pro" is never "paid": nothing here reads a price, a tier or the spend gate.
//
// The parts' mount contract (PE-INSPECT, PE-ASSETS, PE-ANIMATE fill their stubs; collisions B-16):
//   export const part: ProEditPart            (PE-0, already there)
//   export const Panel: React.ComponentType<ProPanelProps>   (inspector, layers, assets, animate)
//   export const samples: readonly ProSample[]               (assets only: the "Start from a sample" entry)
// The shell reads them through `partModule` below, so a stub without `Panel` simply mounts nothing.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type { ComicDoc, Page } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import type { LetterPlan } from '../../../shared/comic/lettering/layout';
import { proEditorV2On, proMotionOn, type StudioMode } from '../../../shared/comic/capabilities';
import { IN_ART_LETTERING_NOTE, type ProEditPart, type ProEditPartId, type ProSample } from '../../../shared/comic/pro/types';
import type { PatchOptions, StudioController, StudioPresence } from '../types';
import type { EditorLayoutKind } from '../mobile/editor/editorModel';
import type { Placements } from '../lettering/useLetterPlans';
import * as inspectorModule from './inspector';
import * as layersModule from './layers';
import * as assetsModule from './assets';
import * as animateModule from './animate';
import * as stageModule from './stage';
import * as kitModule from './kit';
import * as composeModule from '../compose';
import { PRO_TOOLS, isLetteringTool, type ProTool } from './shortcuts';

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
  Panel?: React.ComponentType<ProPanelProps>;
  samples?: readonly ProSample[];
}

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
      return stageModule as unknown as ProPartModule;
    case 'kit':
      return kitModule as unknown as ProPartModule;
    case 'compose':
    default:
      return composeModule as unknown as ProPartModule;
  }
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
    return partMounts(mod, flag) && mod.Panel ? mod.Panel : undefined;
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

/** localStorage key of the editor's last view on THIS device (phones; D7). */
export const EDITOR_MODE_KEY = 'comicstudio.editor.mode';

export const readEditorMode = (): StudioMode | null => {
  try {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(EDITOR_MODE_KEY) : null;
    return v === 'easy' || v === 'pro' ? v : null;
  } catch {
    return null;
  }
};

export const writeEditorMode = (mode: StudioMode): void => {
  try {
    window.localStorage.setItem(EDITOR_MODE_KEY, mode);
  } catch {
    /* not persisted (private mode, blocked storage): the view still switches for this session */
  }
};

/**
 * The editor's view. Flag off: exactly today (studio.mode, Easy without caps.proEditor). Flag on: phones show the last
 * choice made on this device, else Easy (first open); every other layout follows studio.mode. Pure.
 */
export const editorViewFor = (o: { flag: boolean; canPro: boolean; phone: boolean; studioMode: StudioMode | undefined; stored: StudioMode | null }): StudioMode => {
  if (!o.canPro) return 'easy';
  if (!o.flag || !o.phone) return o.studioMode ?? 'easy';
  return o.stored ?? 'easy';
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
  { id: 'animate', title: 'Animate', body: 'Give a balloon or an effect an entrance that plays when readers reach it. Press Play to preview; nothing changes the art.' }
];

/** localStorage key: the Pro tips were dismissed on this device. */
export const PRO_COACH_KEY = 'comicstudio.editor.proTips';

const readFlag = (key: string): string | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
};
const writeFlag = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* not persisted */
  }
};

/** The cards whose part is mounted (a tip about something the creator cannot see yet is never shown). Pure. */
export const coachCardsFor = (parts: Pick<MountedParts, 'layers' | 'assets' | 'animate'>): ProCoachCard[] =>
  PRO_COACH_CARDS.filter((c) => (c.id === 'layers' ? !!parts.layers : c.id === 'effects' ? !!parts.assets : !!parts.animate));

// ── "Edit lettering" (§2.2 Entry) ────────────────────────────────────────────

/** One pending "open the editor with this tool" request (the Pages card's Edit lettering), consumed once. */
let pendingTool: { pageId: string; tool: ProTool } | null = null;

/** Ask the next page editor opened on `pageId` to start with `tool` selected (then open it). */
export const requestEditorTool = (pageId: string, tool: ProTool): void => {
  pendingTool = { pageId, tool };
};

/** The tool asked for this page, once (null when none, or for another page). */
export const takeEditorTool = (pageId: string): ProTool | null => {
  const p = pendingTool;
  if (!p || p.pageId !== pageId) return null;
  pendingTool = null;
  return p.tool;
};

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
  coach: { cards: ProCoachCard[]; open: boolean; dismiss(): void; reopen(): void };
  help: { open: boolean; toggle(): void; close(): void };
}

export interface ProEditorOptions {
  pageId: string;
  phone: boolean;
  /** The comic's lettering is drawn into the art (no editable text). */
  inArt: boolean;
  /** The page has no drawing yet, or its art is blocked: Mark up needs art. */
  markupOff?: string;
}

export function useProEditor(studio: Pick<StudioController, 'caps' | 'mode' | 'setMode'>, opts: ProEditorOptions, readArg?: (id: ProEditPartId) => ProPartModule): ProEditorState {
  const override = useContext(ProPartsContext);
  const read = readArg ?? override ?? partModule;
  const on = proEditorV2On(studio.caps);
  const canPro = studio.caps?.proEditor !== false;
  const motion = proMotionOn(studio.caps);
  const [stored, setStored] = useState<StudioMode | null>(() => (on && opts.phone ? readEditorMode() : null));
  const view = editorViewFor({ flag: on, canPro, phone: opts.phone, studioMode: studio.mode, stored });
  const pro = on && view === 'pro';

  const setView = useCallback(
    (mode: StudioMode) => {
      if (mode !== 'easy' && mode !== 'pro') return;
      if (mode === 'pro' && !canPro) return;
      if (on && opts.phone) {
        writeEditorMode(mode);
        setStored(mode);
      }
      studio.setMode?.(mode);
    },
    [studio, on, canPro, opts.phone]
  );
  const toggleView = useCallback(() => setView(view === 'pro' ? 'easy' : 'pro'), [setView, view]);

  const parts = useMemo(() => mountedParts(on, motion, read), [on, motion, read]);
  const tools = useMemo(() => PRO_TOOLS.map((t) => t.id).filter((id) => id !== 'shapes' || parts.compose), [parts.compose]);
  const disabled = useMemo(() => {
    const out: Partial<Record<ProTool, string>> = {};
    if (opts.inArt) for (const t of PRO_TOOLS) if (isLetteringTool(t.id)) out[t.id] = IN_ART_LETTERING_NOTE;
    if (opts.markupOff) out.markup = opts.markupOff;
    return out;
  }, [opts.inArt, opts.markupOff]);

  const [tool, setToolState] = useState<ProTool>(() => takeEditorTool(opts.pageId) ?? 'select');
  const setTool = useCallback((t: ProTool) => setToolState(t), []);
  // A tool that went away (the part unmounted) or turned off falls back to Select.
  useEffect(() => {
    if (!tools.includes(tool) || disabled[tool]) setToolState('select');
  }, [tools, tool, disabled]);

  const cards = useMemo(() => coachCardsFor(parts), [parts]);
  const [coachDismissed, setCoachDismissed] = useState(() => readFlag(PRO_COACH_KEY) === '1');
  const [coachForced, setCoachForced] = useState(false);
  const coachOpen = pro && cards.length > 0 && (coachForced || !coachDismissed);
  const coach = useMemo(
    () => ({
      cards,
      open: coachOpen,
      dismiss: () => {
        setCoachDismissed(true);
        setCoachForced(false);
        writeFlag(PRO_COACH_KEY, '1');
      },
      reopen: () => setCoachForced(true)
    }),
    [cards, coachOpen]
  );

  const [helpOpen, setHelpOpen] = useState(false);
  const help = useMemo(() => ({ open: on && helpOpen, toggle: () => setHelpOpen((v) => !v), close: () => setHelpOpen(false) }), [on, helpOpen]);

  return { on, canPro, view, pro, setView, toggleView, tool, setTool, tools, disabled, parts, coach, help };
}
