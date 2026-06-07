import { describe, it, expect } from 'vitest';
import {
  DESIGN_CHARTER,
  buildDesignDirective,
  ALWAYS_ON_STUDIO_MCP_SERVERS,
  envDesignMcpServers,
  CURATED_MCP_CATALOG,
  DESIGN_PRESETS,
  pickDesignPreset,
  pickDesignSkills,
  DESIGN_SKILLS,
  externalMcpEnabled,
} from './designSystem.js';

describe('designSystem', () => {
  it('buildDesignDirective embeds the charter and self-customizes per request', () => {
    const fresh = buildDesignDirective({ prompt: 'a budgeting app' });
    expect(fresh).toContain(DESIGN_CHARTER);
    expect(fresh).toContain('COMMIT'); // new app: infer an aesthetic and commit to it
    expect(fresh).toContain('WEB + MOBILE BY DEFAULT');

    const refine = buildDesignDirective({ prompt: 'add dark mode', refining: true });
    expect(refine).toContain('EDIT to an existing app'); // refine: extend the established language
    expect(refine).toContain(DESIGN_CHARTER);
  });

  it('always-on MCP servers are curated, https, and include Context7 + DeepWiki', () => {
    const ids = ALWAYS_ON_STUDIO_MCP_SERVERS.map((s) => s.id);
    expect(ids).toContain('context7');
    expect(ids).toContain('deepwiki');
    expect(ALWAYS_ON_STUDIO_MCP_SERVERS.every((s) => s.url.startsWith('https://'))).toBe(true);
  });

  it('envDesignMcpServers maps env vars to trusted servers (http allowed for self-hosted), with optional headers', () => {
    const servers = envDesignMcpServers({
      STUDIO_SHADCN_MCP_URL: 'https://shadcn.example.com/mcp',
      STUDIO_NANGO_MCP_URL: 'http://nango.internal:3003/mcp', // http allowed: operator-configured/trusted
      STUDIO_NANGO_MCP_URL_HEADERS: '{"Authorization":"Bearer secret"}',
      STUDIO_MAGIC_MCP_URL: 'not-a-url', // dropped: not http(s)
    });
    const byId = Object.fromEntries(servers.map((s) => [s.id, s]));
    expect(byId.shadcn.trusted).toBe(true);
    expect(byId.nango.url).toBe('http://nango.internal:3003/mcp');
    expect(byId.nango.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(byId.magic).toBeUndefined();
  });

  it('pickDesignPreset matches by keyword and is null when nothing fits', () => {
    expect(pickDesignPreset('a retro arcade game')!.id).toBe('comic');
    expect(pickDesignPreset('an analytics dashboard with charts')!.id).toBe('data-dashboard');
    expect(pickDesignPreset('a native iOS app')!.id).toBe('ios-native');
    expect(pickDesignPreset('')).toBeNull();
    expect(pickDesignPreset('zzzz nothing matches here')).toBeNull();
  });

  it('buildDesignDirective offers the library + a recommended preset for new apps, skips it on refine', () => {
    const fresh = buildDesignDirective({ prompt: 'an analytics dashboard' });
    expect(fresh).toContain('DESIGN-SYSTEM LIBRARY');
    expect(fresh).toContain('Data Dashboard');
    expect(fresh).toContain(DESIGN_CHARTER);

    const refine = buildDesignDirective({ prompt: 'tweak it', refining: true });
    expect(refine).toContain('EDIT to an existing app');
    expect(refine).not.toContain('DESIGN-SYSTEM LIBRARY');
  });

  it('every preset is well-formed, ids are unique, and the library is comprehensive', () => {
    expect(DESIGN_PRESETS.length).toBeGreaterThanOrEqual(24);
    const ids = new Set<string>();
    for (const p of DESIGN_PRESETS) {
      expect(Boolean(p.id && p.name && p.tagline && p.directive)).toBe(true);
      expect(p.keywords.length).toBeGreaterThan(0);
      ids.add(p.id);
    }
    expect(ids.size).toBe(DESIGN_PRESETS.length); // no duplicate ids
    const od = CURATED_MCP_CATALOG.find((m) => m.id === 'opendesign');
    expect(od?.license).toBe('Apache-2.0');
    expect(od?.envVar).toBe('STUDIO_OPENDESIGN_MCP_URL');
  });

  it('design skills: pick techniques by keyword and inject their recipes', () => {
    const ids = pickDesignSkills('a landing page with a hero and scroll animations').map((s) => s.id);
    expect(ids).toContain('scroll-reveal');
    expect(DESIGN_SKILLS.length).toBeGreaterThanOrEqual(20); // incl. the motion-graphics set
    const d = buildDesignDirective({ prompt: 'a landing page with scroll animations and a data table' });
    expect(d).toContain('TECHNIQUES');
    expect(d).toContain('Data table'); // matched skill recipe is injected
  });

  it('motion-graphics skills are pickable (canvas FX, celebration, parallax)', () => {
    const ids = pickDesignSkills('a generative particle canvas effect, parallax layers, and a confetti celebration on success', 6).map((s) => s.id);
    expect(ids).toContain('canvas-fx');
    expect(ids).toContain('celebration');
    expect(ids).toContain('parallax');
  });

  it('a user-pinned preset overrides the heuristic pick', () => {
    const d = buildDesignDirective({ prompt: 'a dashboard', presetId: 'neobrutalist' });
    expect(d).toContain('user PINNED');
    expect(d).toContain('Neobrutalist');
  });

  it('externalMcpEnabled gates third-party reference MCPs via env (privacy / no-egress)', () => {
    expect(externalMcpEnabled({})).toBe(true);
    expect(externalMcpEnabled({ STUDIO_DISABLE_EXTERNAL_MCP: '1' })).toBe(false);
    expect(externalMcpEnabled({ STUDIO_DISABLE_EXTERNAL_MCP: 'true' })).toBe(false);
    expect(externalMcpEnabled({ STUDIO_DISABLE_EXTERNAL_MCP: 'on' })).toBe(false);
    expect(externalMcpEnabled({ STUDIO_DISABLE_EXTERNAL_MCP: 'no' })).toBe(true);
  });

  it('catalog documents transport + license for every curated tool', () => {
    expect(CURATED_MCP_CATALOG.length).toBeGreaterThan(0);
    for (const m of CURATED_MCP_CATALOG) {
      expect(['http', 'stdio']).toContain(m.transport);
      expect(typeof m.license).toBe('string');
      // stdio servers must declare the env var an operator points at an HTTPS bridge with.
      if (m.transport === 'stdio') expect(m.envVar).toBeTruthy();
    }
  });
});
