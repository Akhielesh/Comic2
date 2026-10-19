/**
 * Background-proof frame clock.
 *
 * Browsers clamp main-thread timers in hidden tabs (1 Hz, and "intensive
 * throttling" to once a MINUTE after 5 minutes in Chrome). The program canvas
 * is what the encoder records, so a throttled draw loop froze the stream the
 * moment a host switched tabs. Timers inside a dedicated Worker are not
 * clamped that way; the worker posts a tick and the main thread draws on it.
 * Falls back to a plain interval where Workers/Blob URLs are unavailable.
 */

export interface Ticker {
  stop(): void;
}

const WORKER_SRC = `
let id = null;
onmessage = (e) => {
  if (id !== null) clearInterval(id);
  id = null;
  if (e.data && e.data.ms > 0) id = setInterval(() => postMessage(0), e.data.ms);
};
`;

export function startTicker(intervalMs: number, onTick: () => void): Ticker {
  const ms = Math.max(4, Math.round(intervalMs));
  try {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') {
      throw new Error('no worker');
    }
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = () => onTick();
    worker.postMessage({ ms });
    return {
      stop: () => {
        worker.postMessage({ ms: 0 });
        worker.terminate();
      },
    };
  } catch {
    const id = window.setInterval(onTick, ms);
    return { stop: () => window.clearInterval(id) };
  }
}
