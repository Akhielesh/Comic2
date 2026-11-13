// FX-15: the busy-button helper is shared by the board kit and the conversation kit. It lives in a module with no
// runtime imports, so the conversation kit (in the chat and reader chunks) never pulls the board kit and its
// dependencies (failure cards, boardModel, the comic plan) into a shared chunk just to get one helper.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
/** Every module specifier a file imports or re-exports at runtime (type-only imports are erased by the build). */
const runtimeImports = (code: string) =>
  [...code.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

describe('busyButton module boundaries', () => {
  it('busyButton.ts has no runtime imports', () => {
    expect(runtimeImports(src('./busyButton.ts'))).toEqual([]);
  });

  it('the conversation kit gets the helper from busyButton, never from the board kit', () => {
    const imports = runtimeImports(src('../conversation/ui.tsx'));
    expect(imports).toContain('../board/busyButton');
    expect(imports).not.toContain('../board/ui');
  });
});
