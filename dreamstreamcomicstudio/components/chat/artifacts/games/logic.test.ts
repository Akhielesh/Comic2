import { describe, it, expect } from 'vitest';
import { slideRow, move, spawnTile, hasMoves, maxTile, emptyGrid, stepSnake, opposite, aabb } from './logic';

describe('2048 slideRow', () => {
  it('slides tiles to the front', () => {
    expect(slideRow([0, 2, 0, 2]).row).toEqual([4, 0, 0, 0]);
  });
  it('merges each pair only once', () => {
    const r = slideRow([2, 2, 2, 2]);
    expect(r.row).toEqual([4, 4, 0, 0]);
    expect(r.gained).toBe(8);
  });
  it('does not merge unequal neighbours', () => {
    expect(slideRow([2, 4, 2, 4]).row).toEqual([2, 4, 2, 4]);
  });
  it('reports no-op rows as not moved', () => {
    expect(slideRow([2, 4, 8, 16]).moved).toBe(false);
    expect(slideRow([0, 0, 2, 2]).moved).toBe(true);
  });
});

describe('2048 move', () => {
  it('moves left and merges', () => {
    const { grid, gained, moved } = move([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [4, 0, 4, 0]], 'left');
    expect(grid[0]).toEqual([4, 0, 0, 0]);
    expect(grid[3]).toEqual([8, 0, 0, 0]);
    expect(gained).toBe(12);
    expect(moved).toBe(true);
  });
  it('moves right keeping merged tiles against the wall', () => {
    const { grid } = move([[0, 2, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 'right');
    expect(grid[0]).toEqual([0, 0, 0, 4]);
  });
  it('moves up and down across columns', () => {
    const up = move([[2, 0, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 'up');
    expect(up.grid[0][0]).toBe(4);
    const down = move([[2, 0, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 'down');
    expect(down.grid[3][0]).toBe(4);
  });
  it('flags a no-op move', () => {
    expect(move([[2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 'left').moved).toBe(false);
  });
});

describe('2048 helpers', () => {
  it('spawnTile fills exactly one empty cell deterministically', () => {
    const g = emptyGrid();
    const out = spawnTile(g, () => 0); // first empty cell, value 2
    expect(out[0][0]).toBe(2);
    expect(out.flat().filter((v) => v !== 0)).toHaveLength(1);
  });
  it('hasMoves is false on a locked board', () => {
    expect(hasMoves([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]])).toBe(false);
    expect(hasMoves([[2, 2, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]])).toBe(true);
  });
  it('maxTile finds the biggest tile', () => {
    expect(maxTile([[2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])).toBe(16);
  });
});

describe('snake step', () => {
  const food = { x: 9, y: 9 };
  it('moves the head and drops the tail when not eating', () => {
    const s = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }];
    const r = stepSnake(s, 'right', food, 20, 20);
    expect(r.snake[0]).toEqual({ x: 6, y: 5 });
    expect(r.snake).toHaveLength(3);
    expect(r.ate).toBe(false);
    expect(r.dead).toBe(false);
  });
  it('grows and reports ate when reaching food', () => {
    const s = [{ x: 8, y: 9 }, { x: 7, y: 9 }];
    const r = stepSnake(s, 'right', food, 20, 20);
    expect(r.ate).toBe(true);
    expect(r.snake).toHaveLength(3);
    expect(r.snake[0]).toEqual({ x: 9, y: 9 });
  });
  it('dies into a wall', () => {
    expect(stepSnake([{ x: 0, y: 0 }], 'left', food, 20, 20).dead).toBe(true);
  });
  it('dies into itself but may follow its own vacating tail', () => {
    // A 2×2 loop: head {1,1}, tail {1,2}. Moving down lands on the tail cell, which
    // vacates this step (not eating), so it is legal.
    const square = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }];
    expect(stepSnake(square, 'down', food, 20, 20).dead).toBe(false);
    // Moving right lands on a non-tail body cell ({2,1}) — fatal.
    expect(stepSnake(square, 'right', food, 20, 20).dead).toBe(true);
  });
});

describe('shared helpers', () => {
  it('opposite detects reversals', () => {
    expect(opposite('up', 'down')).toBe(true);
    expect(opposite('left', 'up')).toBe(false);
  });
  it('aabb detects overlap', () => {
    expect(aabb(0, 0, 10, 10, 5, 5, 10, 10)).toBe(true);
    expect(aabb(0, 0, 10, 10, 20, 20, 5, 5)).toBe(false);
  });
});
