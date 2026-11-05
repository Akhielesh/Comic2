// Feature action registry (contract §12.1; created in wave 0 by P0-B, FROZEN in wave 1).
//
// jobs.ts startAction() dispatches every non-core StudioAction type through here. Core
// actions (the five image spends, the page re-check, gates, styles, plan, patch, restore, relayout, cancel)
// stay in jobs.ts and can never be registered by a feature.

import { NON_SPEND_ACTION_TYPES, SPEND_ACTION_TYPES } from '../../../../shared/comic/ops.js';
import { createKeyedRegistry, type ActionHandler } from '../extensions.js';
import { BREAKDOWN_ACTIONS } from './breakdown.js';
import { I18N_ACTIONS } from './i18n.js';
import { LIBRARY_ACTIONS } from './library.js';
import { MODELS_ACTIONS } from './models.js';
import { PUBLISH_ACTIONS } from './publish.js';
import { REFS_ACTIONS } from './refs.js';
import { SAFETY_ACTIONS } from './safety.js';
import { TIMELINE_ACTIONS } from './timeline.js';
// --- history (versions plan §3.3; H0 stubs, H3 and H7 replace them) ---
import { HISTORY_ACTIONS } from './history.js';
import { HISTORY_ALTERNATIVE_ACTIONS } from './historyAlternatives.js';
// --- Ship 2 (pro plan §5.3; K2b stubs: B2 panels, B7 consistency, B8 panelFix + editor replace them in place) ---
import { CONSISTENCY_ACTIONS } from './consistency.js';
import { EDITOR_ACTIONS } from './editor.js';
import { PANEL_FIX_ACTIONS } from './panelFix.js';
import { PANELS_ACTIONS } from './panels.js';

/**
 * Ship 2 (pro plan §5.3): a Ship 2 action joins the registries once shared/comic/doc.ts names it among the StudioAction
 * types (SPEND_ACTION_TYPES / NON_SPEND_ACTION_TYPES; K2b wave note) — the moment a client may send it. Until then
 * jobs.ts dispatches the same handlers itself for server-started actions (startAction), and the registries are exactly
 * what they were.
 */
const knownActionType = (type: string): boolean => SPEND_ACTION_TYPES.has(type) || NON_SPEND_ACTION_TYPES.has(type);

/** Action types handled by jobs.ts itself. fix_panel (Ship 2) is an image spend on the core spend pipeline: its gate,
 *  budget, lock, preflight and reservation are jobs.ts's; actions/panelFix.ts supplies the hooks. */
export const CORE_ACTION_TYPES: ReadonlySet<string> = new Set([
  'render_style_options', 'render_sheets', 'render_pages', 'edit_page', 'render_cover',
  'approve_gate', 'decline_gate', 'pick_style', 'plan_pages', 'approve_plan', 'patch', 'restore_render',
  'relayout_balloons', 'recheck_page', 'cancel',
  ...['fix_panel'].filter(knownActionType)
]);

/** The Ship 2 feature handlers (stubs until B2, B7, B8 replace them), listed once their types are known. */
const SHIP2_ACTIONS = (): ActionHandler[] => [...PANELS_ACTIONS, ...CONSISTENCY_ACTIONS, ...EDITOR_ACTIONS, ...PANEL_FIX_ACTIONS].filter((h) => knownActionType(h.type));

const registry = createKeyedRegistry<ActionHandler>({
  what: 'action',
  keyOf: (h) => h.type,
  reserved: CORE_ACTION_TYPES,
  lists: () => [
    TIMELINE_ACTIONS,
    BREAKDOWN_ACTIONS,
    SAFETY_ACTIONS,
    PUBLISH_ACTIONS,
    I18N_ACTIONS,
    REFS_ACTIONS,
    LIBRARY_ACTIONS,
    MODELS_ACTIONS,
    HISTORY_ACTIONS,
    HISTORY_ALTERNATIVE_ACTIONS,
    SHIP2_ACTIONS()
  ]
});

/** type → handler for every feature action (null-prototype object). */
export const ACTION_HANDLERS: Record<string, ActionHandler> = registry.table;

/** The handler for a feature action type, or undefined (core and unknown types). Prototype-safe. */
export const actionHandlerFor = (type: string): ActionHandler | undefined => registry.get(type);
