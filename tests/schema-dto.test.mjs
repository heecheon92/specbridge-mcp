import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listBackendConfigs, resolveBackend } from "../build/openapi/config.js";
import { emitSchemaDeclaration, loadSpec, simpleOperationSpec } from "../build/openapi/spec.js";

const ENV_KEYS = [
  "DEFAULT_BACKEND_ID",
  "OPENAPI_BACKENDS",
  "OPENAPI_BACKENDS_FILE",
  "OPENAPI_ENABLE_SWAGGER_UI_SCRIPT_EXTRACTION",
];

function specDataUrl(spec) {
  return `data:application/json,${encodeURIComponent(JSON.stringify(spec))}`;
}

function withEnv(overrides, fn) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

function contractFixture() {
  return {
    openapi: "3.1.0",
    info: { title: "Fixture API", version: "1.0.0" },
    paths: {
      "/pets/{petId}": {
        get: {
          operationId: "getPet",
          summary: "Get a pet",
          tags: ["Pets"],
          parameters: [
            {
              name: "petId",
              in: "path",
              required: true,
              schema: { type: "string", minLength: 1, pattern: "^[a-z0-9-]+$" },
            },
            {
              name: "includeOwner",
              in: "query",
              required: false,
              schema: { type: "boolean", default: false },
            },
          ],
          responses: {
            200: {
              description: "Pet found",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Pet" },
                },
              },
            },
            404: { description: "Pet missing" },
          },
        },
      },
      "/pets": {
        post: {
          operationId: "createPet",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreatePetRequest" },
              },
            },
          },
          responses: {
            201: {
              description: "Created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Pet" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Pet: {
          type: "object",
          required: ["id", "status"],
          properties: {
            id: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["available", "adopted"] },
            tags: { type: "array", items: { type: "string", nullable: true }, minItems: 0 },
            owner: { $ref: "#/components/schemas/Owner", nullable: true },
          },
        },
        Owner: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
          },
        },
        CreatePetRequest: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            metadata: { type: "object", additionalProperties: { type: "string" } },
          },
        },
      },
    },
  };
}

test("emitSchemaDeclaration preserves optional, nullable, enum, arrays, maps, and referenced fields", () => {
  const spec = contractFixture();
  const chunks = [];

  emitSchemaDeclaration("Pet", spec.components.schemas.Pet, spec, new Set(), chunks);

  const declarations = chunks.join("\n\n");
  assert.match(declarations, /export type Pet =/);
  assert.match(declarations, /"status": "available" \| "adopted";/);
  assert.match(declarations, /"tags"\?: Array<string \| null>;/);
  assert.match(declarations, /"owner"\?: Owner \| null;/);
  assert.match(declarations, /export type Owner =/);
});

test("backend registry defaults to the public demo and supports env injection", async () => {
  await withEnv(
    {
      OPENAPI_BACKENDS: JSON.stringify([
        {
          id: "custom-contracts",
          name: "Custom Contracts",
          specUrl: specDataUrl(contractFixture()),
        },
      ]),
      DEFAULT_BACKEND_ID: "custom-contracts",
    },
    () => {
      const backends = listBackendConfigs();
      assert.ok(backends.some((backend) => backend.id === "swagger-petstore"));
      assert.ok(backends.some((backend) => backend.id === "custom-contracts"));
      assert.equal(resolveBackend().id, "custom-contracts");
      assert.equal(resolveBackend("custom-contracts").name, "Custom Contracts");
    },
  );
});

test("loadSpec accepts an explicit specUrl even with an ephemeral backend id", async () => {
  const spec = contractFixture();
  const loaded = await loadSpec({
    backendId: "ephemeral-contracts",
    specUrl: specDataUrl(spec),
    forceRefresh: true,
  });

  assert.equal(loaded.backendId, "ephemeral-contracts");
  assert.equal(loaded.spec.info?.title, "Fixture API");
  assert.ok(loaded.spec.paths?.["/pets/{petId}"]?.get);
});

test("loadSpec accepts a Huma-compatible YAML document with Unicode descriptions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "http://huma.test/openapi.yaml");
    return new Response(
      [
        "openapi: 3.1.0",
        "info:",
        "  title: Huma API",
        "  version: 1.0.0",
        "paths:",
        "  /users:",
        "    get:",
        "      summary: 사용자 목록",
        "      description: 한글 설명",
        "      responses:",
        "        '200':",
        "          description: 성공",
      ].join("\n"),
      { status: 200, headers: { "content-type": "application/yaml" } },
    );
  };

  try {
    const loaded = await loadSpec({
      backendId: "huma-fixture",
      specUrl: "http://huma.test/openapi.yaml",
      forceRefresh: true,
    });
    assert.equal(loaded.sourceUrl, "http://huma.test/openapi.yaml");
    assert.equal(loaded.spec.paths?.["/users"]?.get?.description, "한글 설명");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Swagger UI script probing never executes fetched JavaScript", async () => {
  const originalFetch = globalThis.fetch;
  const marker = "__SPECBRIDGE_MALICIOUS_SCRIPT_EXECUTED__";
  delete globalThis[marker];
  process.env.OPENAPI_ENABLE_SWAGGER_UI_SCRIPT_EXTRACTION = "true";

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("swagger-ui-init.js")) {
      return new Response(
        `${globalThis.constructor.name}.${marker} = true; const spec = {"openapi":"3.1.0","info":{"title":"Script Fixture","version":"1"},"paths":{"/safe":{"get":{"responses":{"200":{"description":"ok"}}}}}};`,
        { status: 200, headers: { "content-type": "application/javascript" } },
      );
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const loaded = await loadSpec({
      backendId: "script-fixture",
      specUrl: "http://docs.test/docs",
      forceRefresh: true,
    });
    assert.equal(loaded.spec.info?.title, "Script Fixture");
    assert.equal(globalThis[marker], undefined);
  } finally {
    delete process.env.OPENAPI_ENABLE_SWAGGER_UI_SCRIPT_EXTRACTION;
    delete globalThis[marker];
    globalThis.fetch = originalFetch;
  }
});

test("simpleOperationSpec returns deterministic contract bundle with DTO declarations and validation facts", () => {
  const spec = contractFixture();
  const operation = spec.paths["/pets/{petId}"].get;
  const contract = simpleOperationSpec("/pets/{petId}", "get", operation, spec);

  assert.equal(contract.operation.operationId, "getPet");
  assert.deepEqual(contract.referencedSchemas, ["Owner", "Pet"]);
  assert.match(contract.typescriptDtoDeclarations.declarations, /export type Pet =/);
  assert.match(contract.typescriptDtoDeclarations.declarations, /export type Owner =/);
  assert.equal(contract.parameters[0].validationFacts.constraints.minLength, 1);
  assert.deepEqual(contract.validationFacts.schemas.Pet.required, ["id", "status"]);
  assert.deepEqual(contract.validationFacts.schemas.Pet.properties.status.enum, ["available", "adopted"]);
  assert.equal(contract.responses[0].statusCode, "200");
  assert.match(contract.bestEffortHints.note, /deterministic OpenAPI facts/);
});

test("backend registry supports repo-local config, config files, env precedence, and unknown backend errors", async () => {
  assert.equal(
    resolveBackend("swagger-petstore").description,
    "Repository-local public demo backend for SpecBridge MCP.",
  );

  const dir = await mkdtemp(join(tmpdir(), "specbridge-config-"));
  const filePath = join(dir, "backends.json");
  const fileUrl = specDataUrl({ openapi: "3.1.0", info: { title: "File", version: "1" }, paths: {} });
  const envUrl = specDataUrl({ openapi: "3.1.0", info: { title: "Env", version: "1" }, paths: {} });

  await writeFile(
    filePath,
    JSON.stringify([
      {
        id: "shared-contracts",
        name: "File Contracts",
        specUrl: fileUrl,
      },
      {
        id: "file-only",
        name: "File Only",
        specUrl: fileUrl,
      },
    ]),
  );

  try {
    await withEnv(
      {
        OPENAPI_BACKENDS_FILE: filePath,
        OPENAPI_BACKENDS: JSON.stringify([
          {
            id: "shared-contracts",
            name: "Env Contracts",
            specUrl: envUrl,
          },
        ]),
      },
      () => {
        assert.equal(resolveBackend("file-only").name, "File Only");
        assert.equal(resolveBackend("shared-contracts").name, "Env Contracts");
        assert.throws(
          () => resolveBackend("missing-contracts"),
          /Unknown backend 'missing-contracts'.*file-only.*shared-contracts/s,
        );
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSpec tries fallback candidates, reports invalid payloads, and honors cache refresh", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let cacheVersion = 0;

  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);

    if (url === "http://fallback.test/docs/openapi.json") {
      return new Response(
        JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Fallback API", version: "1" },
          paths: { "/fallback": { get: { responses: { 200: { description: "ok" } } } } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url === "http://cache.test/openapi.json") {
      cacheVersion += 1;
      return new Response(
        JSON.stringify({
          openapi: "3.1.0",
          info: { title: `Cache API v${cacheVersion}`, version: "1" },
          paths: { "/cache": { get: { responses: { 200: { description: "ok" } } } } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.startsWith("http://invalid.test")) {
      return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
    }

    return new Response("not found", { status: 404 });
  };

  try {
    const fallback = await loadSpec({
      backendId: "fallback",
      specUrl: "http://fallback.test/docs",
      forceRefresh: true,
    });
    assert.equal(fallback.sourceUrl, "http://fallback.test/docs/openapi.json");
    assert.ok(calls.includes("http://fallback.test/docs"));

    await assert.rejects(
      () => loadSpec({ backendId: "invalid", specUrl: "http://invalid.test/openapi.json", forceRefresh: true }),
      /Failed to load OpenAPI spec.*(Response is not valid JSON or YAML|payload is not OpenAPI)/s,
    );

    const first = await loadSpec({ backendId: "cache", specUrl: "http://cache.test/openapi.json", forceRefresh: true });
    const second = await loadSpec({ backendId: "cache", specUrl: "http://cache.test/openapi.json" });
    const third = await loadSpec({ backendId: "cache", specUrl: "http://cache.test/openapi.json", forceRefresh: true });
    assert.equal(first.spec.info?.title, "Cache API v1");
    assert.equal(second.spec.info?.title, "Cache API v1");
    assert.equal(third.spec.info?.title, "Cache API v2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("emitSchemaDeclaration covers composition, missing refs, and recursive refs", () => {
  const spec = {
    components: {
      schemas: {
        Named: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        Timestamped: { type: "object", properties: { createdAt: { type: "string", format: "date-time" } } },
        Composed: { allOf: [{ $ref: "#/components/schemas/Named" }, { $ref: "#/components/schemas/Timestamped" }] },
        Flexible: { oneOf: [{ type: "string" }, { type: "number" }] },
        SearchValue: { anyOf: [{ type: "string" }, { type: "boolean" }] },
        MissingRefHolder: { type: "object", properties: { ghost: { $ref: "#/components/schemas/Ghost" } } },
        TreeNode: { type: "object", properties: { child: { $ref: "#/components/schemas/TreeNode" } } },
      },
    },
  };

  const chunks = [];
  const emitted = new Set();
  for (const name of ["Composed", "Flexible", "SearchValue", "MissingRefHolder", "TreeNode"]) {
    emitSchemaDeclaration(name, spec.components.schemas[name], spec, emitted, chunks);
  }
  const declarations = chunks.join("\n\n");

  assert.match(declarations, /export type Composed = Named & Timestamped;/);
  assert.match(declarations, /export type Flexible = string \| number;/);
  assert.match(declarations, /export type SearchValue = string \| boolean;/);
  assert.match(declarations, /"ghost"\?: Ghost;/);
  assert.match(declarations, /"child"\?: TreeNode;/);
});
