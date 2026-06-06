# Code Studio agent-tool sidecars

Self-hosted services that give the Code Studio agents real tools:

- **Nango** — OAuth + token refresh + proxy for 800+ APIs (see `docs/studio/INTEGRATIONS-NANGO.md`).
- **shadcn/ui MCP** — real component source/demos/blocks (React; switch `--framework react-native` for mobile).
- **Magic UI MCP** — animated React + Tailwind components.

The design MCPs are `npx` **stdio** servers; the app's MCP client only speaks **HTTP JSON-RPC**, so
they're fronted with [`supergateway`](https://github.com/supercorp-ai/supergateway) (`--outputTransport
streamableHttp`). Adjust its flags if your bridge version differs — the app just needs a JSON-RPC-over-HTTP
endpoint (it accepts JSON or single-event SSE responses).

## Run

```bash
cp ../../.env.studio-tools.example .env   # set NANGO_ENCRYPTION_KEY (openssl rand -base64 32)
docker compose up -d
```

- Nango API: http://localhost:3003 · Nango dashboard/Connect UI: http://localhost:3009
- shadcn MCP: http://localhost:8001/mcp · Magic UI MCP: http://localhost:8002/mcp

## Wire into the app

Set on the app server (these are read at request time; HTTP/internal hosts are allowed because
operator-configured MCP servers are treated as **trusted**, bypassing the user-URL SSRF guard):

```bash
NANGO_HOST=http://nango-server:3003        # or http://localhost:3003
NANGO_SECRET_KEY=<copied from the Nango dashboard>
STUDIO_SHADCN_MCP_URL=http://shadcn-mcp:8001/mcp
STUDIO_MAGICUI_MCP_URL=http://magicui-mcp:8002/mcp
```

> If the app runs **outside** this compose network, use the published host ports
> (`http://<host>:3003`, `:8001`, `:8002`) instead of the service names.
