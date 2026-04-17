# SpecBridge MCP

SpecBridge MCP is a **clone-and-own MCP starter** for exposing OpenAPI/Huma contract intelligence to AI agents. It turns OpenAPI/Huma specs into deterministic endpoint metadata, schemas, validation facts, referenced DTOs, and TypeScript declarations that agents can use before changing frontend or client code.

This project is intentionally repository-first rather than npm-published: clone it, adapt the backend registry to your private or public specs, and register the local MCP server with your agent host. The implementation keeps the core unopinionated by avoiding downstream file mutation, using a neutral public demo backend, supporting multiple injected backends, and treating inferred helpers as best-effort rather than guarantees.

> Status: experimental. The tool surface is useful for local automation, but the repository is meant to be owned and adapted by each team.

## Brief history

SpecBridge MCP started as a personal internal tool at SesameLab to improve the development cycle around backend API contracts. In practice, giving AI agents structured OpenAPI/Huma contract data through MCP reduced hallucinations compared with asking them to read API documentation pages directly.

## What it provides

- Configurable backend registry for one or many OpenAPI/Huma-compatible specs
- Zero-config demo backend using a real public OpenAPI URL
- Spec loading and refresh with JSON/YAML support
- Endpoint listing and filtering
- Endpoint contract bundles with deterministic facts:
  - operation metadata
  - parameters
  - request and response schemas
  - referenced component schemas
  - endpoint-scoped TypeScript DTO declarations
  - validation facts such as `required`, `nullable`, `enum`, `format`, arrays, maps, and composition
- TypeScript DTO declaration generation from component schemas
- Best-effort proposal helpers that are explicitly secondary to deterministic spec facts

## Non-goals

- Publishing this project to npm for v1
- Providing a generic installable CLI abstraction
- Mutating downstream frontend/client repositories
- Becoming a framework-specific client or SDK generator
- Hosting specs or storing team API data remotely

## Requirements

- Node.js 18+
- pnpm 10+

## Install

```bash
git clone <your-fork-or-copy-url> specbridge-mcp
cd specbridge-mcp
pnpm install
pnpm build
```

## Configure backends

SpecBridge ships with `openapi.backends.json` pointing at a public demo API so the tools work immediately.

To use your own APIs, edit `openapi.backends.json` or point `OPENAPI_BACKENDS_FILE` at another JSON file.

```json
[
  {
    "id": "public-demo",
    "name": "Public Demo API",
    "specUrl": "https://petstore3.swagger.io/api/v3/openapi.json",
    "description": "Public OpenAPI demo backend",
    "domainHints": ["/pet", "/store", "/user"]
  },
  {
    "id": "local-service",
    "name": "Local Service API",
    "specUrl": "http://localhost:8080/openapi.json",
    "fallbackSpecUrls": ["http://localhost:8080/openapi.yaml"],
    "description": "Your local service contract"
  }
]
```

### Configuration precedence

For a tool call, an explicit `specUrl` override is tried first for that call.

Backend registry sources are merged in this order, with later sources overriding earlier ones by `id`:

1. Built-in public demo backend
2. Repository-local `openapi.backends.json`, when present
3. `OPENAPI_BACKENDS_FILE`, when set
4. `OPENAPI_BACKENDS`, when set

`DEFAULT_BACKEND_ID` selects the default backend. If unset, SpecBridge uses `swagger-petstore`.

### Environment variables

- `MCP_TRANSPORT`: `stdio` or `http`
- `MCP_HTTP_HOST`: HTTP bind host
- `MCP_HTTP_PORT`: HTTP port
- `MCP_HTTP_PATH`: MCP endpoint path, such as `/mcp`
- `MCP_HTTP_STATELESS`: set to `true` for stateless HTTP mode
- `DEFAULT_BACKEND_ID`: default backend ID
- `OPENAPI_BACKENDS`: JSON array of backend configs
- `OPENAPI_BACKENDS_FILE`: path to a backend config JSON file
- `OPENAPI_FETCH_TIMEOUT_MS`: fetch timeout for spec loading
- `OPENAPI_CACHE_TTL_MS`: in-memory spec cache TTL
- `OPENAPI_ENABLE_SWAGGER_UI_SCRIPT_EXTRACTION`: opt in to strict JSON object extraction from static Swagger UI scripts; fetched JavaScript is never executed

## Run

### stdio mode

```bash
pnpm mcp
# or
./mcp-server.sh
```

### HTTP mode

```bash
pnpm mcp:http
```

Stateless HTTP mode:

```bash
pnpm mcp:http:stateless
```

## MCP host setup

### Command-based stdio configuration

```json
{
  "mcpServers": {
    "specbridge-mcp": {
      "command": "/absolute/path/to/specbridge-mcp/mcp-server.sh"
    }
  }
}
```

### Codex `config.toml` example

```toml
[mcp_servers.specbridge-mcp]
args = ["/absolute/path/to/specbridge-mcp/mcp-server.sh"]
command = "bash"
```

### HTTP URL

Start the server:

```bash
./mcp-server.sh --transport http --host 127.0.0.1 --port 3000 --path /mcp
```

Then connect your host to:

- `http://127.0.0.1:3000/mcp`

If your host has trouble with session state, retry with `--stateless`.

## Tools

Recommended flow:

1. `list_backends`
2. `load_openapi_spec`
3. `list_api_endpoints`
4. `get_endpoint_contract`
5. `generate_typescript_dto`

### `list_backends`

Lists configured backend targets, the default backend ID, and optional domain hints.

### `load_openapi_spec`

Loads or refreshes an OpenAPI/Huma-compatible spec for a backend. Supports direct `specUrl` overrides.

### `list_api_endpoints`

Lists endpoints from a loaded spec with optional tag, method, path substring, and limit filters.

### `get_endpoint_contract`

Returns a deterministic endpoint contract bundle: operation metadata, parameters, request body, responses, referenced schemas, endpoint-scoped TypeScript DTO declarations, validation facts, and best-effort hints.

### `generate_typescript_dto`

Generates TypeScript DTO declarations from a component schema name and includes referenced nested DTO types.

### `propose_new_endpoint`

Returns a best-effort endpoint and DTO proposal aligned with patterns found in the current spec. Treat this as an agent aid, not a deterministic guarantee.

## Development

```bash
pnpm install
pnpm check
pnpm build
pnpm test
```

Useful scripts:

- `pnpm check`: Biome check
- `pnpm format`: apply Biome formatting
- `pnpm lint`: Biome lint only
- `pnpm build`: clean TypeScript build
- `pnpm test`: build and run all tests
- `pnpm test:e2e`: build and run MCP smoke tests

## Clone-and-own guidance

SpecBridge is intentionally repository-first. Keep the core small, adapt backend configuration locally, and let downstream agents decide how to edit your client code. If your team needs custom auth, internal naming rules, or additional contract facts, add them in your clone rather than fighting a global package abstraction.
