import { parse as parseYaml } from "yaml";
import { CACHE_TTL_MS, createEphemeralBackend, REQUEST_TIMEOUT_MS, resolveBackend } from "./config.js";
import {
  type EndpointSummary,
  HTTP_METHODS,
  type HttpMethod,
  type OpenApiDocument,
  type OperationObject,
  type ParameterObject,
  type RequestBodyObject,
  type ResponseObject,
  type SchemaObject,
  type SpecCache,
} from "./types.js";

const specCacheBySource = new Map<string, SpecCache>();

function normalizeBaseUrl(inputUrl: string): string {
  const trimmed = inputUrl.trim();
  return trimmed.endsWith("#") ? trimmed.slice(0, -1) : trimmed;
}

function candidateSpecUrls(inputUrl: string): string[] {
  const raw = normalizeBaseUrl(inputUrl);

  const direct = [raw];
  const knownCandidates = [
    "/swagger.json",
    "/openapi.json",
    "/openapi.yaml",
    "/openapi-3.0.json",
    "/openapi-3.0.yaml",
    "/v3/api-docs",
    "/swagger/v1/swagger.json",
    "/api-docs",
    "/docs/json",
  ];

  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/$/, "");
    const prefixes = path ? [path, ""] : [""];

    const generated = prefixes.flatMap((prefix) =>
      knownCandidates.map((suffix) => {
        const clone = new URL(u.toString());
        clone.pathname = `${prefix}${suffix}`.replace(/\/\/{2,}/g, "/");
        clone.hash = "";
        return clone.toString();
      }),
    );

    return Array.from(new Set([...direct, ...generated]));
  } catch {
    return Array.from(new Set([...direct]));
  }
}

function candidateSwaggerUiInitUrls(inputUrl: string): string[] {
  const raw = normalizeBaseUrl(inputUrl);
  const direct: string[] = raw.endsWith(".js") ? [raw] : [];
  const knownCandidates = ["/swagger-ui-init.js", "/api/swagger-ui-init.js", "/swagger/swagger-ui-init.js"];

  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/$/, "");
    const prefixes = path ? [path, ""] : [""];

    const generated = prefixes.flatMap((prefix) =>
      knownCandidates.map((suffix) => {
        const clone = new URL(u.toString());
        clone.pathname = `${prefix}${suffix}`.replace(/\/\/{2,}/g, "/");
        clone.hash = "";
        return clone.toString();
      }),
    );

    return Array.from(new Set([...direct, ...generated]));
  } catch {
    return direct;
  }
}

function isOpenApiLike(value: unknown): value is OpenApiDocument {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as OpenApiDocument;
  return !!((maybe.openapi || maybe.swagger) && maybe.paths && typeof maybe.paths === "object");
}

function isYamlLike(url: string, contentType: string): boolean {
  return /\.ya?ml(?:[?#].*)?$/i.test(url) || /yaml|yml/i.test(contentType);
}

async function fetchStructuredDocument(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json, */*",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();

    if (isYamlLike(url, contentType)) {
      try {
        return parseYaml(text) as unknown;
      } catch {
        throw new Error("Response is not valid YAML");
      }
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      try {
        return parseYaml(text) as unknown;
      } catch {
        throw new Error("Response is not valid JSON or YAML");
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/javascript, text/javascript, application/json, text/plain, */*",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractBalancedObjectLiteral(source: string, braceStart: number): string | undefined {
  if (braceStart < 0 || source[braceStart] !== "{") {
    return undefined;
  }

  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escapeNext = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = braceStart; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (c === "\\") {
        escapeNext = true;
        continue;
      }
      if (c === quote) {
        quote = null;
      }
      continue;
    }

    if (c === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (c === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }

    if (c === "{") {
      depth += 1;
      continue;
    }

    if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(braceStart, i + 1);
      }
    }
  }

  return undefined;
}

function parseStrictJsonObject(source: string | undefined): unknown {
  if (!source) {
    return undefined;
  }

  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
}

function extractOpenApiFromScript(script: string): OpenApiDocument | undefined {
  // Never evaluate fetched JavaScript. This best-effort path only accepts strict JSON
  // object literals embedded in a script, and exists for rare static Swagger UI bundles.
  for (const token of ['"openapi"', '"swagger"']) {
    let from = 0;
    while (from < script.length) {
      const tokenIndex = script.indexOf(token, from);
      if (tokenIndex < 0) {
        break;
      }

      const braceStart = script.lastIndexOf("{", tokenIndex);
      const parsed = parseStrictJsonObject(extractBalancedObjectLiteral(script, braceStart));
      if (isOpenApiLike(parsed)) {
        return parsed;
      }

      from = tokenIndex + token.length;
    }
  }

  return undefined;
}

export async function loadSpec(options?: {
  backendId?: string;
  specUrl?: string;
  forceRefresh?: boolean;
}): Promise<SpecCache> {
  const now = Date.now();
  const forceRefresh = options?.forceRefresh ?? false;
  const overrideSpecUrl = options?.specUrl?.trim();
  let backend: ReturnType<typeof resolveBackend>;

  try {
    backend = resolveBackend(options?.backendId);
  } catch (error) {
    if (!overrideSpecUrl) {
      throw error;
    }
    backend = createEphemeralBackend(options?.backendId, overrideSpecUrl);
  }

  const sources = overrideSpecUrl
    ? [overrideSpecUrl]
    : [backend.defaultSpecUrl, ...(backend.fallbackSpecUrls || [])].filter(Boolean);
  const errors: string[] = [];

  const tryLoadFromSource = async (source: string): Promise<SpecCache | undefined> => {
    const cacheKey = `${backend.id}::${normalizeBaseUrl(source)}`;

    const current = specCacheBySource.get(cacheKey);
    if (!forceRefresh && current && now - current.loadedAt < CACHE_TTL_MS) {
      return current;
    }

    const jsonCandidates = candidateSpecUrls(source);
    const jsCandidates =
      process.env.OPENAPI_ENABLE_SWAGGER_UI_SCRIPT_EXTRACTION === "true" ? candidateSwaggerUiInitUrls(source) : [];

    for (const url of jsonCandidates) {
      try {
        const json = await fetchStructuredDocument(url);
        if (isOpenApiLike(json)) {
          const loaded: SpecCache = {
            loadedAt: now,
            backendId: backend.id,
            sourceUrl: url,
            spec: json,
          };
          specCacheBySource.set(cacheKey, loaded);
          return loaded;
        }
        errors.push(`${url}: payload is not OpenAPI`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${url}: ${message}`);
      }
    }

    for (const url of jsCandidates) {
      try {
        const script = await fetchText(url);
        const spec = extractOpenApiFromScript(script);
        if (spec) {
          const loaded: SpecCache = {
            loadedAt: now,
            backendId: backend.id,
            sourceUrl: url,
            spec,
          };
          specCacheBySource.set(cacheKey, loaded);
          return loaded;
        }
        errors.push(`${url}: could not extract OpenAPI spec from script`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${url}: ${message}`);
      }
    }

    return undefined;
  };

  for (const source of sources) {
    const loaded = await tryLoadFromSource(source);
    if (loaded) {
      return loaded;
    }
  }

  throw new Error(`Failed to load OpenAPI spec. Tried: ${errors.join(" | ")}`);
}

function derefParameter(spec: OpenApiDocument, param: ParameterObject): ParameterObject {
  if (!param.$ref) {
    return param;
  }

  const ref = param.$ref;
  if (!ref.startsWith("#/components/parameters/")) {
    return param;
  }

  const name = ref.slice("#/components/parameters/".length);
  const componentParam = (spec as Record<string, unknown>)?.components as
    | { parameters?: Record<string, ParameterObject> }
    | undefined;

  return componentParam?.parameters?.[name] || param;
}

function derefRequestBody(spec: OpenApiDocument, body?: RequestBodyObject): RequestBodyObject | undefined {
  if (!body?.$ref) {
    return body;
  }

  const ref = body.$ref;
  if (!ref.startsWith("#/components/requestBodies/")) {
    return body;
  }

  const name = ref.slice("#/components/requestBodies/".length);
  const componentBodies = (spec as Record<string, unknown>)?.components as
    | { requestBodies?: Record<string, RequestBodyObject> }
    | undefined;

  return componentBodies?.requestBodies?.[name] || body;
}

function derefResponse(spec: OpenApiDocument, response?: ResponseObject): ResponseObject | undefined {
  if (!response?.$ref) {
    return response;
  }

  const ref = response.$ref;
  if (!ref.startsWith("#/components/responses/")) {
    return response;
  }

  const name = ref.slice("#/components/responses/".length);
  const componentResponses = (spec as Record<string, unknown>)?.components as
    | { responses?: Record<string, ResponseObject> }
    | undefined;

  return componentResponses?.responses?.[name] || response;
}

export function listEndpoints(spec: OpenApiDocument): EndpointSummary[] {
  const paths = spec.paths || {};
  const endpoints: EndpointSummary[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem?.[method];
      if (!operation) {
        continue;
      }

      endpoints.push({
        method,
        path,
        operationId: operation.operationId,
        summary: operation.summary,
        tags: operation.tags,
      });
    }
  }

  return endpoints;
}

function collectSchemaRefs(schema?: SchemaObject, refs = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== "object") {
    return refs;
  }

  if (schema.$ref?.startsWith("#/components/schemas/")) {
    refs.add(schema.$ref.slice("#/components/schemas/".length));
  }

  if (schema.properties) {
    for (const value of Object.values(schema.properties)) {
      collectSchemaRefs(value, refs);
    }
  }

  if (schema.items) {
    collectSchemaRefs(schema.items, refs);
  }

  if (schema.oneOf) {
    schema.oneOf.forEach((s) => {
      collectSchemaRefs(s, refs);
    });
  }

  if (schema.anyOf) {
    schema.anyOf.forEach((s) => {
      collectSchemaRefs(s, refs);
    });
  }

  if (schema.allOf) {
    schema.allOf.forEach((s) => {
      collectSchemaRefs(s, refs);
    });
  }

  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object" &&
    !Array.isArray(schema.additionalProperties)
  ) {
    collectSchemaRefs(schema.additionalProperties as SchemaObject, refs);
  }

  return refs;
}

function appendNull(typeString: string): string {
  return typeString.includes("null") ? typeString : `${typeString} | null`;
}

function schemaToTypeString(schema: SchemaObject | undefined, spec: OpenApiDocument, seenRefs: Set<string>): string {
  if (!schema) {
    return "unknown";
  }

  const typeString = schemaToTypeStringInner(schema, spec, seenRefs);
  return schema.nullable ? appendNull(typeString) : typeString;
}

function schemaToTypeStringInner(schema: SchemaObject, spec: OpenApiDocument, seenRefs: Set<string>): string {
  if (Array.isArray(schema.type)) {
    const variants = schema.type.map((item) =>
      schemaToTypeStringInner({ ...schema, type: item, nullable: false }, spec, seenRefs),
    );
    return [...new Set(variants)].join(" | ");
  }

  if (schema.$ref) {
    const refName = schema.$ref.split("/").pop();
    if (!refName) {
      return "unknown";
    }

    if (seenRefs.has(refName)) {
      return refName;
    }

    const target = spec.components?.schemas?.[refName];
    if (!target) {
      return refName;
    }

    return refName;
  }

  if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((value) => (typeof value === "string" ? JSON.stringify(value) : String(value))).join(" | ");
  }

  if (schema.oneOf?.length) {
    return schema.oneOf.map((item) => schemaToTypeString(item, spec, seenRefs)).join(" | ");
  }

  if (schema.anyOf?.length) {
    return schema.anyOf.map((item) => schemaToTypeString(item, spec, seenRefs)).join(" | ");
  }

  if (schema.allOf?.length) {
    return schema.allOf.map((item) => schemaToTypeString(item, spec, seenRefs)).join(" & ");
  }

  if (schema.type === "array") {
    const itemType = schemaToTypeString(schema.items, spec, seenRefs);
    return `Array<${itemType}>`;
  }

  if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    const required = new Set(schema.required || []);
    const properties = Object.entries(schema.properties || {});

    if (properties.length === 0) {
      if (schema.additionalProperties === true) {
        return "Record<string, unknown>";
      }

      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        const valueType = schemaToTypeString(schema.additionalProperties, spec, seenRefs);
        return `Record<string, ${valueType}>`;
      }

      return "Record<string, unknown>";
    }

    const lines = properties.map(([key, value]) => {
      const optional = required.has(key) ? "" : "?";
      const valueType = schemaToTypeString(value, spec, seenRefs);
      return `${JSON.stringify(key)}${optional}: ${valueType};`;
    });

    return `{ ${lines.join(" ")} }`;
  }

  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return "unknown";
  }
}

export function emitSchemaDeclaration(
  name: string,
  schema: SchemaObject,
  spec: OpenApiDocument,
  emitted: Set<string>,
  chunks: string[],
): void {
  if (emitted.has(name)) {
    return;
  }

  emitted.add(name);
  const localSeen = new Set<string>();
  const body = schemaToTypeString(schema, spec, localSeen);

  chunks.push(`export type ${name} = ${body};`);

  const refs = collectSchemaRefs(schema);
  for (const refName of refs) {
    if (emitted.has(refName)) {
      continue;
    }

    const refSchema = spec.components?.schemas?.[refName];
    if (refSchema) {
      emitSchemaDeclaration(refName, refSchema, spec, emitted, chunks);
    }
  }
}

function extractRefName(schema?: SchemaObject): string | undefined {
  const ref = schema?.$ref;
  if (!ref?.startsWith("#/components/schemas/")) {
    return undefined;
  }

  return ref.slice("#/components/schemas/".length);
}

function getContentSchema(
  mediaMap?: Record<string, { schema?: SchemaObject }>,
  preferred = "application/json",
): SchemaObject | undefined {
  if (!mediaMap) {
    return undefined;
  }

  if (mediaMap[preferred]?.schema) {
    return mediaMap[preferred].schema;
  }

  const first = Object.values(mediaMap).find((v) => v?.schema);
  return first?.schema;
}

const VALIDATION_CONSTRAINT_KEYS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
] as const;

function schemaValidationFacts(schema?: SchemaObject, depth = 0): Record<string, unknown> | undefined {
  if (!schema) {
    return undefined;
  }

  const facts: Record<string, unknown> = {};

  if (schema.$ref) {
    facts.ref = schema.$ref;
  }
  if (schema.type !== undefined) {
    facts.type = schema.type;
  }
  if (schema.format) {
    facts.format = schema.format;
  }
  if (schema.nullable !== undefined) {
    facts.nullable = schema.nullable;
  }
  if (schema.enum) {
    facts.enum = schema.enum;
  }
  if (schema.default !== undefined) {
    facts.default = schema.default;
  }
  if (schema.required?.length) {
    facts.required = schema.required;
  }

  const constraints: Record<string, unknown> = {};
  for (const key of VALIDATION_CONSTRAINT_KEYS) {
    if (schema[key] !== undefined) {
      constraints[key] = schema[key];
    }
  }
  if (Object.keys(constraints).length > 0) {
    facts.constraints = constraints;
  }

  if (schema.oneOf?.length) {
    facts.oneOf = schema.oneOf.length;
  }
  if (schema.anyOf?.length) {
    facts.anyOf = schema.anyOf.length;
  }
  if (schema.allOf?.length) {
    facts.allOf = schema.allOf.length;
  }

  if (schema.additionalProperties !== undefined) {
    facts.additionalProperties =
      typeof schema.additionalProperties === "object"
        ? schemaValidationFacts(schema.additionalProperties, depth + 1)
        : schema.additionalProperties;
  }

  if (depth < 2 && schema.items) {
    facts.items = schemaValidationFacts(schema.items, depth + 1);
  }

  if (depth < 2 && schema.properties) {
    facts.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, schemaValidationFacts(value, depth + 1)]),
    );
  }

  return facts;
}

function collectRefsFromSchemas(spec: OpenApiDocument, schemas: Array<SchemaObject | undefined>): string[] {
  const refs = new Set<string>();
  for (const schema of schemas) {
    collectSchemaRefs(schema, refs);
  }

  const queue = Array.from(refs);
  for (const refName of queue) {
    const before = refs.size;
    collectSchemaRefs(spec.components?.schemas?.[refName], refs);
    if (refs.size > before) {
      for (const nextRef of refs) {
        if (!queue.includes(nextRef)) {
          queue.push(nextRef);
        }
      }
    }
  }

  return Array.from(refs).sort();
}

function schemaMapForRefs(spec: OpenApiDocument, refs: string[]): Record<string, SchemaObject> {
  return Object.fromEntries(
    refs
      .map((refName) => [refName, spec.components?.schemas?.[refName]] as const)
      .filter((entry): entry is readonly [string, SchemaObject] => !!entry[1]),
  );
}

function emitDeclarationsForRefs(spec: OpenApiDocument, refs: string[]) {
  const chunks: string[] = [];
  const emitted = new Set<string>();

  for (const refName of refs) {
    const schema = spec.components?.schemas?.[refName];
    if (schema) {
      emitSchemaDeclaration(refName, schema, spec, emitted, chunks);
    }
  }

  return {
    declarations: chunks.join("\n\n"),
    emittedTypes: Array.from(emitted),
  };
}

export function findEndpoint(spec: OpenApiDocument, path: string, method: HttpMethod): OperationObject | undefined {
  return spec.paths?.[path]?.[method];
}

export function simpleOperationSpec(
  path: string,
  method: HttpMethod,
  operation: OperationObject,
  spec: OpenApiDocument,
) {
  const requestBody = derefRequestBody(spec, operation.requestBody);
  const requestSchema = getContentSchema(requestBody?.content);

  const responseEntries = Object.entries(operation.responses || {}).map(([statusCode, response]) => {
    const responseObject = derefResponse(spec, response);
    const responseSchema = getContentSchema(responseObject?.content);

    return {
      statusCode,
      description: responseObject?.description,
      schema: responseSchema,
      schemaRef: extractRefName(responseSchema),
      validationFacts: schemaValidationFacts(responseSchema),
    };
  });

  const primaryResponse = responseEntries.find((response) => response.statusCode.startsWith("2")) || responseEntries[0];
  const parameters = (operation.parameters || []).map((param) => derefParameter(spec, param));
  const referencedSchemas = collectRefsFromSchemas(spec, [
    ...parameters.map((param) => param.schema),
    requestSchema,
    ...responseEntries.map((response) => response.schema),
  ]);
  const schemas = schemaMapForRefs(spec, referencedSchemas);
  const typescriptDtoDeclarations = emitDeclarationsForRefs(spec, referencedSchemas);
  const operationSummary = {
    method,
    path,
    summary: operation.summary,
    description: operation.description,
    operationId: operation.operationId,
    tags: operation.tags || [],
  };
  const parameterContracts = parameters.map((parameter) => ({
    name: parameter.name,
    in: parameter.in,
    required: parameter.required ?? false,
    description: parameter.description,
    schema: parameter.schema,
    schemaRef: extractRefName(parameter.schema),
    validationFacts: schemaValidationFacts(parameter.schema),
  }));
  const requestBodyContract = requestBody
    ? {
        required: requestBody.required ?? false,
        description: requestBody.description,
        schema: requestSchema,
        schemaRef: extractRefName(requestSchema),
        validationFacts: schemaValidationFacts(requestSchema),
      }
    : null;

  return {
    ...operationSummary,
    operation: operationSummary,
    parameters: parameterContracts,
    requestBody: requestBodyContract,
    response: primaryResponse
      ? {
          statusCode: primaryResponse.statusCode,
          description: primaryResponse.description,
          schema: primaryResponse.schema,
          schemaRef: primaryResponse.schemaRef,
          validationFacts: primaryResponse.validationFacts,
        }
      : null,
    responses: responseEntries,
    referencedSchemas,
    schemas,
    typescriptDtoDeclarations,
    validationFacts: {
      parameters: parameterContracts.map((parameter) => ({
        name: parameter.name,
        in: parameter.in,
        facts: parameter.validationFacts,
      })),
      requestBody: requestBodyContract?.validationFacts,
      responses: responseEntries.map((response) => ({
        statusCode: response.statusCode,
        facts: response.validationFacts,
      })),
      schemas: Object.fromEntries(
        Object.entries(schemas).map(([schemaName, schema]) => [schemaName, schemaValidationFacts(schema)]),
      ),
    },
    bestEffortHints: {
      note: "SpecBridge MCP prioritizes deterministic OpenAPI facts; downstream agents may derive naming or grouping hints from these fields.",
    },
  };
}
