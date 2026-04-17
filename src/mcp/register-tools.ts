import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getDefaultBackendId, listBackendConfigs } from "../openapi/config.js";
import { emitSchemaDeclaration, findEndpoint, listEndpoints, loadSpec, simpleOperationSpec } from "../openapi/spec.js";
import { HTTP_METHODS, type HttpMethod } from "../openapi/types.js";

function capitalize(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function suggestBackendsByHints(path: string, currentBackendId: string): string[] {
  return listBackendConfigs()
    .filter((backend) => backend.id !== currentBackendId)
    .filter((backend) => (backend.domainHints || []).some((hint) => path.toLowerCase().startsWith(hint.toLowerCase())))
    .map((backend) => backend.id);
}

async function suggestBackendsBySpec(
  path: string,
  method: HttpMethod,
  currentBackendId: string,
): Promise<{ methodMatches: string[]; pathMatches: string[] }> {
  const candidates = listBackendConfigs().filter((backend) => backend.id !== currentBackendId);
  const methodMatches = new Set<string>();
  const pathMatches = new Set<string>();

  await Promise.all(
    candidates.map(async (backend) => {
      try {
        const loaded = await loadSpec({ backendId: backend.id });
        if (findEndpoint(loaded.spec, path, method)) {
          methodMatches.add(backend.id);
          return;
        }

        if (loaded.spec.paths?.[path]) {
          pathMatches.add(backend.id);
        }
      } catch {
        // Ignore suggestion probe failures and keep original tool error focused.
      }
    }),
  );

  return {
    methodMatches: Array.from(methodMatches).sort(),
    pathMatches: Array.from(pathMatches).sort(),
  };
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "list_backends",
    {
      description: "List configured backend targets available for OpenAPI/Huma contract tools.",
      inputSchema: {},
    },
    async () => {
      const items = listBackendConfigs().map((backend) => ({
        id: backend.id,
        name: backend.name,
        defaultSpecUrl: backend.defaultSpecUrl,
        description: backend.description,
        domainHints: backend.domainHints || [],
        isDefault: backend.id === getDefaultBackendId(),
      }));

      const output = {
        handshake: "Call list_backends first, then pass backendId in every tool call.",
        defaultBackendId: getDefaultBackendId(),
        total: items.length,
        items,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "load_openapi_spec",
    {
      description:
        "Load or refresh an OpenAPI/Huma contract spec from a URL. Use this first if tools fail because docs path changed.",
      inputSchema: {
        backendId: z.string().min(1).describe("Required backend id from list_backends."),
        url: z.string().url().optional().describe("Optional docs URL override for this call."),
        forceRefresh: z.boolean().optional().describe("Bypass in-memory cache when true."),
      },
    },
    async ({ backendId, url, forceRefresh }) => {
      const loaded = await loadSpec({
        backendId,
        specUrl: url,
        forceRefresh: forceRefresh ?? false,
      });
      const endpoints = listEndpoints(loaded.spec);

      const body = {
        backendId: loaded.backendId,
        title: loaded.spec.info?.title || "Unknown API",
        version: loaded.spec.info?.version || "unknown",
        sourceUrl: loaded.sourceUrl,
        endpointCount: endpoints.length,
        schemaCount: Object.keys(loaded.spec.components?.schemas || {}).length,
        loadedAt: new Date(loaded.loadedAt).toISOString(),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
        structuredContent: body,
      };
    },
  );

  server.registerTool(
    "list_api_endpoints",
    {
      description: "List endpoints from the currently loaded OpenAPI/Huma contract document.",
      inputSchema: {
        backendId: z.string().min(1).describe("Required backend id from list_backends."),
        tag: z.string().optional().describe("Filter by tag name."),
        method: z
          .enum(HTTP_METHODS)
          .optional()
          .describe("Filter by HTTP method (get/post/put/patch/delete/head/options)."),
        pathContains: z.string().optional().describe("Substring filter on path."),
        limit: z.number().int().min(1).max(300).optional().describe("Max rows to return."),
        specUrl: z.string().url().optional().describe("Optional docs URL override for this call."),
      },
    },
    async ({ backendId, tag, method, pathContains, limit, specUrl }) => {
      const loaded = await loadSpec({ backendId, specUrl });
      let endpoints = listEndpoints(loaded.spec);

      if (tag) {
        endpoints = endpoints.filter((e) => (e.tags || []).includes(tag));
      }

      if (method) {
        endpoints = endpoints.filter((e) => e.method === method);
      }

      if (pathContains) {
        const needle = pathContains.toLowerCase();
        endpoints = endpoints.filter((e) => e.path.toLowerCase().includes(needle));
      }

      endpoints.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));

      const output = {
        backendId: loaded.backendId,
        sourceUrl: loaded.sourceUrl,
        total: endpoints.length,
        items: endpoints.slice(0, limit ?? 120),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "get_endpoint_contract",
    {
      description:
        "Return full contract for one endpoint: params, request schema, response schema, and referenced DTO names.",
      inputSchema: {
        backendId: z.string().min(1).describe("Required backend id from list_backends."),
        path: z.string().min(1).describe("Exact endpoint path from the contract spec, e.g. /users/{id}."),
        method: z.enum(HTTP_METHODS).describe("HTTP method."),
        specUrl: z.string().url().optional().describe("Optional docs URL override for this call."),
      },
    },
    async ({ backendId, path, method, specUrl }) => {
      const loaded = await loadSpec({ backendId, specUrl });
      const operation = findEndpoint(loaded.spec, path, method as HttpMethod);

      if (!operation) {
        const byHints = suggestBackendsByHints(path, loaded.backendId);
        const bySpec = await suggestBackendsBySpec(path, method as HttpMethod, loaded.backendId);
        const suggestions = [
          bySpec.methodMatches.length ? `method+path match in: ${bySpec.methodMatches.join(", ")}` : "",
          bySpec.pathMatches.length ? `path exists in: ${bySpec.pathMatches.join(", ")}` : "",
          byHints.length ? `domain hint match: ${byHints.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" | ");

        throw new Error(
          `Endpoint not found for ${method.toUpperCase()} ${path} in backend '${loaded.backendId}'. ` +
            `Call list_backends and retry with the correct backendId.` +
            (suggestions ? ` Suggestions: ${suggestions}` : ""),
        );
      }

      const output = {
        backendId: loaded.backendId,
        sourceUrl: loaded.sourceUrl,
        ...simpleOperationSpec(path, method as HttpMethod, operation, loaded.spec),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "generate_typescript_dto",
    {
      description:
        "Generate TypeScript DTO type declarations from OpenAPI/Huma component schemas. Includes referenced nested DTO types.",
      inputSchema: {
        backendId: z.string().min(1).describe("Required backend id from list_backends."),
        schemaName: z.string().min(1).describe("Component schema name under #/components/schemas."),
        specUrl: z.string().url().optional().describe("Optional docs URL override for this call."),
      },
    },
    async ({ backendId, schemaName, specUrl }) => {
      const loaded = await loadSpec({ backendId, specUrl });
      const schema = loaded.spec.components?.schemas?.[schemaName];

      if (!schema) {
        const available = Object.keys(loaded.spec.components?.schemas || {});
        throw new Error(`Schema '${schemaName}' not found. Available sample: ${available.slice(0, 30).join(", ")}`);
      }

      const chunks: string[] = [];
      const emitted = new Set<string>();
      emitSchemaDeclaration(schemaName, schema, loaded.spec, emitted, chunks);

      const output = {
        backendId: loaded.backendId,
        schemaName,
        sourceUrl: loaded.sourceUrl,
        declarations: chunks.join("\n\n"),
        emittedTypes: Array.from(emitted),
      };

      return {
        content: [{ type: "text", text: output.declarations }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "propose_new_endpoint",
    {
      description:
        "Create a best-effort endpoint + DTO proposal aligned with deterministic patterns found in the current OpenAPI/Huma contract spec.",
      inputSchema: {
        backendId: z.string().min(1).describe("Required backend id from list_backends."),
        resource: z.string().min(1).describe("Business resource name, e.g. pet, order, invoice."),
        action: z.enum(["list", "get", "create", "update", "delete", "custom"]).describe("Endpoint action pattern."),
        customActionName: z.string().optional().describe("Required when action=custom."),
        includePagination: z.boolean().optional().describe("Add page/size params for list action."),
        specUrl: z.string().url().optional().describe("Optional docs URL override for this call."),
      },
    },
    async ({ backendId, resource, action, customActionName, includePagination, specUrl }) => {
      if (action === "custom" && !customActionName) {
        throw new Error("customActionName is required when action is 'custom'.");
      }

      const loaded = await loadSpec({ backendId, specUrl });
      const endpoints = listEndpoints(loaded.spec);
      const plural = resource.endsWith("s") ? resource.toLowerCase() : `${resource.toLowerCase()}s`;
      const singular = resource.toLowerCase();
      const pathBase = `/${plural}`;

      const actionMap: Record<string, { method: HttpMethod; path: string }> = {
        list: { method: "get", path: pathBase },
        get: { method: "get", path: `${pathBase}/{id}` },
        create: { method: "post", path: pathBase },
        update: { method: "patch", path: `${pathBase}/{id}` },
        delete: { method: "delete", path: `${pathBase}/{id}` },
        custom: { method: "post", path: `${pathBase}/${customActionName}` },
      };

      const selected = actionMap[action];
      const existingSimilar = endpoints
        .filter((e) => e.path.includes(`/${singular}`) || e.path.includes(`/${plural}`))
        .slice(0, 12);

      const requestDto =
        action === "create"
          ? `Create${capitalize(singular)}RequestDto`
          : action === "update"
            ? `Update${capitalize(singular)}RequestDto`
            : action === "custom"
              ? `${capitalize(customActionName || "Custom")}${capitalize(singular)}RequestDto`
              : undefined;

      const responseDto =
        action === "list"
          ? `${capitalize(singular)}ListResponseDto`
          : action === "delete"
            ? undefined
            : `${capitalize(singular)}ResponseDto`;

      const sampleRequestType =
        action === "create" || action === "update" || action === "custom"
          ? `export type ${requestDto} = {\n  // Best-effort placeholder; replace with fields from requirements\n  name: string;\n  isActive?: boolean;\n};`
          : undefined;

      const sampleResponseType = responseDto
        ? `export type ${responseDto} = {\n  id: string;\n  name: string;\n  createdAt: string;\n  updatedAt?: string;\n};`
        : undefined;

      const params =
        action === "list" && includePagination
          ? [
              { name: "page", in: "query", type: "number", required: false },
              { name: "size", in: "query", type: "number", required: false },
            ]
          : action === "get" || action === "update" || action === "delete"
            ? [{ name: "id", in: "path", type: "string", required: true }]
            : [];

      const output = {
        backendId: loaded.backendId,
        sourceUrl: loaded.sourceUrl,
        proposal: {
          method: selected.method,
          path: selected.path,
          summary: `${action} ${resource}`,
          tags: [capitalize(resource)],
          params,
          requestDto,
          responseDto,
        },
        sampleDtos: {
          request: sampleRequestType,
          response: sampleResponseType,
        },
        existingSimilar,
        strategyNotes: [
          "Best-effort aid: keep path and method consistent with patterns already present in this spec.",
          "Best-effort aid: use request/response DTO naming separate from persistence model.",
          "Deterministic fact: document validation rules in schema (required, min/max length, enum) when present.",
        ],
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );
}
