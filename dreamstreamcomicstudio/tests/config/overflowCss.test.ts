// @vitest-environment node
/**
 * The long-word safety net (SPEC-overflow §3.2; docs/design/design-system.md "Long words"): index.css gives every alert
 * and our own message slots `overflow-wrap: anywhere`, globally, in the base layer, with a `word-break: break-word`
 * fallback for browsers without `anywhere` (Safari < 15.4 is inside Vite's default build target).
 *
 * 1. Source: the rule is exactly the three selectors, inside `@layer base`, outside any `[data-ds-skin]` block, and no
 *    `role="status"` or `role="alertdialog"` selector carries a wrap rule (short labels in tight rows; whole consent
 *    dialogs with prices). The `@supports not (overflow-wrap: anywhere)` block covers the same selectors and the
 *    WRAP_TEXT utility.
 * 2. Compiled: index.css run through this app's Tailwind and config (the dsColours.test.ts pattern) with a raw content
 *    probe still holds the net, the fallback and the `[overflow-wrap:anywhere]` utility: the rule survives Tailwind's
 *    base-layer hoisting, so it really ships.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, indexCss, norm, parseRules } from './cssTokens';

const require = createRequire(import.meta.url);
const tailwind = require('tailwindcss') as (config: unknown) => postcss.AcceptedPlugin;
const config = require(path.join(APP_ROOT, 'tailwind.config.cjs')) as Record<string, unknown>;

const NET = ['[role="alert"]', '[data-slot="error-state"]', '[data-slot="message"]'];
const FALLBACK = [...NET, '.\\[overflow-wrap\\:anywhere\\]'];
const SUPPORTS = '@supports not (overflow-wrap: anywhere)';
const selectorsOf = (selector: string) => selector.split(',').map((s) => s.trim());
const declsOf = (body: string) => norm(body).replace(/;\s*$/, '');
/** parseRules names an at-rule with the statements before it (`@import …; @tailwind …; @layer base`): keep the last. */
const parentsOf = (parents: string[]) => parents.map((p) => p.split(';').pop()!.trim());

describe('the long-word safety net in index.css (source)', () => {
  const rules = parseRules(indexCss);

  it('one rule: exactly the three selectors, overflow-wrap: anywhere, in @layer base, outside every skin block', () => {
    const net = rules.filter((r) => /overflow-wrap:\s*anywhere/.test(r.body) && selectorsOf(r.selector).includes('[role="alert"]'));
    expect(net).toHaveLength(1);
    const [rule] = net;
    expect(selectorsOf(rule.selector)).toEqual(NET);
    expect(declsOf(rule.body)).toBe('overflow-wrap: anywhere');
    expect(parentsOf(rule.parents)).toEqual(['@layer base']);
    expect(rule.parents.some((p) => p.includes('data-ds-skin'))).toBe(false);
  });

  it('the fallback: @supports not (overflow-wrap: anywhere) gives the same selectors and the utility word-break: break-word', () => {
    const fallback = rules.filter((r) => parentsOf(r.parents).includes(SUPPORTS));
    expect(fallback).toHaveLength(1);
    expect(parentsOf(fallback[0].parents)).toEqual(['@layer base', SUPPORTS]);
    expect(selectorsOf(fallback[0].selector)).toEqual(FALLBACK);
    expect(declsOf(fallback[0].body)).toBe('word-break: break-word');
  });

  it('no role="status" or role="alertdialog" selector carries a wrap rule', () => {
    const wraps = rules.filter((r) => /overflow-wrap|word-break/.test(r.body));
    for (const r of wraps) {
      expect(r.selector, r.selector).not.toMatch(/role="(status|alertdialog)"/);
    }
  });
});

describe('the long-word safety net in the compiled CSS', () => {
  const compile = async (): Promise<string> => {
    const probe = '<div class="min-w-0 [overflow-wrap:anywhere] line-clamp-2 truncate"></div>';
    const result = await postcss([tailwind({ ...config, content: [{ raw: probe, extension: 'html' }] })]).process(indexCss, { from: path.join(APP_ROOT, 'index.css') });
    return result.css.replace(/\s+/g, ' ');
  };

  it('keeps the net, the @supports fallback and the [overflow-wrap:anywhere] utility', { timeout: 60_000 }, async () => {
    const css = await compile();
    expect(css).toContain('[role="alert"], [data-slot="error-state"], [data-slot="message"] { overflow-wrap: anywhere; }');
    expect(css).toMatch(/@supports not \(overflow-wrap: anywhere\) \{ \[role="alert"\], \[data-slot="error-state"\], \[data-slot="message"\], \.\\\[overflow-wrap\\:anywhere\\\] \{ word-break: break-word; \} \}/);
    expect(css).toMatch(/\.\\\[overflow-wrap\\:anywhere\\\] ?\{ overflow-wrap: anywhere; \}/);
    // The net sits in the base layer: before the utilities (a `truncate` on a descendant still wins).
    const net = css.indexOf('[data-slot="message"] { overflow-wrap: anywhere; }');
    const truncate = css.search(/\.truncate ?\{/);
    expect(net).toBeGreaterThan(-1);
    expect(net).toBeLessThan(truncate);
  });
});
