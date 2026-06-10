// Curated MCP marketplace (Phase 10). A small, vetted list of well-known remote MCP
// servers a user can connect in one click, instead of hand-typing a URL. Kept
// intentionally conservative: only https, widely-used servers; each entry documents the
// scopes/keys it needs so the UI can be honest about what connecting grants. This is a
// static catalog (no network) — the client renders it in the Tools dashboard and POSTs a
// chosen entry to the MCP registry like any other server.

export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  /** The MCP endpoint to connect (https). Some require the user to paste their own token. */
  url: string;
  /** What connecting can access, shown to the user before they connect. */
  scopes: string[];
  /** Whether the user must supply an auth header/token for this server. */
  requiresAuth: boolean;
  category: 'search' | 'dev' | 'productivity' | 'data' | 'docs' | 'travel';
}

// NOTE: URLs are illustrative connect targets; the registry SSRF-guards every one on save.
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    description: 'Ask questions about any public GitHub repository — docs, architecture and code, answered from an indexed wiki.',
    url: 'https://mcp.deepwiki.com/mcp',
    scopes: ['Read public repository documentation'],
    requiresAuth: false,
    category: 'docs'
  },
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date documentation and code examples for thousands of libraries and frameworks.',
    url: 'https://mcp.context7.com/mcp',
    scopes: ['Read library documentation'],
    requiresAuth: false,
    category: 'docs'
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Search models, datasets and Spaces on the Hugging Face Hub.',
    url: 'https://huggingface.co/mcp',
    scopes: ['Search public Hub content'],
    requiresAuth: false,
    category: 'data'
  },
  {
    id: 'microsoft-learn',
    name: 'Microsoft Learn',
    description: 'Q&A over official Microsoft and Azure documentation on Microsoft Learn.',
    url: 'https://learn.microsoft.com/api/mcp',
    scopes: ['Read public Microsoft Learn documentation'],
    requiresAuth: false,
    category: 'docs'
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare Docs',
    description: 'Search and read the Cloudflare platform documentation (Workers, R2, DNS, …).',
    url: 'https://docs.mcp.cloudflare.com/sse',
    scopes: ['Read public Cloudflare documentation'],
    requiresAuth: false,
    category: 'docs'
  },
  {
    id: 'astro-docs',
    name: 'Astro Docs',
    description: 'Official documentation for the Astro web framework, queryable by the agent.',
    url: 'https://mcp.docs.astro.build/mcp',
    scopes: ['Read public Astro documentation'],
    requiresAuth: false,
    category: 'docs'
  },
  {
    id: 'aws-knowledge',
    name: 'AWS Knowledge',
    description: 'AWS documentation, API references and architectural guidance.',
    url: 'https://knowledge-mcp.global.api.aws',
    scopes: ['Read public AWS documentation and reference'],
    requiresAuth: false,
    category: 'docs'
  },
  {
    id: 'gitmcp',
    name: 'GitMCP',
    description: "Explore any public GitHub repository's docs and code through one endpoint.",
    url: 'https://gitmcp.io/docs',
    scopes: ['Read public GitHub repository docs and code'],
    requiresAuth: false,
    category: 'dev'
  },
  {
    id: 'semgrep',
    name: 'Semgrep',
    description: 'Static code analysis — scan code snippets for bugs and security issues.',
    url: 'https://mcp.semgrep.ai/sse',
    scopes: ['Analyze code you submit for scanning'],
    requiresAuth: false,
    category: 'dev'
  },
  {
    id: 'manifold-markets',
    name: 'Manifold Markets',
    description: 'Prediction market data — search markets and read live forecast probabilities.',
    url: 'https://api.manifold.markets/v0/mcp',
    scopes: ['Read public prediction market data'],
    requiresAuth: false,
    category: 'data'
  },
  {
    id: 'livescore',
    name: 'LiveScore',
    description: 'Live sports scores, fixtures and league standings.',
    url: 'https://livescoremcp.com/sse',
    scopes: ['Read public live sports scores and standings'],
    requiresAuth: false,
    category: 'data'
  },
  {
    id: 'ferryhopper',
    name: 'Ferryhopper',
    description: 'Ferry routes, schedules and booking information across operators.',
    url: 'https://mcp.ferryhopper.com/mcp',
    scopes: ['Read public ferry route and schedule data'],
    requiresAuth: false,
    category: 'travel'
  },
  {
    id: 'subwayinfo-nyc',
    name: 'SubwayInfo NYC',
    description: 'NYC subway and transit status — lines, delays and service alerts.',
    url: 'https://subwayinfo.nyc/mcp',
    scopes: ['Read public NYC transit status'],
    requiresAuth: false,
    category: 'travel'
  }
];

export const findCatalogEntry = (id: string): McpCatalogEntry | undefined =>
  MCP_CATALOG.find((e) => e.id === id);
