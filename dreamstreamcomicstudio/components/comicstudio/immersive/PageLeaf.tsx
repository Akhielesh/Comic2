// The turning leaf's extra layers (reader.md §3.3), mounted only while a turn runs: the cast shadow
// over the revealed page, the flap's drop shadow, the paper back face for single-page turns, and the
// blank paper leaves of a riffle. Their per-frame styles are written by the turn engine (leafEngine.ts)
// through the refs collected here; React renders them once per turn.

import React from 'react';
import { BAND_REACH } from './flipGeometry';
import type { LeafPart } from './leafEngine';
import { CAST_GRADIENT, CURL_GRADIENT } from './ReaderSlot';
import { PaperBack } from './PaperBack';

export interface LeafExtraRefs {
  castBox: HTMLDivElement | null;
  cast: HTMLDivElement | null;
  shadow: HTMLDivElement | null;
  /** Single-page back face (paper or inside cover). */
  back: LeafPart;
  /** Riffle paper leaves: fronts and backs by leaf index. */
  riffleFronts: LeafPart[];
  riffleBacks: LeafPart[];
}

export const emptyLeafRefs = (): LeafExtraRefs => ({ castBox: null, cast: null, shadow: null, back: { root: null }, riffleFronts: [], riffleBacks: [] });

export interface PageLeafProps {
  refs: React.MutableRefObject<LeafExtraRefs>;
  /** Page box. */
  W: number;
  H: number;
  /** Book x of the turning page's slot (front) and of where its back face lands. */
  frontX: number;
  backX: number;
  /** Single-page back face: paper with the front's ink showing through, or the inside cover. */
  backExtra?: 'paper' | 'endpaper';
  /** The front page's image for the show-through (mirrored, faint). */
  showThroughSrc?: string;
  showThroughBox?: { x: number; y: number; w: number; h: number };
  paperTexture: boolean;
  dedication?: string;
  /** Riffle: number of leaves (paper fronts for 1..n−1, paper backs for 0..n−2). */
  riffle?: number;
  /** Riffle stacking order (forward: earlier fronts on top; reverse: later fronts on top). */
  mode: 'forward' | 'reverse';
  /** A board (hardcover) turn: no flap shadow, the cast is a soft wash from the spine. */
  board: boolean;
}

const part = (): LeafPart => ({ root: null, curl: null, shade: null });

/** A blank paper leaf face (riffles). */
const PaperFace: React.FC<{ x: number; W: number; H: number; z: number; setRef: (p: LeafPart) => void; texture: boolean }> = ({ x, W, H, z, setRef, texture }) => {
  const p = React.useRef<LeafPart>(part());
  return (
    <div
      ref={(el) => {
        p.current.root = el;
        setRef(p.current);
      }}
      aria-hidden
      className="pointer-events-none absolute overflow-hidden"
      style={{ left: x, top: 0, width: W, height: H, zIndex: z, visibility: 'hidden', background: 'var(--ds-reader-paper-back)', boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.14)' }}
    >
      {texture && <div className="ds-reader-paper" />}
      <div
        ref={(el) => {
          p.current.curl = el;
          setRef(p.current);
        }}
        className="pointer-events-none absolute left-0 top-0 opacity-0"
        style={{ width: W, height: BAND_REACH, transformOrigin: '0 0', background: CURL_GRADIENT }}
      />
    </div>
  );
};

export const PageLeaf: React.FC<PageLeafProps> = ({ refs, W, H, frontX, backX, backExtra, showThroughSrc, showThroughBox, paperTexture, dedication, riffle, mode, board }) => {
  const r = refs.current;
  const n = riffle && riffle > 1 ? riffle : 0;
  return (
    <>
      {/* Cast shadow over the revealed page (clipped to the turning page's slot). */}
      <div
        ref={(el) => {
          r.castBox = el;
        }}
        aria-hidden
        className="pointer-events-none absolute overflow-hidden"
        style={{ left: frontX, top: 0, width: W, height: H, zIndex: 2 }}
      >
        <div
          ref={(el) => {
            r.cast = el;
          }}
          className="absolute left-0 top-0 opacity-0"
          style={{ width: W, height: BAND_REACH, transformOrigin: '0 0', background: CAST_GRADIENT }}
        />
      </div>
      {/* The flap's drop shadow on whatever lies beneath it (same transform as the back face). */}
      {!board && (
        <div
          ref={(el) => {
            r.shadow = el;
          }}
          aria-hidden
          className="pointer-events-none absolute opacity-0"
          style={{ left: backX, top: 0, width: W, height: H, zIndex: 5, transformOrigin: '0 0', boxShadow: '0 0 26px 4px rgba(0,0,0,0.38), 0 0 6px rgba(0,0,0,0.25)' }}
        />
      )}
      {backExtra && (
        <PaperBack
          setRef={(p) => {
            r.back = p;
          }}
          x={backX}
          W={W}
          H={H}
          z={6}
          variant={backExtra}
          showThroughSrc={backExtra === 'paper' ? showThroughSrc : undefined}
          showThroughBox={showThroughBox}
          texture={paperTexture}
          dedication={backExtra === 'endpaper' ? dedication : undefined}
        />
      )}
      {n > 0 &&
        Array.from({ length: n }, (_, i) => i).map((i) => {
          const realFront = mode === 'forward' ? i === 0 : i === n - 1;
          const realBack = mode === 'forward' ? i === n - 1 : i === n - 1;
          return (
            <React.Fragment key={i}>
              {!realFront && (
                <PaperFace
                  x={frontX}
                  W={W}
                  H={H}
                  z={mode === 'forward' ? 3 + (n - i) : 3 + i}
                  texture={paperTexture}
                  setRef={(p) => {
                    r.riffleFronts[i] = p;
                  }}
                />
              )}
              {!realBack && (
                <PaperFace
                  x={backX}
                  W={W}
                  H={H}
                  z={mode === 'forward' ? 6 + i : 6 + (n - i)}
                  texture={paperTexture}
                  setRef={(p) => {
                    r.riffleBacks[i] = p;
                  }}
                />
              )}
            </React.Fragment>
          );
        })}
    </>
  );
};

