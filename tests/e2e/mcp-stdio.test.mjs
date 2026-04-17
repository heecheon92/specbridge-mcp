import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function fixtureSpec() {
  return {
    openapi: "3.1.0",
    info: { title: "SpecBridge Fixture API", version: "1.0.0" },
    paths: {
      "/pets/{petId}": {
        get: {
          operationId: "getPet",
          tags: ["Pets"],
          parameters: [
            {
              name: "petId",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
          ],
          responses: {
            200: {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Pet" },
                },
              },
            },
          },
        },
      },
      "/pets": {
        post: {
          operationId: "createPet",
          tags: ["Pets"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
          },
          responses: {
            201: { description: "created" },
          },
        },
      },
      "/orders": {
        get: {
          operationId: "listOrders",
          tags: ["Orders"],
          responses: {
            200: { description: "ok" },
          },
        },
      },
    },
    components: {
      schemas: {
        Pet: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            name: { type: "string", nullable: true },
          },
        },
      },
    },
  };
}

function specDataUrl(spec) {
  return `data:application/json,${encodeURIComponent(JSON.stringify(spec))}`;
}

async function withClient(fn) {
  const env = {
    ...process.env,
    DEFAULT_BACKEND_ID: "fixture-api",
    OPENAPI_BACKENDS: JSON.stringify([
      {
        id: "fixture-api",
        name: "Fixture API",
        specUrl: specDataUrl(fixtureSpec()),
      },
    ]),
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["build/index.js", "--transport", "stdio"],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "specbridge-smoke-test", version: "1.0.0" });

  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("stdio MCP server exposes representative SpecBridge tools", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("list_backends"));
    assert.ok(toolNames.includes("get_endpoint_contract"));

    const backends = await client.callTool({ name: "list_backends", arguments: {} });
    assert.equal(backends.structuredContent.defaultBackendId, "fixture-api");
    assert.equal(backends.structuredContent.items[0].id, "fixture-api");

    const loaded = await client.callTool({
      name: "load_openapi_spec",
      arguments: { backendId: "fixture-api", forceRefresh: true },
    });
    assert.equal(loaded.structuredContent.title, "SpecBridge Fixture API");

    const endpoints = await client.callTool({ name: "list_api_endpoints", arguments: { backendId: "fixture-api" } });
    assert.equal(endpoints.structuredContent.total, 3);
    assert.equal(endpoints.structuredContent.items[0].path, "/orders");

    const filteredEndpoints = await client.callTool({
      name: "list_api_endpoints",
      arguments: { backendId: "fixture-api", method: "post", tag: "Pets", pathContains: "pets", limit: 1 },
    });
    assert.equal(filteredEndpoints.structuredContent.total, 1);
    assert.equal(filteredEndpoints.structuredContent.items[0].method, "post");
    assert.equal(filteredEndpoints.structuredContent.items[0].path, "/pets");

    const contract = await client.callTool({
      name: "get_endpoint_contract",
      arguments: { backendId: "fixture-api", path: "/pets/{petId}", method: "get" },
    });
    assert.deepEqual(contract.structuredContent.referencedSchemas, ["Pet"]);
    assert.match(contract.structuredContent.typescriptDtoDeclarations.declarations, /export type Pet =/);

    const dto = await client.callTool({
      name: "generate_typescript_dto",
      arguments: { backendId: "fixture-api", schemaName: "Pet" },
    });
    assert.match(dto.structuredContent.declarations, /export type Pet =/);

    const proposal = await client.callTool({
      name: "propose_new_endpoint",
      arguments: { backendId: "fixture-api", resource: "pet", action: "list", includePagination: true },
    });
    assert.equal(proposal.structuredContent.proposal.method, "get");
    assert.ok(proposal.structuredContent.existingSimilar.length >= 1);
    assert.match(proposal.structuredContent.strategyNotes.join(" "), /Best-effort aid/);
  });
});
