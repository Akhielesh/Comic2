// The pro editor's engine (Ship 2, B9; pro plan §4.5): pure functions shared by the editor canvas (C1), lettering
// (C2), the confidence surfaces (C4) and the director's layout tools (B10). No React, no server imports, no clock.
//
// scene        the page's objects in bands (page → art → overlays → lettering), z within a band, hit tests
// transform    move / resize / rotate math, overlay and balloon edits
// snap         snap targets (margins, safe area, frames, gutters, objects, guides) and equal spacing
// align        align and distribute balloons and overlays
// frames       gutter drag, resize, split, join, add, delete, close gap, equalize, make biggest, close-up, takes,
//              swap pictures, crop
// templates    the twelve layouts (+ webtoon stacks) with fit dots and "Best fit"
// layoutText   frames ↔ the layout sentence parseLayout reads
// drop         what a drop from the asset bin does (ops, label, cost)
// checks       the per-page checklist (ok / look / unknown) with free fixes first
// readingOrder z-pattern reading order of frames and balloons, with the free fix
//
// Every edit returns K2a ops and their inverse from the one undo path (undo.ts inverseOps).

export * from './scene.js';
export * from './transform.js';
export * from './snap.js';
export * from './align.js';
export * from './frames.js';
export * from './templates.js';
export * from './layoutText.js';
export * from './drop.js';
export * from './checks.js';
export * from './readingOrder.js';
