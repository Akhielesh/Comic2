// Scene thumbnails (stylized layout sketches) + the shared BRB slate.
import React from 'react';
import type { SceneId } from '../studio/compositor';

/** Tiny stylized sketch of a scene layout — used in the scene strip,
 *  the mobile scene picker and the Customize screen. */
export function SceneSketch({ kind, initial }: { kind: SceneId; initial: string }) {
  if (kind === 'brb') {
    return (
      <div className="scene brb">
        <div className="brb-orb"><span /></div>
        <div className="brb-title serif" style={{ fontSize: 11 }}>Be right back</div>
      </div>
    );
  }
  if (kind === 'screen') {
    return (
      <div className="sk">
        <div className="sk-box dim" />
        <div className="sk-pip" />
      </div>
    );
  }
  return (
    <div className="sk">
      <div className="sk-box">
        <span className="sk-initial">{initial}</span>
      </div>
    </div>
  );
}

/** Full-size branded slate viewers see while the host is away. */
export function BrbSlate({ sub }: { sub?: string }) {
  return (
    <div className="viewer-slate">
      <div className="brb-orb" style={{ width: 64, height: 64 }}><span /></div>
      <div className="vs-title serif">Be right back</div>
      {sub && <div className="vs-sub">{sub}</div>}
    </div>
  );
}
