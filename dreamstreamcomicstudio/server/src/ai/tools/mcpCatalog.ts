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
  category: 'search' | 'dev' | 'productivity' | 'data' | 'docs';
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
  }
];

export const findCatalogEntry = (id: string): McpCatalogEntry | undefined =>
  MCP_CATALOG.find((e) => e.id === id);
