import { describe, it, expect } from 'vitest';
import { renderLiveTemplate, validateLiveTemplate, readTemplatePath, LIVE_TEMPLATE_FORMAT } from './liveTemplate.js';

describe('liveTemplate (html_template_v1)', () => {
  it('exposes the format id', () => {
    expect(LIVE_TEMPLATE_FORMAT).toBe('html_template_v1');
  });

  it('resolves dot-paths (incl. array indices) and returns undefined for missing', () => {
    const data = { users: [{ name: 'Ada' }, { name: 'Lin' }], count: 2 };
    expect(readTemplatePath(data, 'users.0.name')).toBe('Ada');
    expect(readTemplatePath(data, 'count')).toBe(2);
    expect(readTemplatePath(data, 'users.9.name')).toBeUndefined();
    expect(readTemplatePath(data, 'nope.deep')).toBeUndefined();
  });

  it('interpolates bindings and HTML-escapes values', () => {
    const html = renderLiveTemplate('<h1>{{ title }}</h1><p>{{ count }} by {{ author }}</p>', {
      title: 'Sales <b>Q1</b>', count: 42, author: 'A & B',
    });
    expect(html).toBe('<h1>Sales &lt;b&gt;Q1&lt;/b&gt;</h1><p>42 by A &amp; B</p>');
  });

  it('renders missing bindings as empty strings', () => {
    expect(renderLiveTemplate('<p>{{ missing }}</p>', {})).toBe('<p></p>');
  });

  it('rejects script-bearing / unsafe templates (data-only)', () => {
    expect(validateLiveTemplate('<script>alert(1)</script>').ok).toBe(false);
    expect(validateLiveTemplate('<div onclick="x()">y</div>').ok).toBe(false);
    expect(validateLiveTemplate('<a href="javascript:x()">y</a>').ok).toBe(false);
    expect(validateLiveTemplate('<iframe srcdoc="x"></iframe>').ok).toBe(false);
    expect(validateLiveTemplate('<div>{{ x }}</div>').ok).toBe(true);
    expect(() => renderLiveTemplate('<script>x</script>', {})).toThrow();
  });
});
