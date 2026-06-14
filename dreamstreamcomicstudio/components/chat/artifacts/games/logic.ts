// Pure game rules — no React, no canvas, no randomness baked in (RNG is injected so
// results are reproducible). Kept apart from the rendering components so the tricky
// bits (2048's slide-and-merge, snake's collision/eat step) can be unit-tested in
// isolation. See logic.test.ts.

import type { Dir } from '../kit/game';

// ───────────────────────────── 2048 ─────────────────────────────

export type Grid = number[][];

export const emptyGrid = (n = 4): Grid => Array.from({ length: n }, () => Array.from({ length: n }, () => 0));

/** Slide one row toward index 0, merging equal neighbours once each. */
export const slideRow = (row: number[]): { row: number[]; gained: number; moved: boolean } => {
  const n = row.length;
  const tiles = row.filter((v) => v !== 0);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      const merged = tiles[i] * 2;
      out.push(merged);
      gained += merged;
      i++; // consume the partner
    } else {
      out.push(tiles[i]);
    }
  }
  while (out.length < n) out.push(0);
  const moved = out.some((v, i) => v !== row[i]);
  return { row: out, gained, moved };
};

const transpose = (g: Grid): Grid => g[0].map((_, c) => g.map((r) => r[c]));
const reverseRows = (g: Grid): Grid => g.map((r) => [...r].reverse());

/** Apply a move in a direction; returns the new grid, points gained, and whether
 *  anything actually shifted (a no-op move must not spawn a tile). */
export const move = (grid: Grid, dir: Dir): { grid: Grid; gained: number; moved: boolean } => {
  let work = grid.map((r) => [...r]);
  if (dir === 'up') work = transpose(work);
  else if (dir === 'down') work = reverseRows(transpose(work));
  else if (dir === 'right') work = reverseRows(work);

  let gained = 0;
  let moved = false;
  work = work.map((r) => {
    const res = slideRow(r);
    gained += res.gained;
    if (res.moved) moved = true;
    return res.row;
  });

  if (dir === 'up') work = transpose(work);
  else if (dir === 'down') work = transpose(reverseRows(work));
  else if (dir === 'right') work = reverseRows(work);

  return { grid: work, gained, moved };
};

/** Place a tile (2 with 90% odds, else 4) on a random empty cell. */
export const spawnTile = (grid: Grid, rng: () => number = Math.random): Grid => {
  const empties: Array<[number, number]> = [];
  grid.forEach((row, r) => row.forEach((v, c) => { if (v === 0) empties.push([r, c]); }));
  if (!empties.length) return grid;
  const [r, c] = empties[Math.floor(rng() * empties.length)];
  const next = grid.map((row) => [...row]);
  next[r][c] = rng() < 0.9 ? 2 : 4;
  return next;
};

/** True while any move is still possible (an empty cell or an equal neighbour). */
export const hasMoves = (grid: Grid): boolean => {
  const n = grid.length;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r][c] === 0) return true;
      if (c + 1 < n && grid[r][c] === grid[r][c + 1]) return true;
      if (r + 1 < n && grid[r][c] === grid[r + 1][c]) return true;
    }
  }
  return false;
};

export const maxTile = (grid: Grid): number => Math.max(...grid.flat());

// ───────────────────────────── Snake ─────────────────────────────

export interface Point { x: number; y: number }

export const opposite = (a: Dir, b: Dir): boolean =>
  (a === 'up' && b === 'down') || (a === 'down' && b === 'up') ||
  (a === 'left' && b === 'right') || (a === 'right' && b === 'left');

const DELTA: Record<Dir, Point> = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 }
};

/** Advance the snake one cell. Pure: caller owns food respawn when `ate` is true.
 *  Dies on a wall or self-collision (the tail vacates unless we just ate). */
export const stepSnake = (
  snake: Point[], dir: Dir, food: Point, cols: number, rows: number
): { snake: Point[]; ate: boolean; dead: boolean } => {
  const d = DELTA[dir];
  const head = { x: snake[0].x + d.x, y: snake[0].y + d.y };
  if (head.x < 0 || head.y < 0 || head.x >= cols || head.y >= rows) {
    return { snake, ate: false, dead: true };
  }
  const ate = head.x === food.x && head.y === food.y;
  // The tail cell is free to move into unless the snake grows this step.
  const body = ate ? snake : snake.slice(0, -1);
  if (body.some((p) => p.x === head.x && p.y === head.y)) {
    return { snake, ate: false, dead: true };
  }
  const next = [head, ...snake];
  if (!ate) next.pop();
  return { snake: next, ate, dead: false };
};

// ───────────────────────────── Shared ─────────────────────────────

/** Axis-aligned bounding-box overlap test (used by Breakout). */
export const aabb = (
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number
): boolean => ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;

// ───────────────────────────── Memory ─────────────────────────────

/** Build a shuffled deck of `pairs` matching pairs (each value 0..pairs-1 twice).
 *  RNG is injected for reproducible tests. Fisher–Yates shuffle. */
export const dealMemory = (pairs: number, rng: () => number = Math.random): number[] => {
  const cards: number[] = [];
  for (let i = 0; i < pairs; i++) cards.push(i, i);
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
};
