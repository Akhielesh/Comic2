// The theme switch under the Atlas skin (Atlas wave 5, docs/design/atlas-skin.md "Theme switch"):
// one view-transition cross-fade of the whole page when the person just asked for the change, an
// instant switch with every element transition held for that frame otherwise — and, outside the
// skin, exactly the old `.dark` toggle (services/theme.ts applyTheme), nothing more.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DS_SKIN_ATTR } from './productHost';
import { DS_NO_TRANSITIONS_CLASS, DS_THEME_TRANSITION_CLASS, switchDsTheme, type ThemeSwitchEnv, type ViewTransitionLike } from './dsSkin';
import { applyTheme, setThemePreference } from './theme';

const root = document.documentElement;

/** A requestAnimationFrame stand-in whose frames run only when asked. */
const fakeRaf = () => {
  const queue: Array<() => void> = [];
  return {
    raf: (cb: () => void) => {
      queue.push(cb);
    },
    frame: () => queue.splice(0).forEach((cb) => cb())
  };
};

/** A startViewTransition stand-in: runs the update at once, resolves its promises when asked. */
const fakeViewTransition = () => {
  let finish!: () => void;
  let updated!: () => void;
  const calls: Array<() => void> = [];
  const start = vi.fn((update: () => void): ViewTransitionLike => {
    calls.push(update);
    const updateCallbackDone = new Promise<void>((r) => {
      updated = r;
    });
    const finished = new Promise<void>((r) => {
      finish = r;
    });
    return { ready: Promise.resolve(), updateCallbackDone, finished };
  });
  return {
    start,
    runUpdate: () => {
      calls.splice(0).forEach((u) => u());
      updated();
    },
    finish: () => finish()
  };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

const env = (over: Partial<ThemeSwitchEnv> = {}): ThemeSwitchEnv => ({
  startViewTransition: null,
  reducedMotion: false,
  visible: true,
  userActive: true,
  raf: null,
  ...over
});

afterEach(() => {
  root.removeAttribute(DS_SKIN_ATTR);
  root.classList.remove('dark', DS_NO_TRANSITIONS_CLASS, DS_THEME_TRANSITION_CLASS);
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  try {
    localStorage.clear();
  } catch {
    /* jsdom */
  }
});

describe('switchDsTheme — outside the skin it is exactly the old toggle', () => {
  it('toggles .dark and nothing else, even when asked to animate with a view transition available', () => {
    const vt = fakeViewTransition();
    expect(switchDsTheme(root, true, { animate: true, env: env({ startViewTransition: vt.start }) })).toBe('toggled');
    expect(root.classList.contains('dark')).toBe(true);
    expect(switchDsTheme(root, false, { animate: true, env: env({ startViewTransition: vt.start }) })).toBe('toggled');
    expect(root.classList.contains('dark')).toBe(false);
    expect(vt.start).not.toHaveBeenCalled();
    expect(root.classList.contains(DS_NO_TRANSITIONS_CLASS)).toBe(false);
    expect(root.classList.contains(DS_THEME_TRANSITION_CLASS)).toBe(false);
  });

  it('services/theme applyTheme on the apex page is the same plain toggle', () => {
    applyTheme('dark');
    expect(root.className).toBe('dark');
    applyTheme('light');
    expect(root.className).toBe('');
  });
});

describe('switchDsTheme — under the skin', () => {
  it('does nothing when the page already shows that theme', () => {
    root.setAttribute(DS_SKIN_ATTR, 'atlas');
    const vt = fakeViewTransition();
    expect(switchDsTheme(root, false, { animate: true, env: env({ startViewTransition: vt.start }) })).toBe('unchanged');
    expect(vt.start).not.toHaveBeenCalled();
    expect(root.classList.contains(DS_NO_TRANSITIONS_CLASS)).toBe(false);
  });

  it('a change the person asked for is one view-transition cross-fade, element transitions held for that frame', async () => {
    root.setAttribute(DS_SKIN_ATTR, 'atlas');
    const vt = fakeViewTransition();
    const { raf, frame } = fakeRaf();
    expect(switchDsTheme(root, true, { animate: true, env: env({ startViewTransition: vt.start, raf }) })).toBe('cross-fade');
    expect(vt.start).toHaveBeenCalledTimes(1);
    // The old snapshot is taken first: the class flips inside the update callback.
    expect(root.classList.contains(DS_THEME_TRANSITION_CLASS)).toBe(true);
    expect(root.classList.contains('dark')).toBe(false);
    vt.runUpdate();
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains(DS_NO_TRANSITIONS_CLASS)).toBe(true);
    await flush();
    frame();
    expect(root.classList.contains(DS_NO_TRANSITIONS_CLASS)).toBe(true);
    frame();
    expect(root.classList.contains(DS_NO_TRANSITIONS_CLASS)).toBe(false);
    expect(root.classList.contains(DS_THEME_TRANSITION_CLASS)).toBe(true);
    vt.finish();
    await flush();
    expect(root.classList.contains(DS_THEME_TRANSITION_CLASS)).toBe(false);
  });

  it.each([
    ['a boot or a system-theme correction (not animated)', { animate: false }, {}],
    ['reduced motion', { animate: true }, { reducedMotion: true }],
    ['a hidden page', { animate: true }, { visible: false }],
    ['no recent user activation', { animate: true }, { userActive: false }]
  ] as const)('%s switches at once, with transitions held for one frame', (_name, opts, over) => {
    root.setAttribute(DS_SKIN_ATTR, 'atlas');
    const vt = fakeViewTransition();
    const { raf, frame } = fakeRaf();
    expect(switchDsTheme(root, true, { ...opts, env: env({ startViewTransition: vt.start, raf, ...over }) })).toBe('instant');
    expect(vt.start).not.toHaveBeenCalled();
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains(DS_NO_TRANSITIONS_CLASS)).toBe(true);
    expect(root.classList.contains(DS_THEME_TRANSITION_CLASS)).toBe(false);
    frame();
    frame();
    expect(root.classList.contains(DS_NO_TRANSITIONS_CLASS)).toBe(false);
  });

  it('without the View Transitions API, or when it throws, the theme still lands at once', () => {
    root.setAttribute(DS_SKIN_ATTR, 'atlas');
    const { raf } = fakeRaf();
    expect(switchDsTheme(root, true, { animate: true, env: env({ raf }) })).toBe('instant');
    expect(root.classList.contains('dark')).toBe(true);
    const throwing = vi.fn(() => {
      throw new Error('InvalidStateError');
    });
    expect(switchDsTheme(root, false, { animate: true, env: env({ startViewTransition: throwing, raf }) })).toBe('instant');
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.classList.contains(DS_THEME_TRANSITION_CLASS)).toBe(false);
  });

  it('services/theme: a preference the person sets cross-fades; applying the stored one at mount does not', async () => {
    root.setAttribute(DS_SKIN_ATTR, 'atlas');
    const vt = fakeViewTransition();
    (document as { startViewTransition?: unknown }).startViewTransition = vt.start;
    applyTheme('dark');
    expect(vt.start).not.toHaveBeenCalled();
    expect(root.classList.contains('dark')).toBe(true);
    setThemePreference('light');
    expect(vt.start).toHaveBeenCalledTimes(1);
    vt.runUpdate();
    expect(root.classList.contains('dark')).toBe(false);
  });
});
