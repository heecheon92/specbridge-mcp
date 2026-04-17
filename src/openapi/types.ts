export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
  servers?: Array<{ url?: string; description?: string }>;
  paths?: Record<string, Partial<Record<HttpMethod, OperationObject>>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
  };
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
}

export interface ParameterObject {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: SchemaObject;
  $ref?: string;
}

export interface RequestBodyObject {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: SchemaObject }>;
  $ref?: string;
}

export interface ResponseObject {
  description?: string;
  headers?: Record<string, unknown>;
  content?: Record<string, { schema?: SchemaObject }>;
  $ref?: string;
}

export type SchemaObject = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  nullable?: boolean;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  required?: string[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  allOf?: SchemaObject[];
  additionalProperties?: boolean | SchemaObject;
  [key: string]: unknown;
};

export interface EndpointSummary {
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
  tags?: string[];
}

export interface BackendConfig {
  id: string;
  name: string;
  defaultSpecUrl: string;
  fallbackSpecUrls?: string[];
  description?: string;
  domainHints?: string[];
}

export interface SpecCache {
  loadedAt: number;
  backendId: string;
  sourceUrl: string;
  spec: OpenApiDocument;
}
