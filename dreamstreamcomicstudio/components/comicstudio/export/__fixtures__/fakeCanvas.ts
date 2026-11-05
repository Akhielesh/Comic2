// A recording 2D context for export tests (jsdom has no canvas). It keeps the state a renderer sets
// (font, alignment, direction, alpha, composite op, transform) and logs every draw call with a
// snapshot of that state, so tests can assert WHAT was drawn, in WHICH order, HOW.

export interface DrawCall {
  name: string;
  args: unknown[];
  state: {
    font: string;
    textAlign: string;
    direction: string;
    globalAlpha: number;
    globalCompositeOperation: string;
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    dash: number[];
    matrix: [number, number, number, number, number, number];
  };
}

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5]
];

export interface FakeCtx {
  ctx: CanvasRenderingContext2D;
  calls: DrawCall[];
  /** Names of the draw calls only (fill, stroke, fillText…). */
  draws: () => DrawCall[];
}

export function fakeContext(width = 1000, height = 1500, label = 'main'): FakeCtx {
  const calls: DrawCall[] = [];
  const stack: Record<string, unknown>[] = [];
  const state = {
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    direction: 'inherit',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    imageSmoothingQuality: 'low',
    dash: [] as number[],
    matrix: [1, 0, 0, 1, 0, 0] as M
  };
  const snap = () => ({
    font: state.font,
    textAlign: state.textAlign,
    direction: state.direction,
    globalAlpha: state.globalAlpha,
    globalCompositeOperation: state.globalCompositeOperation,
    fillStyle: state.fillStyle,
    strokeStyle: state.strokeStyle,
    lineWidth: state.lineWidth,
    dash: [...state.dash],
    matrix: [...state.matrix] as M
  });
  const log = (name: string) => (...args: unknown[]) => {
    calls.push({ name, args, state: snap() });
  };
  const ctx: Record<string, unknown> = {
    canvas: { width, height, label },
    save: () => stack.push({ ...state, dash: [...state.dash], matrix: [...state.matrix] }),
    restore: () => {
      const s = stack.pop();
      if (s) Object.assign(state, s);
    },
    translate: (x: number, y: number) => (state.matrix = mul(state.matrix, [1, 0, 0, 1, x, y])),
    scale: (x: number, y: number) => (state.matrix = mul(state.matrix, [x, 0, 0, y, 0, 0])),
    rotate: (a: number) => (state.matrix = mul(state.matrix, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0])),
    transform: (a: number, b: number, c: number, d: number, e: number, f: number) => (state.matrix = mul(state.matrix, [a, b, c, d, e, f])),
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => (state.matrix = [a, b, c, d, e, f]),
    getTransform: () => {
      const [a, b, c, d, e, f] = state.matrix;
      return { a, b, c, d, e, f };
    },
    setLineDash: (d: number[]) => (state.dash = [...d]),
    getLineDash: () => [...state.dash],
    measureText: (t: string) => ({ width: String(t).length * 10 }),
    beginPath: log('beginPath'),
    moveTo: log('moveTo'),
    lineTo: log('lineTo'),
    quadraticCurveTo: log('quadraticCurveTo'),
    closePath: log('closePath'),
    arc: log('arc'),
    rect: log('rect'),
    clip: log('clip'),
    fill: log('fill'),
    stroke: log('stroke'),
    fillRect: log('fillRect'),
    clearRect: log('clearRect'),
    fillText: log('fillText'),
    strokeText: log('strokeText'),
    drawImage: log('drawImage')
  };
  for (const key of Object.keys(state)) {
    if (key === 'dash' || key === 'matrix') continue;
    Object.defineProperty(ctx, key, {
      get: () => (state as Record<string, unknown>)[key],
      set: (v) => ((state as Record<string, unknown>)[key] = v),
      enumerable: true
    });
  }
  const DRAWS = new Set(['fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'fillRect', 'arc']);
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, draws: () => calls.filter((c) => DRAWS.has(c.name)) };
}

/** A layer factory that hands out fake contexts and remembers them. */
export function fakeLayers() {
  const made: FakeCtx[] = [];
  const createLayer = (w: number, h: number) => {
    const f = fakeContext(w, h, `layer${made.length}`);
    made.push(f);
    return { canvas: { width: w, height: h, label: `layer${made.length - 1}` } as unknown as CanvasImageSource & { width: number; height: number }, ctx: f.ctx };
  };
  return { made, createLayer };
}

/** Path2D stand-in: remembers its path data. */
export const fakePath = (d: string) => ({ d }) as unknown as Path2D;
