// Run a learner's JavaScript in a sandboxed Web Worker — real execution, real console
// output, real JS errors (with stack) — without touching the page. The worker has no
// DOM/window access; a hard timeout terminates runaway/infinite-loop code. This is the
// "small quick terminal with legit execution errors" for JS (mirrors the server-side SQL
// playground), with zero new dependencies.

export interface JsLogLine {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}
export interface JsRunResult {
  logs: JsLogLine[];
  error?: string;
  timedOut?: boolean;
}

// The worker source. console.* is captured and posted back; user code runs inside an
// async IIFE so top-level `await` works. The trailing "\n" before the closing brace
// keeps a final line-comment from swallowing it.
const WORKER_SRC = `
const fmt = (v) => {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || String(v);
  try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
};
const send = (level, args) => self.postMessage({ type: 'log', level, text: args.map(fmt).join(' ') });
for (const l of ['log', 'info', 'warn', 'error', 'debug']) {
  console[l] = (...a) => send(l === 'debug' ? 'log' : l, a);
}
self.onmessage = async (e) => {
  try {
    const fn = new Function('"use strict"; return (async () => {' + e.data + '\\n})();');
    await fn();
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', text: (err && err.stack) ? String(err.stack) : String(err) });
  }
};
`;

export const runJavaScript = (code: string, timeoutMs = 4000): Promise<JsRunResult> =>
  new Promise((resolve) => {
    const logs: JsLogLine[] = [];
    let worker: Worker | undefined;
    let url: string | undefined;
    let done = false;

    const finish = (extra: Partial<JsRunResult>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { worker?.terminate(); } catch { /* already gone */ }
      if (url) URL.revokeObjectURL(url);
      resolve({ logs, ...extra });
    };

    const timer = setTimeout(
      () => finish({ timedOut: true, error: `Timed out after ${(timeoutMs / 1000).toFixed(0)}s (possible infinite loop).` }),
      timeoutMs
    );

    try {
      url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; level?: JsLogLine['level']; text?: string };
        if (m.type === 'log') logs.push({ level: m.level || 'log', text: m.text || '' });
        else if (m.type === 'error') finish({ error: m.text || 'Error' });
        else if (m.type === 'done') finish({});
      };
      worker.onerror = (e: ErrorEvent) => finish({ error: e.message || 'Worker error' });
      worker.postMessage(code);
    } catch (e) {
      finish({ error: (e as Error)?.message || 'Could not start the sandbox.' });
    }
  });
