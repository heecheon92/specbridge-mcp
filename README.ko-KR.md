# SpecBridge MCP

언어: [English](README.md)

SpecBridge MCP는 AI 에이전트에게 API 계약 정보를 제공하기 위한 **clone-and-own MCP 스타터**입니다. OpenAPI 문서를 직접 사용할 수 있고, Huma 서비스는 Huma가 내보내는 OpenAPI 문서를 통해 사용할 수 있습니다. 이 계약 문서를 결정적인 엔드포인트 메타데이터, 스키마, 검증 정보, 참조 DTO, TypeScript 타입 선언으로 바꿔서 에이전트가 프론트엔드나 클라이언트 코드를 수정하기 전에 정확한 계약 정보를 볼 수 있게 합니다.

이 프로젝트는 npm 배포용 패키지라기보다 저장소 우선 방식으로 설계되었습니다. 이 저장소를 복제한 뒤, 팀의 private/public 스펙에 맞게 백엔드 레지스트리를 조정하고, 로컬 MCP 서버를 에이전트 호스트에 등록해서 사용하는 것을 목표로 합니다. 구현은 다운스트림 저장소를 직접 수정하지 않고, 공개 데모 백엔드를 제공하며, 여러 백엔드를 주입할 수 있고, 추론 기반 헬퍼는 보장된 사실이 아니라 best-effort로 다루도록 작게 유지합니다.

> 상태: 실험적입니다. 로컬 자동화에 유용한 도구 표면은 갖추고 있지만, 각 팀이 소유하고 필요에 맞게 수정하는 저장소로 쓰는 것을 전제로 합니다.

## 간단한 배경

SpecBridge MCP는 SesameLab에서 백엔드 API 계약을 기반으로 개발 흐름을 개선하기 위해 만든 개인 내부 도구에서 시작했습니다. 실제로 AI 에이전트에게 API 문서 페이지를 직접 읽게 하는 것보다, MCP를 통해 구조화된 계약 데이터를 제공했을 때 환각이 줄었습니다. Huma 기반 서비스도 이 사용 사례에 포함됩니다.

## Huma 지원 상태

Huma는 Huma 서비스가 노출하는 OpenAPI 호환 문서를 통해 지원합니다. Huma 생성 스펙, JSON/YAML 로딩, 유니코드 설명에 대한 smoke test는 있지만, 아직 많은 실제 Huma 서비스 전반을 검증하는 광범위한 conformance suite는 아닙니다. 따라서 Huma 지원은 의도적으로 지원하고 계속 성숙시키는 중이라고 보는 것이 정확합니다.

## 제공 기능

- 하나 이상의 API 계약 스펙을 위한 설정 가능한 백엔드 레지스트리
- Huma가 생성한 OpenAPI JSON/YAML 문서를 통한 Huma 호환 지원
- 실제 공개 Swagger/OpenAPI URL을 사용하는 zero-config 데모 백엔드
- JSON/YAML 스펙 로딩 및 refresh
- 엔드포인트 목록 조회와 필터링
- 결정적 사실을 담은 엔드포인트 계약 번들:
  - operation metadata
  - parameters
  - request/response schemas
  - referenced component schemas
  - endpoint-scoped TypeScript DTO declarations
  - `required`, `nullable`, `enum`, `format`, arrays, maps, composition 같은 validation facts
- component schema에서 TypeScript DTO declaration 생성
- 결정적인 스펙 정보보다 낮은 우선순위로 제공되는 best-effort proposal helper

## 프로젝트 구조

```text
.
├── README.md                         # 사용자용 설정, 구성, 도구, 확장 문서
├── README.ko-KR.md                   # README.md의 한국어 번역
├── AGENTS.md                         # 향후 코딩 에이전트를 위한 에이전트용 프로젝트 가이드
├── package.json                      # pnpm scripts, runtime dependencies, package metadata
├── tsconfig.json                     # strict TypeScript build config; build/로 JS 출력
├── biome.json                        # Biome formatter/linter config; 로컬 backend config 제외
├── mcp-server.sh                     # 필요 시 빌드 후 MCP 서버를 시작하는 얇은 shell wrapper
├── openapi.backends.example.json     # 로컬 사용을 위해 복사할 수 있는 커밋된 demo backend registry
├── openapi.backends.json             # ignored local backend registry; 필요 시 example에서 생성
├── src/
│   ├── index.ts                      # CLI entrypoint + stdio/stateful HTTP/stateless HTTP transports
│   ├── mcp/register-tools.ts         # MCP tool registration 및 tool-level orchestration
│   └── openapi/
│       ├── config.ts                 # backend registry loading, env precedence, defaults, cache settings
│       ├── spec.ts                   # spec fetching, parsing, endpoint lookup, schema facts, DTO emission
│       └── types.ts                  # shared OpenAPI/Huma-compatible contract types
├── tests/
│   ├── schema-dto.test.mjs           # registry, parsing, DTO, contract facts 단위 테스트
│   ├── privacy.test.mjs              # publishable files에 internal/private token이 들어가지 않도록 하는 guardrail
│   └── e2e/mcp-stdio.test.mjs        # representative tool calls에 대한 MCP stdio smoke test
└── build/                            # pnpm build로 생성되는 output; 직접 수정하지 않음
```

`src/openapi` 디렉터리 이름은 계약의 wire format을 의미합니다. Huma 지원은 Huma 서비스가 생성하는 OpenAPI 호환 JSON/YAML 문서를 통해 동작합니다.

## 하지 않는 것

- v1에서 npm 패키지로 배포하기
- 범용 installable CLI abstraction 제공하기
- 다운스트림 frontend/client 저장소를 직접 수정하기
- 프레임워크 특화 client 또는 SDK generator가 되기
- 스펙을 호스팅하거나 팀 API 데이터를 원격 저장하기

## 요구사항

- Node.js 18+
- pnpm 10+

## 설치

```bash
git clone <your-fork-or-copy-url> specbridge-mcp
cd specbridge-mcp
pnpm install
pnpm build
```

## 백엔드 설정

SpecBridge는 built-in public demo backend를 포함하므로, 로컬 backend registry가 없어도 도구가 동작합니다. Huma 서비스는 `/openapi.json`, `/openapi.yaml`, 또는 서비스별 docs route처럼 Huma가 노출하는 OpenAPI JSON/YAML 문서를 `specUrl`로 지정하면 사용할 수 있습니다.

로컬 백엔드 정의는 `openapi.backends.json`에 둡니다. 이 파일은 private, local, environment-specific API URL을 포함할 수 있으므로 Git에서 의도적으로 ignore합니다.

커밋된 `openapi.backends.example.json` 파일에는 동작하는 Swagger Petstore demo backend가 들어 있습니다. 저장소를 clone한 뒤 로컬 backend registry를 만들려면 다음을 실행합니다.

```bash
cp openapi.backends.example.json openapi.backends.json
```

복사한 demo backend를 그대로 두고 MCP 도구를 검증할 수도 있고, 빈 배열(`[]`)로 바꾸거나, 필요한 백엔드 정의를 추가할 수도 있습니다.

```json
[
  {
    "id": "local-service",
    "name": "Local Huma Service",
    "specUrl": "http://localhost:8080/openapi.json",
    "fallbackSpecUrls": ["http://localhost:8080/openapi.yaml"],
    "description": "Your local Huma/OpenAPI contract",
    "domainHints": ["/users", "/orders"]
  }
]
```

또는 `OPENAPI_BACKENDS_FILE`로 다른 JSON 파일을 가리키거나 `OPENAPI_BACKENDS`를 직접 설정할 수 있습니다.

### 이름에 대한 참고: Huma vs OpenAPI

Huma는 OpenAPI 호환 계약 문서를 내보내므로, 일부 저장소 내부 구조, tool name, environment variable에는 여전히 `openapi`라는 이름이 들어갑니다. 이 이름은 contract wire format을 의미하며, non-Huma API로 제한한다는 뜻이 아닙니다. MCP 도구는 plain OpenAPI specs와 Huma-generated specs 모두를 대상으로 하지만, Huma 경로는 더 넓은 fixture coverage가 쌓일 때까지 성숙 중인 지원으로 설명합니다.

### 설정 우선순위

tool call에서 명시적으로 전달한 `specUrl` override가 있으면 해당 호출에서 가장 먼저 사용됩니다.

Backend registry source는 다음 순서로 병합되며, 뒤에 오는 source가 같은 `id`를 가진 앞 source를 override합니다.

1. Built-in public demo backend
2. Repository-local `openapi.backends.json`, when present
3. `OPENAPI_BACKENDS_FILE`, when set
4. `OPENAPI_BACKENDS`, when set

`DEFAULT_BACKEND_ID`는 기본 backend를 선택합니다. 설정하지 않으면 SpecBridge는 `swagger-petstore`를 사용합니다.

### 환경 변수

- `MCP_TRANSPORT`: `stdio` 또는 `http`
- `MCP_HTTP_HOST`: HTTP bind host
- `MCP_HTTP_PORT`: HTTP port
- `MCP_HTTP_PATH`: MCP endpoint path, 예: `/mcp`
- `MCP_HTTP_STATELESS`: stateless HTTP mode를 사용하려면 `true`
- `DEFAULT_BACKEND_ID`: default backend ID
- `OPENAPI_BACKENDS`: backend config의 JSON array
- `OPENAPI_BACKENDS_FILE`: backend config JSON file path
- `OPENAPI_FETCH_TIMEOUT_MS`: spec loading fetch timeout
- `OPENAPI_CACHE_TTL_MS`: in-memory spec cache TTL
- `OPENAPI_ENABLE_SWAGGER_UI_SCRIPT_EXTRACTION`: static Swagger UI script에서 strict JSON object extraction을 opt in합니다. 가져온 JavaScript는 실행하지 않습니다.

## 실행

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

## MCP host 설정

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

### Codex `config.toml` 예시

```toml
[mcp_servers.specbridge-mcp]
args = ["/absolute/path/to/specbridge-mcp/mcp-server.sh"]
command = "bash"
```

### HTTP URL

서버 시작:

```bash
./mcp-server.sh --transport http --host 127.0.0.1 --port 3000 --path /mcp
```

그 다음 host를 다음 URL에 연결합니다.

- `http://127.0.0.1:3000/mcp`

host가 session state와 잘 맞지 않으면 `--stateless`로 다시 시도합니다.


## AI 에이전트에게 요청할 수 있는 예시

이 MCP 서버를 agent host에 연결한 뒤, 사용자는 자연어로 API 계약을 인식하는 질문이나 구현 요청을 AI 에이전트에게 할 수 있습니다. 에이전트는 기억에 의존하거나 문서 페이지를 직접 스크래핑하지 않고, SpecBridge MCP 도구를 계약 데이터의 source of truth로 사용해야 합니다.

예시:

- "사용 가능한 백엔드 서비스가 뭐고, school API에는 어떤 `backendId`를 쓰면 돼?"
- "학생 출결과 관련된 엔드포인트를 찾고, 호출해야 할 엔드포인트의 request/response 계약을 보여줘."
- "SpecBridge MCP를 사용해서 이 코드베이스에 새 학생 출결 엔드포인트에 필요한 API model type과 endpoint wrapper를 추가해줘."
- "현재 client code가 작성된 뒤 API 계약이 바뀐 게 있는지 확인해줘. 변경이 있다면 영향받는 DTO, endpoint function, test를 수정해줘."

이런 구현 요청에서 SpecBridge는 계약 사실을 제공합니다. 실제 코드베이스 수정 방식은 AI 에이전트가 결정하며, 수정 후에는 해당 프로젝트의 테스트로 검증해야 합니다.

에이전트에게 함께 지시하면 좋은 문장:

- "API 계약 사실은 SpecBridge MCP만 사용해."
- "먼저 `list_backends`를 호출하고, 이후 호출에는 반환된 `backendId`를 사용해."
- "private spec URL을 직접 방문하지 말고 MCP 도구를 통해 계약 데이터를 읽어."
- "`propose_new_endpoint` 출력은 source-of-truth 계약 데이터가 아니라 제안으로 다뤄."

## Tools

Recommended flow:

1. `list_backends`
2. `load_openapi_spec`
3. `list_api_endpoints`
4. `get_endpoint_contract`
5. `generate_typescript_dto`

### `list_backends`

설정된 backend target, default backend ID, optional domain hints를 나열합니다.

### `load_openapi_spec`

Huma-generated OpenAPI specs를 포함하여 backend의 OpenAPI-compatible contract document를 로드하거나 refresh합니다. 직접 `specUrl` override를 지원합니다.

### `list_api_endpoints`

로드된 spec에서 endpoint 목록을 나열합니다. optional tag, method, path substring, limit filter를 지원합니다.

### `get_endpoint_contract`

결정적인 endpoint contract bundle을 반환합니다: operation metadata, parameters, request body, responses, referenced schemas, endpoint-scoped TypeScript DTO declarations, validation facts, best-effort hints.

### `generate_typescript_dto`

component schema name에서 TypeScript DTO declaration을 생성하고 referenced nested DTO type도 포함합니다.

### `propose_new_endpoint`

현재 contract spec에서 발견된 패턴에 맞춘 best-effort endpoint 및 DTO proposal을 반환합니다. 이것은 결정적 보장이 아니라 agent aid로 다뤄야 합니다.

## 추가 서비스 레이어 확장

SpecBridge는 의도적으로 작게 유지됩니다. 가장 안전한 확장 패턴은 한 번에 하나의 focused layer를 추가하고 MCP tool은 얇게 유지하는 것입니다.

### 설정만으로 다른 backend service 추가하기

서비스가 이미 OpenAPI 또는 Huma-generated OpenAPI 문서를 노출한다면 코드 변경은 필요 없습니다. ignored local `openapi.backends.json`에 추가하거나 `OPENAPI_BACKENDS_FILE`/`OPENAPI_BACKENDS`로 제공합니다.

```json
[
  {
    "id": "billing-service",
    "name": "Billing Service",
    "specUrl": "https://billing.example.com/openapi.json",
    "fallbackSpecUrls": ["https://billing.example.com/openapi.yaml"],
    "description": "Billing API contract",
    "domainHints": ["/invoices", "/payments"]
  }
]
```

agent가 모든 tool call에 `backendId`를 다시 전달하므로 안정적인 lowercase `id` 값을 사용하세요. 여러 서비스에 비슷한 이름의 resource가 있을 수 있다면 `domainHints`를 추가하세요. endpoint-not-found suggestion에 사용됩니다.

### 새 service layer를 코드로 추가하기

서비스에 custom discovery, auth, post-processing, 또는 generic OpenAPI/Huma contract operation이 아닌 별도 tool이 필요할 때 이 경로를 사용합니다.

1. `src/index.ts`에는 transport concern만 유지하고 service-specific behavior를 넣지 않습니다.
2. shared service type은 해당 service layer 근처의 focused `types.ts` 파일에 둡니다.
3. configuration 및 environment parsing은 focused `config.ts` 파일에 둡니다. precedence를 명확히 하고 테스트합니다.
4. deterministic contract 또는 service logic은 pure module에 둡니다. 이 MCP 서버에서 downstream repository를 mutate하지 않습니다.
5. MCP-facing operation은 `src/mcp/register-tools.ts`에 등록하거나, 파일이 너무 커지면 service-specific `register-*.ts` module로 분리합니다.
6. tool은 agent가 human-friendly text와 machine-friendly JSON을 모두 읽을 수 있도록 `content`와 `structuredContent`를 함께 반환합니다.
7. layer에 의존하기 전에 테스트를 추가합니다: parsing/edge case에 대한 unit test와 새 tool이 노출될 경우 MCP smoke test.

좋은 확장 경계는 다음과 같습니다.

```text
src/
├── mcp/
│   ├── register-tools.ts             # registerOpenApiTools + any new registerXTools helpers 호출
│   └── register-billing-tools.ts     # 새 서비스가 distinct MCP tools를 노출할 때 선택적으로 사용
└── billing/
    ├── config.ts                     # billing-specific env/config loading
    ├── contract.ts                   # deterministic billing contract helpers
    └── types.ts                      # billing-specific DTO/helper types
```

추론보다 결정적인 사실을 우선하세요. best-effort helper를 추가할 때는 output에 명확히 표시하고, spec-derived facts보다 낮은 우선순위로 유지하며, 그 구분을 고정하는 테스트를 포함하세요.

## 개발

```bash
pnpm install
pnpm check
pnpm build
pnpm test
```

유용한 scripts:

- `pnpm check`: Biome check
- `pnpm format`: Biome formatting 적용
- `pnpm lint`: Biome lint only
- `pnpm build`: clean TypeScript build
- `pnpm test`: build 후 모든 test 실행
- `pnpm test:e2e`: build 후 MCP smoke tests 실행

## Clone-and-own guidance

SpecBridge는 저장소 우선 방식입니다. core는 작게 유지하고, backend configuration은 로컬에 맞게 조정하며, downstream agent가 client code 수정 방식을 결정하도록 두세요. 팀에 custom auth, internal naming rules, additional contract facts가 필요하다면 global package abstraction과 싸우기보다 clone한 저장소 안에서 추가하세요.
