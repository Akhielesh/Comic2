// The Pro inspector's lazily loaded half (master plan §2.8: the page editor's Easy path grows by at most 5 KB gz). The
// typed fields, the typed transform, align and distribute, Copy / Paste style, the Pro lettering controls, saved styles
// and the inspector's keys live in ProInspectorExtras.tsx, which reads the B9 scene engine (editor/scene, align,
// transform). Nothing on the Easy path imports that module: the lettering inspector and its panels ask for it here,
// only when Pro Edit is on, and draw today's controls until it arrives (one small chunk, cached after the first load).
//
// The docked inspector's loadPanel waits for it too, so the Properties tab opens complete. Tests preload it
// (`await loadProExtras()`) and then render synchronously.

import { useEffect, useState } from 'react';

export type ProExtras = typeof import('./ProInspectorExtras');

let loaded: ProExtras | undefined;
let pending: Promise<ProExtras> | undefined;

/** The Pro extras when they are already loaded (no load starts). */
export const proExtrasLoaded = (): ProExtras | undefined => loaded;

/** Load the Pro extras once (a failed load — offline — is retried on the next ask). */
export function loadProExtras(): Promise<ProExtras> {
  if (loaded) return Promise.resolve(loaded);
  pending ??= import('./ProInspectorExtras').then(
    (m) => (loaded = m),
    (e: unknown) => {
      pending = undefined;
      throw e;
    }
  );
  return pending;
}

/**
 * The Pro extras while `on` (Pro Edit), else undefined. The first render after a cold start gets undefined and the
 * component re-renders when the chunk lands; later renders get the module at once.
 */
export function useProExtras(on: boolean): ProExtras | undefined {
  const [mod, setMod] = useState<ProExtras | undefined>(loaded);
  useEffect(() => {
    if (!on || mod) return;
    let live = true;
    loadProExtras().then(
      (m) => {
        if (live) setMod(m);
      },
      () => {
        /* offline: the Pro extras stay away and today's controls keep working */
      }
    );
    return () => {
      live = false;
    };
  }, [on, mod]);
  return on ? (mod ?? loaded) : undefined;
}
