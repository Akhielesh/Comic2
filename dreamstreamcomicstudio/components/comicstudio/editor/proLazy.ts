// The Pro shell's lazy doors (master plan §2.8: the Pro UI is never in the Easy path's first load; Easy path cost
// ≤ 5 KB gz added to the page editor's chunk). The page editor statically imports only this file, ProModeSwitch,
// shortcuts.ts and useProEditor.ts; everything the Pro view draws loads through here:
//
//   ProWorkspace.tsx    the docked workspace, the dock, the tool rail / tool row, the coach, the shortcut sheet, the
//                       phone Layers sheet, the tablet drawer and inspector sheet (with ds/Tabs and the kit's ToolButton)
//   ProTopBar.tsx       undo with its label, the zoom, the ? button (the header shows ProModeSwitch until it is in)
//   balloonTransform    the rotate and height handles, the two-finger rotate and the B9 rotation engine
//   proShapes.tsx       the Shapes tool's place layer and the B9 drop engine (only with the compose part ready)
//   proNudge.ts         the arrow fix's overlay nudge and the B9 transform engine (the first time an overlay is selected)
//
// With COMIC_PRO_EDITOR_V2 on, the page editor warms the first three in the background (preloadProShell) so the
// first switch to Pro is instant; with it off, none of them is ever requested. No network beyond the chunks, no timer.

import { useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react';
import { lazyImportWithRetry } from '../../../services/lazyImportWithRetry';
import type { BalloonTransformKit } from './balloonTransform';

const shell = () => import('./ProWorkspace');
const topBar = () => import('./ProTopBar');

// ── The balloon transform kit (handed to the balloon layer through BalloonEditorExtrasContext) ──

let kitCache: BalloonTransformKit | null = null;
let kitLoading: Promise<BalloonTransformKit | null> | null = null;

/** Load the transform kit once (a failed load is retried on the next call). */
export const loadBalloonTransformKit = (): Promise<BalloonTransformKit | null> =>
  (kitLoading ??= import('./balloonTransform').then(
    (m) => (kitCache = m.BALLOON_TRANSFORM_KIT),
    () => {
      kitLoading = null;
      return null;
    }
  ));

/** The transform kit while `on` (the Pro view shows), once loaded; null otherwise (the layer then has no handles). */
export function useBalloonTransformKit(on: boolean): BalloonTransformKit | null {
  const [kit, setKit] = useState<BalloonTransformKit | null>(kitCache);
  useEffect(() => {
    if (!on || kit) return;
    let live = true;
    void loadBalloonTransformKit().then((k) => {
      if (live && k) setKit(k);
    });
    return () => {
      live = false;
    };
  }, [on, kit]);
  return on ? kit ?? kitCache : null;
}

// ── The overlay nudge (the arrow fix; flag on or off) ──

type NudgeModule = typeof import('./proNudge');
let nudgeCache: NudgeModule | null = null;
let nudgeLoading: Promise<NudgeModule | null> | null = null;

/** The nudge module if it is in already (the key handler applies at once), else null. */
export const overlayNudgeNow = (): NudgeModule | null => nudgeCache;

/** Load the nudge module once (warmed when an overlay is selected; a failed load is retried on the next call). */
export const loadOverlayNudge = (): Promise<NudgeModule | null> =>
  (nudgeLoading ??= import('./proNudge').then(
    (m) => (nudgeCache = m),
    () => {
      nudgeLoading = null;
      return null;
    }
  ));

// ── Warming (flag on only) ──

/** Fetch the Pro view's chunks in the background (COMIC_PRO_EDITOR_V2 on): the first switch to Pro is then instant. */
export const preloadProShell = (): void => {
  void shell().catch(() => undefined);
  void topBar().catch(() => undefined);
  void loadBalloonTransformKit();
};

// ── The lazy components (each under a <Suspense> in the page editor) ──

type ShellModule = typeof import('./ProWorkspace');
type ShellPiece = 'ProDockedWorkspace' | 'ProToolRow' | 'ProTabletPanels' | 'ProLayersSheet' | 'ProCoach' | 'ShortcutSheet';
/** One lazy component of the Pro workspace module (one chunk for all of them). */
const fromShell = <K extends ShellPiece>(name: K) =>
  lazyImportWithRetry(() => shell().then((m) => ({ default: m[name] as unknown as ComponentType<never> }))) as unknown as LazyExoticComponent<ShellModule[K]>;

export const ProDockedWorkspaceLazy = fromShell('ProDockedWorkspace');
export const ProToolRowLazy = fromShell('ProToolRow');
export const ProTabletPanelsLazy = fromShell('ProTabletPanels');
export const ProLayersSheetLazy = fromShell('ProLayersSheet');
export const ProCoachLazy = fromShell('ProCoach');
export const ShortcutSheetLazy = fromShell('ShortcutSheet');
export const ProTopBarLazy = lazyImportWithRetry(() => topBar().then((m) => ({ default: m.ProTopBar })));
export const ShapePlaceLayerLazy = lazyImportWithRetry(() => import('./proShapes').then((m) => ({ default: m.ShapePlaceLayer })));
