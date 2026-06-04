// Thin wrapper around the WebContainer API: boot a single in-browser Node runtime,
// mount a project, run install + dev server, stream process output, and hot-write
// edited files. Everything runs client-side in the user's (isolated) tab — no
// server compute.

import { WebContainer } from '@webcontainer/api';
import type { FileSystemTree, WebContainerProcess } from '@webcontainer/api';

export type LogFn = (chunk: string) => void;

/** Convert a flat path→contents map into the nested tree the WebContainer expects. */
export const filesToTree = (files: Record<string, string>): FileSystemTree => {
  const tree: FileSystemTree = {};
  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split('/').filter(Boolean);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: any = tree;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        node[part] = { file: { contents } };
      } else {
        node[part] = node[part] || { directory: {} };
        node = node[part].directory;
      }
    });
  }
  return tree;
};

// WebContainer.boot() may only be called once per page; cache the instance.
let bootPromise: Promise<WebContainer> | null = null;
export const bootContainer = (): Promise<WebContainer> => {
  if (!bootPromise) bootPromise = WebContainer.boot();
  return bootPromise;
};

/** Run a command to completion, streaming combined output. Resolves with exit code. */
export const runToExit = async (
  wc: WebContainer,
  cmd: string,
  args: string[],
  onLog: LogFn
): Promise<number> => {
  const proc = await wc.spawn(cmd, args);
  void proc.output.pipeTo(new WritableStream({ write: (d) => onLog(d) }));
  return proc.exit;
};

/** Start a long-running command (e.g. the dev server). Caller keeps the handle to kill it. */
export const startProcess = async (
  wc: WebContainer,
  cmd: string,
  args: string[],
  onLog: LogFn
): Promise<WebContainerProcess> => {
  const proc = await wc.spawn(cmd, args);
  void proc.output.pipeTo(new WritableStream({ write: (d) => onLog(d) }));
  return proc;
};

/** Write a single edited file into the live container so Vite HMR picks it up. */
export const writeFile = async (wc: WebContainer, path: string, contents: string): Promise<void> => {
  const clean = path.replace(/^\/+/, '');
  const dir = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '';
  if (dir) await wc.fs.mkdir(dir, { recursive: true }).catch(() => {});
  await wc.fs.writeFile(clean, contents);
};
