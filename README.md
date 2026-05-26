# Prueba Altera B2 — Webhook Serverless de Pagos

> Prueba técnica `ALT-B2-0526-C04` · Cargo: Desarrollador Backend Senior · Candidato: Juan Pablo Lira (`jplira@flink.la`).

Sistema serverless en AWS que recibe webhooks de una pasarela de pagos ficticia ("PayHub"), valida autenticidad con HMAC-SHA256, garantiza idempotencia con DynamoDB, procesa asíncrono vía SQS con partial batch failure, y aísla venenos en una DLQ. Observabilidad productiva con Powertools (logs JSON estructurados, métricas EMF, traces X-Ray).

---

## Tabla de contenidos

1. [Quick start](#quick-start)
2. [Arquitectura](#arquitectura)
3. [Estructura del repo](#estructura-del-repo)
4. [Prerrequisitos](#prerrequisitos)
5. [Setup detallado](#setup-detallado)
6. [Uso](#uso)
7. [Tests](#tests)
8. [Mapeo rúbrica → código](#mapeo-rúbrica--código)
9. [Documentación adicional](#documentación-adicional)
10. [Lo NO entregado y por qué](#lo-no-entregado-y-por-qué)
11. [Uso de AI assistants](#uso-de-ai-assistants)
12. [Notas para la revisión en vivo](#notas-para-la-revisión-en-vivo)

---

## Quick start

```bash
# 1. Instalar dependencias
npm install

# 2. Crear el .env desde el template (gitignored — cada quien el suyo)
cp .env.example .env             # Git Bash / WSL
# Copy-Item .env.example .env    # PowerShell

# 3. Levantar el stack local (DynamoDB Local + ElasticMQ)
docker compose up -d
npm run bootstrap:local

# 4. Levantar el endpoint
npm run offline                  # API Gateway en http://localhost:3000

# 5. (en otra terminal) Correr el E2E
npm run e2e
```

Más detalle abajo. Si algo falla, ver [Setup detallado](#setup-detallado).

---

## Arquitectura

```
PayHub ─POST /webhook─► API Gateway (HTTP API, HTTPS)
                            │
                            ▼
                    Receiver Lambda  ─PutItem condicional─►  DynamoDB idempotency_keys (TTL 24h)
                            │
                            ▼ SendMessage
                           SQS (visibility 5 min)  ──tras 3 reintentos──►  DLQ
                            │ batch trigger
                            ▼
                   Processor Lambda  ─PutItem condicional─►  DynamoDB pagos (PK transaccionId · SK timestamp · PITR)
                            │
                            └─► CloudWatch (Logs · Metrics · Alarms) + X-Ray
```

- **Receiver** = camino crítico, rápido, idempotente. Verifica HMAC → escribe idempotency → encola → responde 202.
- **Processor** = trabajo asíncrono. Consume SQS en batches de 5 con `ReportBatchItemFailures` → persiste pagos con defense in depth → emite métricas.
- **Defense in depth**: la idempotencia vive en `idempotency_keys` (Receiver) Y en `pagos` con `ConditionExpression: attribute_not_exists(transaccionId)` (Processor) — protege contra SQS at-least-once.

---

## Estructura del repo

```
prueba-alteracorp/
├── src/
│   ├── handlers/
│   │   ├── receiver.ts            Webhook handler (6 pasos)
│   │   └── processor.ts           SQS consumer (partial batch failure)
│   ├── services/
│   │   ├── idempotency.ts         PutItem condicional + TTL 24h
│   │   ├── queue.ts               SendMessage SQS
│   │   ├── payments.ts            PutItem condicional en `pagos`
│   │   └── schemas.ts             Zod schemas (moderno + legacy + normalizer)
│   └── lib/
│       ├── env.ts                 Zod-validated env loader
│       ├── hmac.ts                Timing-safe HMAC verify
│       ├── logger.ts              Powertools Logger singleton
│       ├── tracer.ts              Powertools Tracer + withSubsegment helper
│       └── metrics.ts             Powertools Metrics singleton
├── tests/
│   ├── setup.ts                   Env + silencer de EMF para tests
│   └── unit/
│       ├── lib/hmac.test.ts       22 tests
│       └── handlers/
│           ├── receiver.test.ts   16 tests
│           └── processor.test.ts  12 tests (incluye fixture batch-partial-failure.json real)
├── scripts/
│   ├── bootstrap-local.sh         Crea tablas DDB en DDB Local
│   ├── elasticmq.conf             Pre-crea colas SQS+DLQ en ElasticMQ
│   └── e2e-test.sh                10 invocaciones curl con asserts
├── Template_B2_Serverless/        Material original de Altera (no se entrega)
├── serverless.yml                 IaC completo (API GW · 2 λ · SQS+DLQ · 2 DDB · IAM)
├── docker-compose.yml             DDB Local + ElasticMQ con healthchecks
├── package.json                   Scripts npm y deps
├── tsconfig.json                  TS estricto
├── jest.config.ts                 Coverage threshold 70%
├── .env.example                   Plantilla de env vars
├── CLAUDE.md                      Brain del proyecto (contexto operativo)
├── REQUIREMENTS.md                Checklist 80+ ítems con trazabilidad
├── METHODOLOGY.md                 Proceso de 7 fases
├── DECISIONS.md                   18 trade-offs documentados
├── OBSERVABILITY.md               Logs · métricas · traces · alarmas
└── README.md                      Este archivo
```

---

## Prerrequisitos

| Herramienta | Versión | Para qué |
|---|---|---|
| Node.js | `>=20.0.0` | runtime Lambda + dev |
| npm | (viene con Node) | dependencias |
| Docker | con `compose` | DDB Local + ElasticMQ |
| aws-cli | `>= 2.0` | `bootstrap-local.sh` |
| openssl | (Git Bash en Windows lo trae) | firmar requests en `e2e-test.sh` |
| bash | POSIX (Git Bash en Windows) | correr scripts `.sh` |

> **En Windows**: Git Bash trae `openssl`, `curl`, `bash`. aws-cli se instala aparte.

---

## Setup detallado

### 1. Instalar dependencias

```bash
npm install
```

Esto instala AWS SDK v3, Powertools, Zod (prod) + Jest, ts-jest, aws-sdk-client-mock, Serverless Framework v3 + plugins (dev).

### 2. Variables de entorno (`.env`)

El archivo `.env` está **gitignored** — cada quien lo crea localmente a partir del template `.env.example`.

**En Git Bash / WSL:**
```bash
cp .env.example .env
```

**En PowerShell:**
```powershell
Copy-Item .env.example .env
```

**Los valores default del template funcionan tal cual para todo el flujo local con Docker.** No tenés que editar nada para correr el `npm run e2e`.

#### Qué setea cada variable

| Variable | Default local | Para qué | En prod |
|---|---|---|---|
| `PAYHUB_HMAC_SECRET` | `dev-secret-change-me` | Secret para verificar HMAC del webhook | **AWS Secrets Manager** (no literal) |
| `STAGE` | `dev` | Stage actual | `staging` / `prod` |
| `AWS_REGION` | `us-east-1` | Región AWS | Misma o la que aplique |
| `IDEMPOTENCY_TABLE` | `prueba-altera-b2-idempotency-dev` | Nombre tabla DDB de idempotencia | El que define IaC por stage |
| `PAGOS_TABLE` | `prueba-altera-b2-pagos-dev` | Nombre tabla DDB de pagos | El que define IaC por stage |
| `WEBHOOK_QUEUE_URL` | `http://localhost:9324/000000000000/prueba-altera-b2-webhook-queue-dev` | URL completa de la cola principal | Output del stack CloudFormation |
| `WEBHOOK_DLQ_URL` | `http://localhost:9324/000000000000/prueba-altera-b2-webhook-dlq-dev` | URL de la DLQ | Output del stack |
| `DYNAMODB_ENDPOINT` | `http://localhost:8000` | Override del SDK hacia DDB Local | **Omitir** (SDK usa AWS real) |
| `SQS_ENDPOINT` | `http://localhost:9324` | Override del SDK hacia ElasticMQ | **Omitir** |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `local` / `local` | Credenciales fake (DDB Local y ElasticMQ aceptan cualquiera) | IAM role real |
| `IS_OFFLINE` | `true` | Bandera para que el código sepa que está local | `false` o ausente |
| `TRANSIENT_FAILURE_RATE` | `0` | Probabilidad de fallo simulado en Processor (0–1) | `0.05` (5% del enunciado) |
| `LOG_LEVEL` / `POWERTOOLS_LOG_LEVEL` | `INFO` | Nivel de log | `WARN` en prod |

> **Importante**: el formato del `WEBHOOK_QUEUE_URL` es `http://localhost:9324/000000000000/<nombre>` (formato AWS-compatible de ElasticMQ 1.6+). NO usar `/queue/<nombre>` (formato legacy que sí leen versiones viejas pero no responde al protocolo JSON del SDK v3).

### 3. Levantar el stack local

```bash
docker compose up -d            # DDB Local + ElasticMQ con healthchecks
npm run bootstrap:local         # crea tablas DDB con TTL
```

Verificación:
- DynamoDB Local: `http://localhost:8000` (responde a HEAD)
- ElasticMQ: `http://localhost:9324/?Action=ListQueues`
- Tablas creadas: `prueba-altera-b2-idempotency-dev`, `prueba-altera-b2-pagos-dev`
- Colas creadas (por `scripts/elasticmq.conf`): `webhook-queue-dev`, `webhook-dlq-dev`

Para apagar:

```bash
docker compose down
```

---

## Uso

### Correr el endpoint local

```bash
npm run offline
```

API Gateway local en `http://localhost:3000`. Hot-reload habilitado (cambios en `src/` se reflejan sin reiniciar).

### Probar manualmente con curl

```bash
# Body del webhook según el contrato del .docx
BODY='{"transaccionId":"TX-1","referencia":"AB12CD34","clienteRut":"11.111.111-1","monto":5000,"timestamp":"2026-05-19T14:30:00Z"}'
SECRET="dev-secret-change-me"

# Generar la firma HMAC
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

# POST con los 3 headers + body firmado
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-PayHub-Signature: $SIG" \
  -H "X-PayHub-Idempotency-Key: idem-manual-1" \
  -H "X-PayHub-Origin: PAYHUB" \
  -d "$BODY"
```

Esperado: `202 Accepted` con `{"status":"accepted","idempotencyKey":"idem-manual-1"}`.

Repetir con el MISMO `idempotencyKey` → `200 OK` con `{"status":"already_processed",...}`.

### Invocar las Lambdas directamente con los fixtures de Altera

```bash
npm run invoke:receiver:valid       # 202 accepted (necesita HMAC válido)
npm run invoke:receiver:invalid     # 401 unauthorized
npm run invoke:receiver:duplicate   # 200 already_processed
npm run invoke:processor:batch      # { batchItemFailures: [{itemIdentifier:'msg-103'}] }
```

> **Nota sobre los fixtures**: los `*.json` traen `[REEMPLAZAR_CON_HMAC_REAL]` en `X-PayHub-Signature`. Para que `invoke:receiver:valid` responda 202, hay que reemplazar ese placeholder con el HMAC real del body:
>
> ```bash
> ./Template_B2_Serverless/scripts/firmar-evento.sh '<body-json-del-fixture>' "dev-secret-change-me"
> ```

### Correr el E2E completo

```bash
# Requiere: docker compose up + npm run offline (en otra terminal)
npm run e2e
```

`scripts/e2e-test.sh` hace **10 invocaciones curl** con assertions de status code:
- 5 webhooks válidos (esperado 202)
- 2 duplicados explícitos (esperado 200 `already_processed`)
- 1 firma inválida (esperado 401)
- 2 errores 400 (header faltante, body inválido)

Exit code 0 si todas pasan; ≠ 0 si alguna falla.

---

## Tests

### Unit tests (sin Docker)

```bash
npm test
```

50 tests cubriendo:
- **HMAC** (22): happy path, firmas inválidas, longitudes/formatos, inputs vacíos, no-throw, sensibilidad a cambios mínimos.
- **Receiver** (16): 202 happy, 401 HMAC inválido, 400 headers/body, 200 duplicado, 500 errores inesperados (sin exposer stack).
- **Processor** (12): happy moderno + legacy, partial batch (incluye replicar `batch-partial-failure.json` literal), schema inválido, transient simulado, defense in depth.

### Coverage

```bash
npm run test:coverage
```

Threshold configurado en `jest.config.ts`: **70% en las 4 dimensiones** (statements, branches, functions, lines). Si baja, exit code != 0.

Métricas actuales:

| Métrica | Resultado |
|---|---|
| Statements | 99% |
| Branches | 80.35% |
| Functions | 95.23% |
| Lines | 99.49% |

### Validación del IaC

```bash
npx serverless print --stage dev    # resuelve serverless.yml sin errores
npm run typecheck                    # tsc --noEmit
```

---

## Mapeo rúbrica → código

| Dimensión rúbrica | Peso | Implementación |
|---|---|---|
| AWS serverless productivo | 15% | `serverless.yml`: 2 Lambdas, eventos, memory 512/timeout 10-30s sensatos |
| Idempotencia robusta | 15% | `idempotency.ts` (PutItem condicional + TTL 24h) + `payments.ts` (defense in depth). Tests: receiver 200 dup; processor defense in depth |
| SQS + DLQ + partial batch failure | 12% | `serverless.yml` (visibility 300s + redrive 3) + `processor.ts` (`batchItemFailures`). Test: replica `batch-partial-failure.json` literal |
| Seguridad (HMAC + IAM) | 12% | `lib/hmac.ts` con `timingSafeEqual` + `serverless-iam-roles-per-function` (cero `Resource:'*'`) |
| IaC completa | 10% | `serverless.yml` parametrizado por stage (`logRetention/logLevel` maps) |
| DynamoDB design | 8% | TTL 24h en idempotency, PITR en pagos, PK+SK correcto, `PAY_PER_REQUEST` |
| Observabilidad | 10% | `lib/{logger,metrics,tracer}.ts` + correlationId end-to-end + `OBSERVABILITY.md` (7 secciones) |
| Testing | 10% | 50 tests con `aws-sdk-client-mock`, coverage 99% (threshold 70%) |
| TypeScript + calidad | 5% | `strict:true` + `noUnusedLocals/Parameters/ImplicitReturns`. Separación `handlers/services/lib`. Cero `any` sin justificar. |
| Documentación + script E2E | 3% | README + `DECISIONS.md` (18 trade-offs) + `OBSERVABILITY.md` + `scripts/e2e-test.sh` con asserts |

---

## Documentación adicional

| Archivo | Contenido |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Brain del proyecto: identidad, arquitectura, stack, tareas, fixtures, rúbrica |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | Checklist de 80+ ítems trazables (A→O) con estado actual |
| [`METHODOLOGY.md`](METHODOLOGY.md) | Las 7 fases del proceso, criterio de "done", reglas operativas |
| [`DECISIONS.md`](DECISIONS.md) | **18 decisiones técnicas con trade-offs explícitos** (D1–D18) — lectura clave para la revisión en vivo |
| [`OBSERVABILITY.md`](OBSERVABILITY.md) | Estructura de logs, métricas, traces, alarmas en 3 niveles, runbooks |
| [`AI_USAGE.md`](AI_USAGE.md) | Detalle del uso de Claude por fase, qué propuso vs qué decidí yo |

---

## Lo NO entregado y por qué

> Ítem A.6 de la rúbrica: "No alcancé X porque..." es respuesta válida. Lo importante es ser honesto y justificar.

### Implementado pero NO en producción

| Cosa | Por qué |
|---|---|
| Compensación con `DeleteItem` ante `SendMessage` fallido en Receiver | Documentada en **D17**. La compensación "a medias" (`try DeleteItem, log si falla`) tiene su propio failure mode. Mitigación correcta para prod: DDB Streams → reconciler Lambda con estados `received → enqueued`. Excede el alcance temporal de la prueba. |
| Alarmas reales en CloudWatch | Documentadas en `OBSERVABILITY.md` sección 4 (críticas/warnings/informativas con umbrales). NO creadas como `AWS::CloudWatch::Alarm` en `serverless.yml` por alcance. |
| Deploy real a AWS | El enunciado dice explícitamente "no necesitas tener una cuenta AWS real ni desplegar". `serverless print --stage dev` resuelve limpio; la plantilla es desplegable. |
| GSI en `pagos` | **D13**: no hay patrón de acceso actual que la justifique. Si futuras queries por `clienteRut` o `estado` emergen, agregar GSI `byCliente` (PK `clienteRut`, SK `timestamp`). |

### Decisiones deliberadas de NO hacer

| Cosa | Por qué |
|---|---|
| Validación de formato RUT chileno con dígito verificador | El Receiver es "delgado": valida shape, no lógica de negocio. Si el RUT viene mal formado, falla en `pagos` o downstream. Documentado en `schemas.ts`. |
| Powertools middleware via `middy` | Usamos `addContext` + `appendKeys` explícito. Menos magia, más testeable, sin dep extra. |
| Step Functions / DDB Streams reconciliation | Patrón correcto para idempotency at scale pero out of scope. Mencionado en D17 como mitigación para prod. |
| TTL real de DDB Local | DDB Local registra el atributo `ttl` pero no lo elimina (limitación del emulador). En AWS real funciona. Documentado en D14. |
| LocalStack | **D14**: footprint mayor, X-Ray no funcional en community, ElasticMQ+DDB Local son más fieles. |
| FIFO SQS | **D7**: limita throughput, bloquea batch en partial failure, no aporta dado que la idempotencia ya está en app layer. |

---

## Uso de AI assistants

Usé Claude (Anthropic) via Claude Code durante toda la construcción. **Documentación honesta en [`AI_USAGE.md`](AI_USAGE.md)**.

Resumen:

- **Setup**: le di los archivos del enunciado (.docx + Template_B2_Serverless/) y pedí que generara un brain del proyecto.
- **Construcción por fases**: cada una fue una conversación corta acordando qué crear, qué decidir, cómo testear, qué documentar.
- **Decisiones que tomé yo**: Serverless Framework v3 (vs SAM/v4), Jest+ts-jest (vs vitest), commits a mi cargo, soporte legacy en schemas, documentar D17 como limitación.
- **Decisiones que Claude propuso y validé**: estructura `handlers/services/lib`, `serverless-iam-roles-per-function`, helper `withSubsegment`, singleton pattern para Powertools, defense in depth con `ConditionExpression` en pagos.

**Para la revisión en vivo**: cada fase fue una iteración de Q&A, por lo que puedo explicar línea por línea y modificar bajo demanda. Los archivos que conozco más a fondo: `hmac.ts`, `receiver.ts`, `processor.ts`, `serverless.yml`.

---

## Notas para la revisión en vivo

> "La entrega técnica es la mitad de la evaluación; la revisión en vivo es la otra mitad."

### Preguntas anticipadas con respuesta lista

| Pregunta | Respuesta (resumida; detalle en DECISIONS.md) |
|---|---|
| ¿Por qué Serverless v3 y no v4? | v4 requiere licencia paga; v3 sigue OSS y cubre el scope. (D1) |
| ¿Por qué IAM role por Lambda? | Least privilege real: si Receiver se compromete, no toca `pagos`. (D6) |
| ¿Por qué `VisibilityTimeout: 300`? | Regla AWS: ≥ 6 × LambdaTimeout (6×30=180s mínimo); 300 da margen. (D10) |
| ¿Por qué SQS estándar y no FIFO? | FIFO bloquea batch en partial failure; idempotencia ya en app layer. (D7) |
| ¿Por qué `timingSafeEqual` y no `===`? | Timing attack: con `===` el tiempo depende del byte donde difieren. (Tarea 3) |
| ¿Por qué regex hex antes de `Buffer.from`? | Sin regex, chars inválidos truncan silenciosamente el buffer. (D16) |
| ¿Por qué no exportás `computeSignatureHex`? | Para evitar `received === computeSignatureHex(...)` (timing attack). (D16) |
| ¿Por qué dos schemas (moderno + legacy)? | El fixture `batch-partial-failure.json` usa shape legacy; sin soporte, los 5 records irían a `batchItemFailures`. (D18) |
| ¿Por qué `ConditionExpression` también en `pagos`? | Defense in depth: SQS at-least-once puede entregar el mismo mensaje 2 veces. |
| ¿Qué pasa si SQS falla tras PutItem exitoso? | Mensaje pierde (documentado en D17). Mitigación prod: DDB Streams reconciler. |
| ¿Cómo se propaga el correlationId? | Header → Receiver Logger → SQS MessageAttributes + body → Processor Logger. Detalle en OBSERVABILITY.md §1. |
| ¿Qué alarmas propondrías? | DLQ > 0 (crítica), Error rate > 1% (crítica), p99 latency > 5s (crítica). Detalle en OBSERVABILITY.md §4. |

### Cómo prepararse para modificar código en vivo

Áreas donde es probable que pidan cambios:
- Agregar un campo al body (ej. `moneda`) → editar `webhookBodySchema` en `schemas.ts`, agregar al item de `pagos`.
- Cambiar el threshold de fallo transient → editar `TRANSIENT_FAILURE_RATE` env var.
- Agregar una métrica nueva → emitir en el handler con `metrics.addMetric('NuevaMétrica', MetricUnit.X, value)`.
- Cambiar visibility timeout → `serverless.yml` línea `VisibilityTimeout`.
- Agregar un permiso IAM → `iamRoleStatements` de la función correspondiente.

---

**Cualquier duda, contacto: `jplira@flink.la`. Mucho éxito con la revisión.**
