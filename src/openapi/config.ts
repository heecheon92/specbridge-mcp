import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { BackendConfig } from "./types.js";

export const REQUEST_TIMEOUT_MS = Number(process.env.OPENAPI_FETCH_TIMEOUT_MS || 12_000);
export const CACHE_TTL_MS = Number(process.env.OPENAPI_CACHE_TTL_MS || 5 * 60 * 1000);

const DEMO_BACKEND_ID = "swagger-petstore";
const REPO_BACKENDS_FILE = "openapi.backends.json";

export const DEFAULT_BACKEND_ID = process.env.DEFAULT_BACKEND_ID?.trim() || DEMO_BACKEND_ID;

const builtInBackends: BackendConfig[] = [
  {
    id: DEMO_BACKEND_ID,
    name: "Swagger Petstore Demo API",
    defaultSpecUrl: "https://petstore3.swagger.io/api/v3/openapi.json",
    description: "Public zero-config demo backend for SpecBridge MCP.",
    domainHints: ["/pet", "/store", "/user"],
  },
];

function normalizeBackendId(value: string): string {
  return value.trim().toLowerCase();
}

function parseBackendConfig(raw: string | undefined, sourceName = "OPENAPI_BACKENDS"): BackendConfig[] {
  if (!raw?.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${sourceName} must be valid JSON. ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${sourceName} must be a JSON array.`);
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`${sourceName}[${index}] must be an object.`);
    }

    const objectEntry = entry as Record<string, unknown>;
    const id = normalizeBackendId(String(objectEntry.id || ""));
    const specUrl = String(objectEntry.specUrl || objectEntry.defaultSpecUrl || "").trim();
    const name = String(objectEntry.name || id).trim();
    const description = objectEntry.description ? String(objectEntry.description) : undefined;
    const domainHints = Array.isArray(objectEntry.domainHints)
      ? objectEntry.domainHints.map((value) => String(value).trim()).filter(Boolean)
      : undefined;
    const fallbackSpecUrls = Array.isArray(objectEntry.fallbackSpecUrls)
      ? objectEntry.fallbackSpecUrls.map((value) => String(value).trim()).filter(Boolean)
      : undefined;

    if (!id) {
      throw new Error(`${sourceName}[${index}].id is required.`);
    }
    if (!specUrl) {
      throw new Error(`${sourceName}[${index}].specUrl is required.`);
    }

    return {
      id,
      name: name || id,
      defaultSpecUrl: specUrl,
      fallbackSpecUrls,
      description,
      domainHints,
    };
  });
}

function loadBackendsJsonFromFile(filePath: string): string {
  const absolutePath = resolve(process.cwd(), filePath);
  try {
    return readFileSync(absolutePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read backend config file at '${absolutePath}'. ${message}`);
  }
}

function maybeLoadRepoBackendsFile(): string | undefined {
  const absolutePath = resolve(process.cwd(), REPO_BACKENDS_FILE);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : undefined;
}

function mergeBackends(registry: Map<string, BackendConfig>, backends: BackendConfig[]): void {
  for (const backend of backends) {
    registry.set(backend.id, backend);
  }
}

function makeBackendRegistry(): Map<string, BackendConfig> {
  const registry = new Map<string, BackendConfig>();

  mergeBackends(registry, builtInBackends);

  const repoBackendsJson = maybeLoadRepoBackendsFile();
  mergeBackends(registry, parseBackendConfig(repoBackendsJson, REPO_BACKENDS_FILE));

  const backendsFile = process.env.OPENAPI_BACKENDS_FILE?.trim();
  if (backendsFile) {
    mergeBackends(registry, parseBackendConfig(loadBackendsJsonFromFile(backendsFile), "OPENAPI_BACKENDS_FILE"));
  }

  mergeBackends(registry, parseBackendConfig(process.env.OPENAPI_BACKENDS, "OPENAPI_BACKENDS"));

  return registry;
}

export function getDefaultBackendId(): string {
  return normalizeBackendId(process.env.DEFAULT_BACKEND_ID?.trim() || DEMO_BACKEND_ID);
}

export function listBackendConfigs(): BackendConfig[] {
  return Array.from(makeBackendRegistry().values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveBackend(backendId?: string): BackendConfig {
  const selectedId = normalizeBackendId(backendId?.trim() || getDefaultBackendId());
  const registry = makeBackendRegistry();
  const backend = registry.get(selectedId);

  if (!backend) {
    const available = Array.from(registry.keys()).sort().join(", ");
    throw new Error(`Unknown backend '${selectedId}'. Available backends: ${available}`);
  }

  return backend;
}

export function createEphemeralBackend(backendId: string | undefined, specUrl: string): BackendConfig {
  const id = normalizeBackendId(backendId?.trim() || "custom-spec");
  return {
    id,
    name: id,
    defaultSpecUrl: specUrl,
  };
}
