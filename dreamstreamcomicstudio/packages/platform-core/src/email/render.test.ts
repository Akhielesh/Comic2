// @vitest-environment node
//
// renderEmail / emailToPlainText (plan §7, §9, W1.3). For every render case (the contract fixtures, a hostile
// unchecked document, two brands, a creator's own kit and all nine templates):
// - no <script, no on*= attribute, no http: resource, no url()/@import; only allowlisted tags and attributes;
// - every href is https:/mailto: and is listed by reviewEmail; every src is a sniffed data: PNG/JPEG/WebP;
// - untrusted text is escaped; a javascript: (or http:, data:, quote-breaking) href is dropped, its text kept;
// - golden SHA-256 of the HTML and of the text, per case (fixtures/email/golden.json + golden/<case>.*).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { EmailDoc, EmailReviewContext } from '../contract/email.js';
import { isSafeHref } from '../schema/check.js';
import { ATLAS_BRAND, DREAMSTREAM_BRAND, checkBrandKit, type BrandKit } from '../brand/index.js';
import { EMAIL_TEMPLATES, EMAIL_TEMPLATE_IDS, emailToPlainText, fillTemplate, renderEmail, reviewEmail, type RenderEmailOptions } from './index.js';
import { trimEnd } from './layout.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const load = <T>(rel: string): T => JSON.parse(readFileSync(FIXTURES + rel, 'utf8')) as T;

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const minimal = load<EmailDoc>('contract/email/minimal.json');
const full = load<EmailDoc>('contract/email/full.json');
const reply = load<EmailDoc>('contract/email/reply.json');
const hostile = load<EmailDoc>('email/hostile.json');
const creatorKit = load<BrandKit>('email/creator-brand.json');

interface Case {
  name: string;
  doc: EmailDoc;
  brand?: BrandKit;
  options?: RenderEmailOptions;
}

const templateDoc = (id: (typeof EMAIL_TEMPLATE_IDS)[number]): EmailDoc => {
  const r = fillTemplate(id, EMAIL_TEMPLATES[id].example as never);
  if (r.ok === false) throw new Error(`${id}: ${JSON.stringify(r.errors)}`);
  return r.doc;
};

const CASES: Case[] = [
  { name: 'minimal', doc: minimal },
  { name: 'full', doc: full },
  { name: 'full-atlas', doc: full, brand: ATLAS_BRAND, options: { resolveAsset: (id) => (id === 'user-0001/assets/page-1.png' ? PNG_1PX : undefined) } },
  { name: 'reply', doc: reply },
  { name: 'hostile', doc: hostile },
  { name: 'creator-brand', doc: full, brand: creatorKit },
  ...EMAIL_TEMPLATE_IDS.map((id): Case => ({ name: `template-${id}`, doc: templateDoc(id) })),
];

const render = (c: Case) => renderEmail(c.doc, c.brand, c.options);

// ── A small HTML reader: every `<` in our output starts markup, because text is escaped ─────────────────────────

interface Tag {
  name: string;
  attrs: { name: string; value: string }[];
}

const decode = (v: string): string => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const tagsOf = (html: string): Tag[] => {
  const out: Tag[] = [];
  const re = /<(\/?)([A-Za-z!][A-Za-z0-9:-]*)([^>]*)>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) continue;
    const attrs: Tag['attrs'] = [];
    const ar = /([^\s=/]+)(?:="([^"]*)")?/g;
    const body = m[3];
    for (let a = ar.exec(body); a; a = ar.exec(body)) if (a[1] !== '/') attrs.push({ name: a[1].toLowerCase(), value: decode(a[2] ?? '') });
    out.push({ name: m[2].toLowerCase(), attrs });
  }
  return out;
};

const attrValues = (html: string, attr: string): string[] =>
  tagsOf(html).reduce<string[]>((acc, t) => acc.concat(t.attrs.filter((a) => a.name === attr).map((a) => a.value)), []);

const TAGS = ['!doctype', 'html', 'head', 'meta', 'title', 'style', 'body', 'div', 'table', 'tr', 'td', 'h1', 'h2', 'h3', 'p', 'a', 'strong', 'em', 'u', 'code', 'ul', 'ol', 'li', 'blockquote', 'span', 'img', 'br'];
const ATTRS = ['html', 'lang', 'charset', 'name', 'content', 'style', 'role', 'width', 'cellpadding', 'cellspacing', 'align', 'valign', 'class', 'bgcolor', 'href', 'target', 'rel', 'src', 'alt'];
const DATA_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const STYLE_BLOCK = `<style>
body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; }
@media (max-width:600px) { .ds-card { padding:24px 18px !important; } .ds-col { display:block !important; width:100% !important; padding:0 !important; } }
</style>`;

const multiset = (xs: string[]): string[] => xs.slice().sort();

describe('every render case is safe', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      const { html, text } = render(c);
      const ctx: EmailReviewContext = { mode: c.doc.mode, participants: [], userTyped: [] };

      it('has no <script, only allowlisted tags, and no on*= (or other unexpected) attribute', () => {
        expect(html).not.toMatch(/<script/i);
        const tags = tagsOf(html);
        expect(tags.length).toBeGreaterThan(10);
        for (const t of tags) {
          expect(TAGS, t.name).toContain(t.name);
          for (const a of t.attrs) {
            expect(a.name).not.toMatch(/^on/i);
            expect(ATTRS, `${t.name} ${a.name}`).toContain(a.name);
          }
        }
      });

      it('loads no resource: every src is a sniffed data: image; no http:, url(), @import or second <style>', () => {
        for (const src of attrValues(html, 'src')) expect(src).toMatch(DATA_IMAGE);
        for (const t of tagsOf(html)) for (const a of t.attrs) expect(a.value.toLowerCase(), `${t.name} ${a.name}`).not.toContain('http:');
        expect(html).not.toMatch(/url\s*\(|@import|expression\s*\(|<link|srcset|background=/i);
        expect(html.split('<style>')).toHaveLength(2);
        expect(html).toContain(STYLE_BLOCK);
      });

      it('every href is https: or mailto:, safe, and listed by reviewEmail', () => {
        const hrefs = attrValues(html, 'href');
        for (const href of hrefs) {
          expect(href).toMatch(/^(https:\/\/|mailto:)/);
          expect(isSafeHref(href), href).toBe(true);
        }
        expect(multiset(hrefs)).toEqual(multiset(reviewEmail(c.doc, ctx).links.map((l) => l.href)));
      });

      it('the text has no control or bidi characters and no markup', () => {
        expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
        expect(text).toBe(emailToPlainText(c.doc));
      });

      it('is deterministic', () => {
        expect(render(c)).toEqual({ html, text });
      });
    });
  }
});

describe('untrusted text is escaped, unsafe links are dropped', () => {
  const { html, text } = renderEmail(hostile);

  it('<img onerror> in a heading stays text', () => {
    expect(html).toContain('<h1 style="margin:0 0 16px;font-family:\'Inter\'');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;</h1>');
    for (const t of tagsOf(html)) for (const a of t.attrs) expect(a.name).not.toBe('onerror');
  });

  it('the subject, preheader, cite, signature and labels are escaped', () => {
    expect(html).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt; Hello &quot;quoted&quot; &amp; &#39;single&#39;</title>');
    expect(html).toContain('&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('— &lt;i&gt;someone&lt;/i&gt;');
    expect(html).toContain('Alex<br>&lt;script&gt;sig&lt;/script&gt;');
    expect(html).toContain('<strong>Click &lt;me&gt;</strong>');
  });

  it('a javascript: href is dropped and its text kept; so are vbscript:, http:, data:, upper-case and quote-breaking hrefs', () => {
    expect(html).toContain('js link http link data link quote breakout upper case');
    expect(html).not.toMatch(/javascript:|vbscript:|onmouseover/i);
    expect(attrValues(html, 'href')).toEqual([
      'https://docs.example.com/heading',
      'https://ok.example.com/path?a=1&b=2',
      'mailto:quoted@example.org?subject=Re',
      'mailto:someone@evil.example?subject=hi',
      'mailto:list@example.org',
      'https://list.example.com/item',
      'https://evil.example.net/login',
    ]);
    expect(html).toContain('href="https://ok.example.com/path?a=1&amp;b=2"');
    expect(text).toContain('js link http link data link quote breakout upper case');
    expect(text).not.toMatch(/javascript:|vbscript:|http:/);
  });

  it('only the marks it knows, and code is styled text', () => {
    expect(html).toContain('<strong><code style="font-family:Menlo,Consolas,\'Courier New\',monospace;');
    expect(html).not.toContain('onclick');
  });

  it('control and bidi characters are removed; CRLF becomes a line break', () => {
    expect(html).toContain(' controls:[31m and bidi exe.pdf');
    expect(html).toContain('line one<br>line two');
    expect(html).not.toMatch(/[\u0000\u0007\u001b‮]/);
  });

  it('SVG, URL, lying and path-traversal images become their alt text, a real one keeps a quote-breaking alt inside its attribute; nested columns and unknown blocks vanish', () => {
    expect(attrValues(html, 'src')).toEqual([PNG_1PX]); // only the real PNG, its alt escaped inside the attribute
    expect(html).toContain('alt="cover&quot; onerror=&quot;alert(1)&quot; x=&quot;" width="534"');
    expect(html).toContain('[Image: &quot; onerror=&quot;alert(1)]');
    expect(html).toContain('[Image: pixel]');
    expect(html).toContain('[Image: a PNG header lie]');
    expect(html).toContain('[Image: path traversal]');
    expect(html).not.toContain('nested columns are dropped');
    expect(html).not.toContain('alert(1)</');
    expect(text).toContain('[Image: pixel]');
  });

  it('a heading with a bad level and no runs renders nothing (no empty <h1>), and the rest still renders', () => {
    expect(html).not.toContain('></h1>');
    expect(html.match(/<h1 /g)).toHaveLength(1);
    expect(html).toContain('Alex<br>');
  });

  it('links inside a heading, a quote, a list item and a list inside columns are written as links (and listed: see "every render case")', () => {
    expect(html).toContain('<h2 style="margin:0 0 16px;font-family:');
    expect(html).toMatch(/Read the <a href="https:\/\/docs\.example\.com\/heading" target="_blank" rel="noopener noreferrer" style="[^"]*">heading link<\/a><\/h2>/);
    expect(html).toMatch(/line one<br>line two<a href="mailto:quoted@example\.org\?subject=Re" [^>]*> quoted reply<\/a><span/);
    expect(html).toMatch(/<li style="margin:0 0 6px;">see <a href="https:\/\/list\.example\.com\/item" [^>]*>the list link<\/a> and a bad one<\/li>/);
    expect(html).toMatch(/<td class="ds-col"[^>]*>[\s\S]*<ul [^>]*><li style="margin:0 0 6px;"><a href="mailto:list@example\.org" [^>]*>column list mail<\/a><\/li><\/ul>/);
    expect(text).toContain('Read the heading link (https://docs.example.com/heading)');
    expect(text).toContain('> line two quoted reply (mailto:quoted@example.org?subject=Re)');
    expect(text).toContain('2. see the list link (https://list.example.com/item) and a bad one');
    expect(text).toContain('- column list mail (mailto:list@example.org)');
  });

  it('a list indent beyond the cap falls back to 0', () => {
    expect(html).toContain('<li style="margin:0 0 6px;">style=&quot;x&quot; on*=y</li>');
  });
});

describe('images come only from data: URIs we hold', () => {
  it('a host asset id is shown only through resolveAsset, which is never handed an unsafe id', () => {
    const resolveAsset = vi.fn((id: string) => (id === 'user-0001/assets/page-1.png' ? PNG_1PX : undefined));
    const { html } = renderEmail(full, null, { resolveAsset });
    expect(attrValues(html, 'src')).toContain(PNG_1PX);
    expect(resolveAsset).toHaveBeenCalledWith('user-0001/assets/page-1.png');
    renderEmail(hostile, null, { resolveAsset });
    expect(resolveAsset).not.toHaveBeenCalledWith('../../etc/passwd');
  });

  it('a resolver that throws, or hands back a URL or an SVG, shows the alt text', () => {
    for (const resolveAsset of [
      () => {
        throw new Error('boom');
      },
      () => 'https://cdn.example.com/page-1.png',
      () => 'data:image/svg+xml;base64,PHN2Zz4=',
    ]) {
      const { html } = renderEmail(full, null, { resolveAsset });
      expect(html).toContain('[Image: Page one]');
      expect(attrValues(html, 'src')).toHaveLength(1); // the inline webp cover only
    }
  });

  it('without a resolver the asset image is alt text and the data: cover is inline', () => {
    const { html } = renderEmail(full);
    expect(attrValues(html, 'src')).toEqual(['data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==']);
    expect(html).toContain('[Image: Page one]');
  });
});

describe('BrandKits theme the email and cannot inject CSS', () => {
  it('the atlas kit uses its fonts and ink', () => {
    const { html } = renderEmail(full, ATLAS_BRAND);
    expect(html).toContain("font-family:'Space Grotesk'");
    expect(html).toContain("font-family:'IBM Plex Sans'");
    expect(html).toContain('background:#0a0a0a');
  });

  it('the document brand id picks a built-in kit when the host passes none', () => {
    expect(renderEmail({ ...minimal, brand: 'atlas' }).html).toBe(renderEmail(minimal, ATLAS_BRAND).html);
    expect(renderEmail({ ...minimal, brand: 'unknown' }).html).toBe(renderEmail(minimal, DREAMSTREAM_BRAND).html);
  });

  it("a creator's own kit puts its data: logo and footer around the card", () => {
    expect(checkBrandKit(creatorKit)).toEqual([]);
    const { html } = renderEmail(minimal, creatorKit);
    expect(html).toContain(`<img src="${creatorKit.logo && creatorKit.logo.kind === 'data' ? creatorKit.logo.dataUri : ''}" alt="Lighthouse Comics" width="160"`);
    expect(html).toContain('Lighthouse Comics: stories from the edge of the map</td></tr>');
    expect(html).toContain("font-family:'Comic Neue'");
  });

  it('a hostile kit falls back to safe defaults', () => {
    const evil = {
      ...DREAMSTREAM_BRAND,
      wordmark: '<script>w</script>',
      colors: { ...DREAMSTREAM_BRAND.colors, ink: 'red;background:url(https://x.example/a)', accent: '#000"><script>' },
      fonts: { body: "x'; background:url(https://x.example/f)", display: 'inter' },
      logo: { kind: 'data' as const, dataUri: 'https://x.example/logo.png' },
      emailTheme: { header: 'logo' as const, radius: 9999, buttonRadius: -1, footer: '<b>foot</b>' },
    };
    const { html } = renderEmail(full, evil as BrandKit);
    expect(html).not.toMatch(/url\(|<script|x\.example/);
    expect(html).toContain('color:#1a1915');
    expect(html).toContain('&lt;script&gt;w&lt;/script&gt;</span>'); // no valid logo: the escaped wordmark
    expect(html).toContain('&lt;b&gt;foot&lt;/b&gt;');
    expect(html).toContain('border-radius:16px');
  });

  it('lang: a BCP 47 tag or en', () => {
    expect(renderEmail(minimal, null, { lang: 'te-IN' }).html).toContain('<html lang="te-IN">');
    expect(renderEmail(minimal, null, { lang: 'en"><script>' }).html).toContain('<html lang="en">');
  });

  it('never throws on garbage', () => {
    for (const d of [null, undefined, 7, 'doc', [], {}, { blocks: 'x', to: 3 }, { blocks: [null, 1, { type: 'image' }, { type: 'columns', columns: [null] }] }]) {
      expect(() => renderEmail(d as unknown as EmailDoc)).not.toThrow();
      expect(() => emailToPlainText(d as unknown as EmailDoc)).not.toThrow();
    }
  });
});

describe('emailToPlainText', () => {
  it('spells out every link, numbers and indents lists, quotes with >, and signs off after "-- "', () => {
    expect(emailToPlainText(full)).toBe(
      [
        'The Lighthouse Keeper',
        '',
        'Hi Sam, thanks for the call. The sample pages (https://example.com/samples?issue=1) are ready.',
        '',
        'What is in the pack',
        '',
        '- A one-page pitch\n  - Six sample pages\n- A pitch deck',
        '',
        'Open the samples: https://example.com/samples',
        '',
        '> Send me the first issue when it is ready.\n> — Sam Editor',
        '',
        '---',
        '',
        '[Image: Cover]',
        '',
        'Schedule',
        '',
        'Issue one in March; questions to me (mailto:creator@example.com).',
        '',
        'Reply: mailto:creator@example.com?subject=Lighthouse',
        '',
        '[Image: Page one]',
        '',
        '-- \nSample Creator\nThe Lighthouse Keeper',
      ].join('\n')
    );
  });

  it('shows a URL once when the link text already is it, and numbers ordered lists', () => {
    const d: EmailDoc = {
      v: 1,
      mode: 'compose',
      subject: 's',
      to: [],
      blocks: [
        { type: 'paragraph', id: 'p1', runs: [{ text: 'https://a.example.com', link: { href: 'https://a.example.com' } }, { text: ' and ' }, { text: 'b@example.com', link: { href: 'mailto:b@example.com' } }] },
        { type: 'list', id: 'l1', ordered: true, items: [{ runs: [{ text: 'one\nmore' }] }, { runs: [{ text: 'two' }] }] },
      ],
    };
    expect(emailToPlainText(d)).toBe('https://a.example.com and b@example.com\n\n1. one\n   more\n2. two');
  });
});

describe('bounded work on model-written text', () => {
  it('trimEnd drops trailing whitespace only', () => {
    expect(trimEnd('Alex \t\n ')).toBe('Alex');
    expect(trimEnd('  Alex')).toBe('  Alex');
    expect(trimEnd(' \n\t')).toBe('');
    expect(trimEnd('')).toBe('');
  });

  it('a 10,000-character whitespace signature renders in linear time (no /\\s+$/ backtracking)', () => {
    const spacesThenText: EmailDoc = { ...minimal, signature: `${' '.repeat(9999)}x` };
    const textThenSpaces: EmailDoc = { ...minimal, signature: `Alex${' \t\n'.repeat(3332)}` };
    const started = Date.now();
    for (let i = 0; i < 10; i++) {
      for (const d of [spacesThenText, textThenSpaces]) {
        renderEmail(d);
        reviewEmail(d, { mode: 'compose', participants: [], userTyped: [] });
      }
    }
    expect(Date.now() - started).toBeLessThan(250);
    expect(emailToPlainText(spacesThenText).endsWith(`-- \n${' '.repeat(9999)}x`)).toBe(true);
    expect(emailToPlainText(textThenSpaces).endsWith('-- \nAlex')).toBe(true);
    expect(renderEmail(textThenSpaces).html).toContain('">Alex</p>');
  });
});

// ── Goldens ─────────────────────────────────────────────────────────────────────────────────────────────────────

const GOLDEN_JSON = `${FIXTURES}email/golden.json`;
const GOLDEN_DIR = `${FIXTURES}email/golden/`;
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('golden HTML and text SHA-256 per fixture', () => {
  if (process.env.UPDATE_EMAIL_GOLDEN === '1') {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    const golden: Record<string, { html: string; text: string }> = {};
    for (const c of CASES) {
      const { html, text } = render(c);
      writeFileSync(`${GOLDEN_DIR}${c.name}.html`, html);
      writeFileSync(`${GOLDEN_DIR}${c.name}.txt`, text);
      golden[c.name] = { html: sha256(html), text: sha256(text) };
    }
    writeFileSync(GOLDEN_JSON, `${JSON.stringify(golden, null, 2)}\n`);
  }

  const golden = existsSync(GOLDEN_JSON) ? (JSON.parse(readFileSync(GOLDEN_JSON, 'utf8')) as Record<string, { html: string; text: string }>) : {};

  it('covers every case and nothing else', () => {
    expect(Object.keys(golden).sort()).toEqual(CASES.map((c) => c.name).sort());
  });

  for (const c of CASES) {
    it(c.name, () => {
      const { html, text } = render(c);
      expect(html).toBe(readFileSync(`${GOLDEN_DIR}${c.name}.html`, 'utf8'));
      expect(text).toBe(readFileSync(`${GOLDEN_DIR}${c.name}.txt`, 'utf8'));
      expect({ html: sha256(html), text: sha256(text) }).toEqual(golden[c.name]);
    });
  }
});
