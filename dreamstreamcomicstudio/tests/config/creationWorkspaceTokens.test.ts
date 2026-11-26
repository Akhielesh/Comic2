// @vitest-environment node
/**
 * "Start creating" (the New comic and All comics frame, components/comicstudio/ComicCreationWorkspace.tsx) in the
 * studio's look (navtheme NT-3). comicCreationWorkspace.css is a plain stylesheet no component test loads, so this
 * reads it as data (the cssTokens.ts parser):
 *
 * 1. Tokens only: no hex, no rgb()/rgba(), no spelled radius, no numeric z-index, no `--ds-font-ui` (defined nowhere,
 *    so it fell back to Inter), no face but the display token, no `--ds-*` token with a spelled fallback.
 * 2. The studio's frame: the header is `--header-h` tall (56, 48 under 600) on the canvas with the soft hairline, as
 *    ComicStudio's StudioHeader; the left column is the rail's 14rem on `--ds-surface-soft` with the rail's hairline;
 *    the header's controls in the side panel's hover tint (components/comicstudio/panel/panelStyles.ts, the one panel
 *    in the frame and the studio); the FOCUS_RING outline and the FIELD ring, with FIELD's transparent outline so forced colours
 *    still paints focus; FIELD edges and the canvas on the fields; the z-ladder and the overlay shadow on the phone
 *    drawer; transitions only when motion is welcome.
 * 3. One fill per view, and no cobalt on work surfaces: the panel's New comic is the All comics view's fill, an outline
 *    while the New comic view shows Start (the view's one fill), a plain row elsewhere, and neither carries
 *    `.comics-primary-action` (whose Paper block is the public chrome's cobalt, decision Q5).
 * 4. comicsShell.css: the Atlas values of `.comics-primary-action` are the skin's tokens, and under Atlas they resolve
 *    to the same pixels the literals painted, in light and dark. Outside a skin they take the root accent; that is
 *    accepted because the class renders only on the comics host, which always boots Atlas.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, indexCss, norm, parseRules, resolveColor, rgbaString, stripComments, tokenBlocks, tokensOf, type Rule } from './cssTokens';
import { ComicIdeaForm } from '../../components/comicstudio/ComicCreationWorkspace';
import { ComicSidePanel } from '../../components/comicstudio/panel/ComicSidePanel';
import { PANEL_CURRENT_TINT, PANEL_FILL, PANEL_HOVER_TINT, PANEL_OUTLINE, PANEL_ROW_CURRENT, PANEL_ROW_IDLE, PANEL_ROW_INK } from '../../components/comicstudio/panel/panelStyles';
import { PHONE_HEADER_PX, phoneChromeVars } from '../../components/comicstudio/mobile/shell/phoneChrome';
import { COMPACT_HEIGHT, SPLIT_MIN_WIDTH } from '../../components/comicstudio/mobile/formFactor';
import { COMICS_HOST, comicsSkin } from '../../services/productHost';

const read = (rel: string) => readFileSync(path.join(APP_ROOT, rel), 'utf8');
const CSS = 'components/comicstudio/comicCreationWorkspace.css';
const TSX = 'components/comicstudio/ComicCreationWorkspace.tsx';
const SHELL = 'components/comicshost/comicsShell.css';

const css = read(CSS);
const source = stripComments(css);
const rules = parseRules(css);

const selectorsOf = (selector: string) => selector.split(',').map((s) => norm(s));
/** A rule's declarations, property → value (the last one wins, as in the cascade). */
const declsOf = (rule: Rule): Map<string, string> => {
  const out = new Map<string, string>();
  for (const decl of rule.body.split(';')) {
    const m = /^\s*([\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
    if (m) out.set(m[1], norm(m[2]));
  }
  return out;
};
/** Every rule that lists `selector` among its selectors, with its at-rules. */
const rulesFor = (selector: string): Rule[] => rules.filter((r) => selectorsOf(r.selector).includes(selector));
/** The declarations `selector` gets outside any at-rule (merged in source order). */
const baseDecls = (selector: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const r of rulesFor(selector).filter((x) => x.parents.length === 0)) for (const [k, v] of declsOf(r)) out.set(k, v);
  return out;
};
/** Every value of `property` across the file, with the selector that sets it. */
const valuesOf = (property: string): Array<{ selector: string; value: string; parents: string[] }> =>
  rules.flatMap((r) => {
    const v = declsOf(r).get(property);
    return v === undefined ? [] : [{ selector: r.selector, value: v, parents: r.parents }];
  });

describe('comicCreationWorkspace.css: tokens only', () => {
  it('spells no colour: no hex, rgb(), rgba() or hsl()', () => {
    expect(source.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(source.match(/\b(?:rgba?|hsla?)\(/gi) ?? []).toEqual([]);
  });

  it('every radius is a radius token', () => {
    const radii = valuesOf('border-radius');
    expect(radii.length).toBeGreaterThan(0);
    for (const { selector, value } of radii) expect(value, selector).toMatch(/^var\(--ds-radius-(?:control|panel|sm|chip|pill)\)$/);
  });

  it('every z-index is a rung of the z-ladder', () => {
    const z = valuesOf('z-index');
    expect(z.length).toBeGreaterThan(0);
    for (const { selector, value } of z) expect(value, selector).toMatch(/^var\(--ds-z-[a-z]+\)$/);
  });

  it('sets no face of its own: the skin’s IBM Plex Sans applies, and editorial headings and captions use the display token', () => {
    expect(source).not.toContain('--ds-font-ui');
    expect(baseDecls('.comic-creation-workspace').has('font-family')).toBe(false);
    for (const { selector, value } of valuesOf('font-family')) {
      expect(['.comic-idea-entry h1', '.comic-starters-heading h2', '.comic-starter-caption']).toContain(selector);
      expect(value).toBe('var(--ds-font-display)');
    }
  });

  it('gives no token a spelled fallback', () => {
    expect(source.match(/var\(\s*--ds-[\w-]+\s*,[^)]*\)/g) ?? []).toEqual([]);
  });
});

describe('comicCreationWorkspace.css: the studio’s frame', () => {
  it('the header is the studio header: --header-h tall, on the canvas, the soft hairline, never resized in a media block', () => {
    const header = baseDecls('.comic-workspace-header');
    expect(header.get('height')).toBe('var(--header-h, 56px)');
    expect(header.get('border-bottom')).toBe('1px solid var(--ds-hairline-soft)');
    expect(header.has('background')).toBe(false);
    expect(header.has('background-color')).toBe(false);
    // StudioHeader: content-box, so the safe-area top adds to the height instead of eating it.
    expect(header.get('box-sizing')).toBe('content-box');
    expect(header.get('padding')).toBe('var(--sa-top, 0px) 8px 0');
    const resized = rulesFor('.comic-workspace-header').filter((r) => r.parents.length > 0 && /(?:^|;)\s*(?:min-|max-)?height\s*:/.test(r.body));
    expect(resized.map((r) => r.parents.join(' '))).toEqual([]);
    const wide = rulesFor('.comic-workspace-header').find((r) => r.parents.join(' ').replace(/\s+/g, '') === '@media(min-width:640px)');
    expect(wide && declsOf(wide).get('padding-inline')).toBe('12px');
  });

  it('the header row is the studio’s own height: 48 px on the workspace, 44 px where the studio takes its phone layouts', () => {
    // ComicStudio sets --header-h on its root from phoneChromeVars(layout): 'split' 48 px; 'single' (under
    // SPLIT_MIN_WIDTH wide) and 'single-rail' (under COMPACT_HEIGHT tall) PHONE_HEADER_PX. The frame restates them.
    const wide = (phoneChromeVars('split') as Record<string, string>)['--header-h'];
    expect(baseDecls('.comic-creation-workspace').get('--header-h')).toBe(wide);
    const phoneMedia = `@media(max-width:${SPLIT_MIN_WIDTH - 1}px),(max-height:${COMPACT_HEIGHT - 1}px)`;
    const phone = rulesFor('.comic-creation-workspace').filter((r) => r.parents.join(' ').replace(/\s+/g, '') === phoneMedia);
    expect(phone).toHaveLength(1);
    expect(declsOf(phone[0]).get('--header-h')).toBe(`${PHONE_HEADER_PX}px`);
    expect((phoneChromeVars('single') as Record<string, string>)['--header-h']).toBe(`${PHONE_HEADER_PX}px`);
    expect((phoneChromeVars('single-rail') as Record<string, string>)['--header-h']).toBe(`${PHONE_HEADER_PX}px`);
  });

  it('the left column is the studio rail: 14rem on --ds-surface-soft with the rail’s hairline', () => {
    const column = baseDecls('.comic-workspace-sidebar');
    expect(column.get('width')).toBe('14rem');
    expect(column.get('background')).toBe('var(--ds-surface-soft)');
    expect(column.get('border-right')).toBe('1px solid var(--ds-hairline)');
  });

  it('the panel’s rows hover and the current row take one tint each, and the frame’s header controls read the same hover', () => {
    // The one side panel (frame and studio) styles its own rows from panelStyles.ts; this stylesheet keeps only the
    // frame's chrome, whose header controls hover in the panel's tint. No overlay-row tint in navigation.
    const tintOf = (classes: string, prefix: '' | 'hover:') => new RegExp(`(?:^|\\s)${prefix.replace(':', '\\:')}bg-\\[(var\\(--ds-[\\w-]+\\))\\]`).exec(classes)?.[1];
    expect(tintOf(PANEL_ROW_CURRENT, '')).toBe(PANEL_CURRENT_TINT);
    for (const row of [PANEL_ROW_IDLE, PANEL_ROW_INK]) expect(tintOf(row, 'hover:')).toBe(PANEL_HOVER_TINT);
    expect(PANEL_ROW_CURRENT).toContain('font-semibold');
    expect(source).not.toContain('--ds-overlay-hover');
    expect(baseDecls('.comic-workspace-icon:hover').get('background')).toBe(PANEL_HOVER_TINT);
    // The old navigation's rules are gone with it: the panel draws its rows.
    expect(source).not.toMatch(/\.comic-project-|\.comic-task-/);
  });

  it('collapsed, the frame shows the panel’s slim rail under its header, in the column’s fill and hairline', () => {
    const rail = baseDecls('.comic-workspace-rail');
    expect(rail.get('width')).toBe('3.5rem');
    expect(rail.get('background')).toBe('var(--ds-surface-soft)');
    expect(rail.get('border-right')).toBe('1px solid var(--ds-hairline)');
  });

  it('every control shows the FOCUS_RING outline, the fields the FIELD ring', () => {
    const outlines = valuesOf('outline').filter((v) => /button:focus-visible/.test(v.selector));
    expect(outlines.length).toBeGreaterThan(0);
    for (const { selector, value } of outlines) expect(value, selector).toBe('2px solid var(--ds-focus)');
    for (const sel of ['.comic-creation-workspace button:focus-visible', '.comic-workspace-drawer button:focus-visible']) {
      expect(baseDecls(sel).get('outline-offset'), sel).toBe('2px');
    }
    for (const sel of ['.comic-idea-form input:focus-visible', '.comic-idea-compose:focus-within']) {
      const field = baseDecls(sel);
      expect(field.get('border-color'), sel).toBe('var(--ds-focus)');
      expect(field.get('box-shadow'), sel).toBe('0 0 0 2px var(--ds-canvas), 0 0 0 4px var(--ds-focus)');
      // Forced colours drops box-shadow and recolours borders, so focus needs an outline there. FIELD's
      // `focus-visible:outline-none` compiles (Tailwind 3) to a 2 px transparent outline 2 px off, which forced colours
      // paints in a system colour; `outline: none` would leave the field with no focus at all.
      expect(field.get('outline'), sel).toBe('2px solid transparent');
      expect(field.get('outline-offset'), sel).toBe('2px');
    }
    expect(read('components/chat/studioDesign.ts')).toMatch(/export const FIELD = `[^`]*\bfocus-visible:outline-none\b/);
    // Under "increase contrast" the outline is 3 px, as FOCUS_RING's contrast-more step.
    const more = rules.filter((r) => r.parents.join(' ').includes('prefers-contrast: more') && /:focus-visible/.test(r.selector));
    expect(more.map((r) => declsOf(r).get('outline-width'))).toContain('3px');
  });

  it('the fields have the FIELD edges on the canvas', () => {
    for (const sel of ['.comic-idea-form input', '.comic-idea-compose']) {
      const d = baseDecls(sel);
      expect(d.get('border'), sel).toBe('1px solid var(--ds-control-border)');
      expect(d.get('background'), sel).toBe('var(--ds-canvas)');
      expect(baseDecls(`${sel}:hover`).get('border-color'), sel).toBe('var(--ds-control-border-hover)');
      for (const [prop, value] of baseDecls(sel)) expect(value, `${sel} ${prop}`).not.toMatch(/--ds-(?:hairline|surface-strong)\b/);
    }
  });

  it('one fill per view: Start keeps the ink fill; the panel’s New comic is the ink fill on All comics, an outline on its own view', () => {
    const start = baseDecls('.comic-idea-start');
    expect(start.get('background')).toBe('var(--ds-accent-fill)');
    expect(start.get('color')).toBe('var(--ds-on-accent)');
    expect(baseDecls('.comic-idea-start:hover:not(:disabled)').get('background')).toBe('var(--ds-accent-fill-hover)');
    expect(PANEL_FILL).toContain('bg-[var(--ds-accent-fill)]');
    expect(PANEL_FILL).toContain('text-[var(--ds-on-accent)]');
    expect(PANEL_OUTLINE).not.toMatch(/accent|spark/);
    expect(PANEL_OUTLINE).toContain('text-[var(--ds-ink)]');
    expect(PANEL_OUTLINE).toMatch(/shadow-\[inset_0_0_0_1px_var\(--ds-[\w-]+\)\]/);
    expect(PANEL_OUTLINE).toContain('hover:bg-[var(--ds-hover)]');
  });

  it('the phone drawer sits on the z-ladder with the overlay shadow (its edge shows in dark)', () => {
    const backdrop = baseDecls('.comic-workspace-drawer-backdrop');
    expect(backdrop.get('z-index')).toBe('var(--ds-z-scrim)');
    expect(backdrop.get('background')).toBe('var(--ds-scrim)');
    const drawer = baseDecls('.comic-workspace-drawer');
    expect(drawer.get('z-index')).toBe('var(--ds-z-sheet)');
    expect(drawer.get('position')).toBe('relative');
    expect(drawer.get('box-shadow')).toBe('var(--ds-shadow-overlay)');
  });

  it('the heading is the studio heading size in the display face, and the error reads in --ds-danger-text', () => {
    const h1 = baseDecls('.comic-idea-entry h1');
    expect(h1.get('font-size')).toBe(norm('clamp(var(--ds-text-3xl), 4vw, var(--ds-text-5xl))'));
    expect(h1.get('font-family')).toBe('var(--ds-font-display)');
    expect(h1.get('letter-spacing') ?? '').not.toMatch(/px/);
    expect(rulesFor('.comic-idea-entry h1').filter((r) => r.parents.length > 0 && /font-size/.test(r.body))).toEqual([]);
    expect(baseDecls('.comic-idea-error').get('color')).toBe('var(--ds-danger-text)');
  });

  it('transitions run only when motion is welcome, at the token speed', () => {
    const transitions = valuesOf('transition');
    expect(transitions.length).toBeGreaterThan(0);
    for (const { selector, value, parents } of transitions) {
      expect(parents.join(' '), selector).toContain('prefers-reduced-motion: no-preference');
      expect(value, selector).toMatch(/var\(--ds-motion-(?:fast|medium)\) var\(--ds-ease\)/);
    }
  });
});

describe('ComicCreationWorkspace.tsx: no cobalt on work surfaces', () => {
  const noop = () => undefined;
  const links = { projects: [], onNewComic: noop, onAllComics: noop, onLibrary: noop, onOpenProject: noop };

  it('the sources never name the public chrome’s primary class', () => {
    expect(read(TSX)).not.toContain('comics-primary-action');
    expect(read('components/comicstudio/panel/ComicSidePanel.tsx')).not.toContain('comics-primary-action');
  });

  it('New comic (current on the New comic view) and Start render without it; New comic fills only on All comics', () => {
    const html = renderToStaticMarkup(React.createElement(React.Fragment, null,
      React.createElement(ComicSidePanel, { place: 'new', links }),
      React.createElement(ComicIdeaForm, { name: '', idea: 'A lighthouse keeper finds a map.', pending: false, error: null, onName: noop, onIdea: noop, onStart: noop, onDraft: noop, onStartBlank: noop, onClassic: noop, onLibrary: noop })
    ));
    const tagOf = (pattern: RegExp) => {
      const tag = pattern.exec(html);
      expect(tag, String(pattern)).not.toBeNull();
      return tag![0];
    };
    const newComic = tagOf(/<button[^>]*aria-current="page"[^>]*>(?:(?!<\/button>).)*New comic<\/span><\/button>/);
    expect(newComic).not.toContain('comics-primary-action');
    expect(newComic).not.toContain('data-panel-fill');
    expect(newComic).not.toContain('--ds-accent-fill');
    const start = tagOf(/<button[^>]*class="[^"]*\bcomic-idea-start\b[^"]*"[^>]*>/);
    expect(start).toContain('type="submit"');
    expect(start).not.toContain('comics-primary-action');
    const all = renderToStaticMarkup(React.createElement(ComicSidePanel, { place: 'all', links }));
    expect(all.match(/data-panel-fill="true"/g)).toHaveLength(1);
    expect(all).not.toContain('comics-primary-action');
    const comic = renderToStaticMarkup(React.createElement(ComicSidePanel, { place: 'comic', links }));
    expect(comic).not.toContain('data-panel-fill');
  });
});

describe('comicsShell.css: the Atlas primary is the skin’s ink, as tokens', () => {
  const shellRules = parseRules(read(SHELL)).filter((r) => r.parents.length === 0);
  const { ROOT_TOKENS, DARK_TOKENS, ATLAS_LIGHT, ATLAS_DARK } = tokenBlocks(parseRules(indexCss));
  const atlasRules = shellRules.filter((r) => /\.comics-primary-action/.test(r.selector) && !/paper/.test(r.selector));
  const cascade = (...layers: Map<string, string>[]) => (name: string): string => {
    for (const layer of layers) if (layer.has(name)) return layer.get(name)!;
    throw new Error(`${name} is not defined`);
  };

  it('spells no colour in the Atlas blocks (the Paper blocks stay as they are, decision Q5)', () => {
    expect(atlasRules.length).toBeGreaterThan(0);
    for (const r of atlasRules) expect(r.body, r.selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it('outside a skin it takes the root accent, accepted because it renders only on the comics host, which boots Atlas', () => {
    // The Atlas values are inherited tokens, not literals: with no Atlas ancestor (the QA harness at skin=none) the
    // fill is the root accent. Production never gets there: the class is used only by the comics host's own chrome,
    // and that host always runs under Atlas.
    const light = tokensOf(shellRules, (s) => s === '.comics-primary-action');
    const lookRoot = cascade(light, ROOT_TOKENS);
    expect(rgbaString(resolveColor('var(--ds-accent-fill)', lookRoot))).toBe(rgbaString(resolveColor('var(--ds-accent)', cascade(ROOT_TOKENS))));
    expect(comicsSkin(COMICS_HOST)).toBe('atlas');
    const users = (dir: string): string[] => readdirSync(path.join(APP_ROOT, dir), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
      .map((e) => path.relative(APP_ROOT, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
      .filter((rel) => read(rel).includes('comics-primary-action'));
    expect(users('components').sort()).toEqual(['components/comicshost/ComicsHeader.tsx', 'components/comicshost/ComicsLanding.tsx']);
    expect(read('App.tsx')).not.toContain('comics-primary-action');
  });

  it('paints the same pixels the literals did under Atlas, in light and dark', () => {
    const light = tokensOf(shellRules, (s) => s === '.comics-primary-action');
    const dark = tokensOf(shellRules, (s) => s === '.comics-primary-action' || s === '.dark .comics-primary-action');
    const lookLight = cascade(light, ATLAS_LIGHT, ROOT_TOKENS);
    const lookDark = cascade(dark, ATLAS_DARK, ATLAS_LIGHT, DARK_TOKENS, ROOT_TOKENS);
    const px = (look: (n: string) => string, name: string) => rgbaString(resolveColor(`var(${name})`, look));
    const lit = (hex: string) => rgbaString(resolveColor(hex));
    expect([px(lookLight, '--ds-accent-fill'), px(lookLight, '--ds-accent-fill-hover'), px(lookLight, '--ds-on-accent')]).toEqual([lit('#0a0a0a'), lit('#2f2f2f'), lit('#ffffff')]);
    expect([px(lookDark, '--ds-accent-fill'), px(lookDark, '--ds-accent-fill-hover'), px(lookDark, '--ds-on-accent')]).toEqual([lit('#fafafa'), lit('#d6d6d6'), lit('#0a0a0a')]);
  });
});
