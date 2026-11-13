// @vitest-environment node
/**
 * styles/ds-motion.css (bridge D7; docs/design/design-system.md "Motion classes"): the shared motion and
 * effect classes ported from Atlas's motion system onto the --ds-* tokens, imported by index.css. Plain CSS:
 * no Tailwind directive, every token it reads exists, entrances fill backwards and land on `transform: none`,
 * the loops pause under data-inview="false", and ONE reduced-motion block stops every one of them.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, indexCss, parseRules, stripComments, tokenBlocks, topLevelSplit } from './cssTokens';

const SOURCE = readFileSync(path.join(APP_ROOT, 'styles/ds-motion.css'), 'utf8');
const CODE = stripComments(SOURCE);
const rules = parseRules(SOURCE);
const REDUCE = '@media (prefers-reduced-motion: reduce)';
const reduced = rules.filter((r) => r.parents.includes(REDUCE));
const reducedBody = (selector: string) => reduced.filter((r) => topLevelSplit(r.selector).map((s) => s.trim()).includes(selector)).map((r) => r.body).join(' ');

const ENTRANCES = ['ds-rise-in', 'ds-fade-in', 'ds-scale-in', 'ds-slide-in-right', 'ds-blur-in', 'ds-pop', 'ds-draw', 'ds-flash'];
const CLASSES = [
  ...ENTRANCES, 'ds-stagger', 'ds-reveal', 'ds-disclosure', 'ds-lift', 'ds-link', 'ds-skeleton', 'ds-shimmer-text', 'ds-progress-indeterminate',
  'ds-live-dot', 'ds-caret', 'ds-marquee', 'ds-fade-edge-x', 'ds-fade-edge-y', 'ds-grid-backdrop', 'ds-overline', 'ds-overline-display', 'ds-display',
  // The colour layer's two hand-written classes (CL-0 #3).
  'ds-making-sweep', 'ds-benday'
];
/** Every class name a selector in the file defines. */
const defined = new Set([...CODE.matchAll(/\.(ds-[\w-]+)/g)].map((m) => m[1]));

describe('styles/ds-motion.css', () => {
  it('is imported by index.css as its first statement (Vite inlines it; an @import after a rule is dropped)', () => {
    const first = stripComments(indexCss).trim().split('\n')[0];
    expect(first).toBe("@import './styles/ds-motion.css';");
  });

  it('is framework-free: no Tailwind directive or @apply / theme()', () => {
    expect(CODE).not.toMatch(/@tailwind|@apply|@layer|theme\(|screen\(/);
  });

  it('defines every class of the catalogue', () => {
    expect(CLASSES.filter((c) => !defined.has(c))).toEqual([]);
    expect(defined.has('ds-marquee-track')).toBe(true);
  });

  it('collides with nothing index.css already defines (.studio-*, .animate-*, .press, .ds-gallery-*, .ds-map*, the skin classes)', () => {
    const indexClasses = new Set([...stripComments(indexCss).matchAll(/\.((?:ds|studio|hiw|animate)-[\w-]+|press)\b/g)].map((m) => m[1]));
    expect([...defined].filter((c) => indexClasses.has(c))).toEqual([]);
    for (const c of defined) expect(c, c).not.toMatch(/^(?:studio|hiw|animate)-|^press$|^ds-gallery|^ds-map/);
    const indexKeyframes = new Set([...indexCss.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
    const ownKeyframes = [...SOURCE.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    expect(ownKeyframes.filter((k) => indexKeyframes.has(k))).toEqual([]);
    for (const k of ownKeyframes) expect(k).toMatch(/^ds-/);
  });

  it('reads only --ds-* tokens that index.css defines (plus its own --ds-i / --ds-draw-length / fade / shimmer locals)', () => {
    const { ROOT_TOKENS } = tokenBlocks(parseRules(indexCss));
    const locals = new Set(['--ds-i', '--ds-draw-length', '--ds-fade-size', '--ds-fade-start', '--ds-fade-end', '--ds-shimmer-base', '--ds-shimmer-glint']);
    const read = [...new Set([...CODE.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))];
    expect(read.filter((t) => !t.startsWith('--ds-'))).toEqual([]);
    expect(read.filter((t) => !locals.has(t) && !ROOT_TOKENS.has(t))).toEqual([]);
    // Never Atlas's own names (the port renamed every one).
    expect(CODE).not.toMatch(/--motion-|--atlas-|--foreground|--muted-foreground|\.atlas-/);
  });

  it('entrances fill backwards and every keyframe that moves lands on `transform: none` (or `translate: none`)', () => {
    for (const c of ENTRANCES) {
      const rule = rules.find((r) => r.selector === `.${c}` || r.selector === `.${c} :is(path, polyline, line)`);
      expect(rule?.body, c).toMatch(/animation: [\w-]+ .*backwards;/);
    }
    expect(rules.find((r) => r.selector === '.ds-stagger > *')?.body).toContain('animation-delay: calc(var(--ds-i, 12) * var(--ds-motion-stagger))');
    for (const k of ['ds-rise-in', 'ds-scale-in', 'ds-slide-in-right', 'ds-pop']) {
      const frames = rules.filter((r) => r.parents.includes(`@keyframes ${k}`));
      expect(frames.at(-1)?.body, k).toContain('transform: none');
    }
    expect(rules.filter((r) => r.parents.includes('@keyframes ds-reveal-in')).at(-1)?.body).toContain('translate: none');
  });

  it('the scroll reveal is visible without JS: it animates only on the scroll timeline, and it moves `translate`', () => {
    const reveal = rules.filter((r) => r.selector === '.ds-reveal');
    expect(reveal).toHaveLength(1);
    expect(reveal[0].parents).toEqual(['@supports (animation-timeline: view())']);
    expect(reveal[0].body).toContain('animation-timeline: view()');
    expect(CODE).not.toMatch(/\.ds-reveal\s*\{[^}]*opacity:\s*0/);
  });

  it('the scroll reveal always finishes: its range is capped at the element’s own entry (a deviation from Atlas’s fixed 200 px)', () => {
    // `entry 0% entry 200px` (Atlas) never completes for an element shorter than 200 px at the end of a page,
    // or for anything in the bottom 200 px of a page that cannot scroll: a 60 px last row stayed at opacity
    // 0.84. min(200px, 100%) ends at the element's full entry when that comes first; tall panels are unchanged.
    const reveal = rules.find((r) => r.selector === '.ds-reveal');
    expect(reveal?.body).toMatch(/animation-range:\s*entry 0% entry min\(200px,\s*100%\);/);
  });

  it('the live dot, caret, marquee, skeleton, shimmer-text, making sweep and indeterminate bar pause while their host is off screen', () => {
    const pause = rules.find((r) => /animation-play-state: paused/.test(r.body) && r.selector.includes('[data-inview="false"]'));
    const selectors = pause ? topLevelSplit(pause.selector).map((s) => s.trim()) : [];
    // The progress bar pauses on its own data-inview too (renderTile's DrawingBar carries no arbitrary class for it: PF-2 #3).
    for (const s of ['[data-inview="false"] .ds-marquee-track', '[data-inview="false"] .ds-live-dot::after', '.ds-live-dot[data-inview="false"]::after', '[data-inview="false"] .ds-caret', '[data-inview="false"] .ds-skeleton', '[data-inview="false"] .ds-shimmer-text', '[data-inview="false"] .ds-making-sweep::after', '[data-inview="false"] .ds-progress-indeterminate::after', '.ds-progress-indeterminate[data-inview="false"]::after']) {
      expect(selectors, s).toContain(s);
    }
  });

  it('ONE reduced-motion block stops every entrance and loop, wraps the marquee and makes shimmer-text plain text', () => {
    expect(SOURCE.match(/@media \(prefers-reduced-motion: reduce\)/g)).toHaveLength(1);
    for (const s of ['.ds-rise-in', '.ds-fade-in', '.ds-scale-in', '.ds-slide-in-right', '.ds-blur-in', '.ds-pop', '.ds-draw :is(path, polyline, line)', '.ds-flash', '.ds-stagger > *', '.ds-reveal', '.ds-skeleton', '.ds-live-dot::after', '.ds-caret', '.ds-progress-indeterminate::after', '.ds-disclosure[open] > :not(summary)']) {
      expect(reducedBody(s), s).toContain('animation: none');
    }
    const marquee = reducedBody('.ds-marquee-track');
    expect(marquee).toContain('animation: none');
    expect(marquee).toContain('flex-wrap: wrap');
    expect(marquee).toContain('width: auto');
    const shimmer = reducedBody('.ds-shimmer-text');
    expect(shimmer).toContain('animation: none');
    expect(shimmer).toContain('background: none');
    expect(shimmer).toContain('-webkit-text-fill-color: currentColor');
    expect(reducedBody('.ds-lift')).toContain('transition: none');
    expect(reducedBody('.ds-lift:hover')).toContain('transform: none');
    // The edge fades are scroll-linked, but document.getAnimations() still lists them (the layout smoke's
    // reduced-motion rule): under reduced motion they stop and the scroller shows its content with no mask.
    for (const s of ['.ds-fade-edge-x', '.ds-fade-edge-y']) {
      expect(reducedBody(s), s).toContain('animation: none');
      expect(reducedBody(s), s).toContain('mask-image: none');
    }
    // Every class that animates or transitions outside the block is covered inside it.
    const moving = rules.filter((r) => !r.parents.includes(REDUCE) && !r.parents.some((p) => p.startsWith('@keyframes')) && /(?:^|;\s*)(?:animation|transition)\s*:/.test(r.body))
      
      .flatMap((r) => topLevelSplit(r.selector).map((s) => s.trim()));
    const covered = new Set(reduced.flatMap((r) => topLevelSplit(r.selector).map((s) => s.trim())));
    expect(moving.filter((s) => !covered.has(s) && !covered.has(s.replace(/:hover$/, '')))).toEqual([]);
  });

  it('the lift answers only a pointer that really hovers', () => {
    const hover = rules.find((r) => r.selector === '.ds-lift:hover' && !r.parents.includes(REDUCE));
    expect(hover?.parents).toEqual(['@media (hover: hover) and (pointer: fine)']);
    expect(hover?.body).toContain('transform: translateY(-2px)');
    expect(hover?.body).toContain('box-shadow: var(--ds-shadow-lift)');
  });

  it('type: the overline is 11 px / 600 / 0.12em / muted, the display overline 12 px / 0.18em, .ds-display the display face', () => {
    expect(rules.find((r) => r.selector === '.ds-overline')?.body).toMatch(/font-size: 11px;[\s\S]*font-weight: 600;[\s\S]*letter-spacing: 0\.12em;[\s\S]*color: var\(--ds-muted\)/);
    expect(rules.find((r) => r.selector === '.ds-overline-display')?.body).toMatch(/font-size: 12px;[\s\S]*letter-spacing: 0\.18em/);
    expect(rules.find((r) => r.selector === '.ds-display')?.body).toBe('font-family: var(--ds-font-display);');
    expect(rules.find((r) => r.selector === '.ds-grid-backdrop')?.body).toContain('radial-gradient(var(--ds-grid-dot) 1px, transparent 1px)');
  });
});
