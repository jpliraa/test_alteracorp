# REQUIREMENTS.md — Checklist verificable

> Mapeo 1-a-1 de los requisitos del enunciado (`Prueba_Personalizada_C04_Juan_Pablo_Lira_B2.docx` + `Template_B2_Serverless/`) a entregables concretos. Cada ítem es verificable.
>
> Convención: `[ ]` = pendiente · `[x]` = hecho · `[~]` = en progreso · `[!]` = bloqueado o renunciado (documentar en README).

---

## A. Reglas administrativas y de proceso

- [ ] **A.1** Correo de entrega con asunto que incluya `ALT-B2-0526-C04`. _(lo hace el candidato al entregar)_
- [ ] **A.2** Plazo cumplido: lunes 25 de mayo de 2026. _(en curso)_
- [ ] **A.3** Mínimo 5 commits incrementales (lo hace el candidato; Claude propuso mensajes sugeridos por fase).
- [x] **A.4** AI assistants documentado en `AI_USAGE.md` con detalle por fase: qué propuso Claude, qué decidió el candidato, prompts representativos, archivos generados.
- [x] **A.5** Repo desplegable con `serverless deploy --stage dev` (validado: `serverless print` resuelve limpio).
- [x] **A.6** README sección "Lo NO entregado y por qué" cubre 9 ítems con justificación.

## B. Arquitectura objetivo

- [ ] **B.1** API Gateway HTTP API expuesto en `POST /webhook`.
- [ ] **B.2** Receiver Lambda como camino crítico (verificación HMAC + idempotencia + encolar + responder rápido).
- [ ] **B.3** SQS principal con visibility timeout = 5 min y batch del Processor.
- [ ] **B.4** DLQ asociada con `maxReceiveCount: 3`.
- [ ] **B.5** Processor Lambda triggered por SQS con partial batch failure.
- [ ] **B.6** DynamoDB `idempotency_keys` con TTL 24h.
- [ ] **B.7** DynamoDB `pagos` como tabla principal de pagos persistidos.
- [ ] **B.8** CloudWatch para Logs + Metrics + Alarms. X-Ray habilitado.

## C. Contrato del webhook

- [ ] **C.1** Headers esperados: `X-PayHub-Signature`, `X-PayHub-Idempotency-Key`, `X-PayHub-Origin: PAYHUB`.
- [ ] **C.2** Body validado con Zod contra el shape `{ transaccionId, referencia, clienteRut, monto, timestamp }`.
- [ ] **C.3** El campo `transaccionId` se usa como PK de `pagos`; `idempotencyKey` viene del header.
- [ ] **C.4** Coherencia con fixtures `sample-events/`: el shape interno de SQS usa `eventoId`/`cobroId`/`monto`/`clienteRut`. El código del Receiver mapea el body HTTP a ese formato si encola distinto, o se justifica en `DECISIONS.md`.

## D. Tarea 1 — Setup inicial (~30 min)

- [x] **D.1** Proyecto inicializado con Serverless Framework v3 + plugins (`serverless.yml` materializado en Fase 2).
- [x] **D.2** `tsconfig.json` con `"strict": true` y configuración productiva (target ES2022, moduleResolution, esModuleInterop, isolatedModules).
- [x] **D.3** Estructura: `src/handlers/`, `src/services/`, `src/lib/`, `tests/`, `scripts/`.
- [x] **D.4** Dependencias producción instaladas (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-sqs`, `@aws-lambda-powertools/{logger,metrics,tracer}`, `zod`).
- [x] **D.5** Dev deps instaladas (`aws-sdk-client-mock`, `aws-sdk-client-mock-jest`, `jest`, `ts-jest`, `@types/{aws-lambda,jest,node}`, `typescript`, `ts-node`, `serverless@^3`, `serverless-iam-roles-per-function`, `serverless-offline`, `serverless-offline-sqs`, `serverless-esbuild`, `esbuild`).
- [x] **D.6** `.gitignore` con `node_modules/`, `.serverless/`, `dist/`, `coverage/`, `.dynamodb/`, `.env*`.
- [ ] **D.7** `git init` + primer commit (lo hace el usuario, mensaje sugerido en cierre de Fase 1).

## E. Tarea 2 — IaC (~30 min)

- [x] **E.1** `serverless.yml` con TODOS los recursos definidos (functions, SQS, DLQ, 2 DDB, IAM por función, X-Ray, outputs).
- [x] **E.2** API Gateway HTTP API: ruta `POST /webhook` → Receiver Lambda.
- [x] **E.3** Receiver Lambda: runtime `nodejs20.x`, memory 512 MB / timeout 10 s, env vars por stage.
- [x] **E.4** Processor Lambda: runtime `nodejs20.x`, memory 512 MB / timeout 30 s, trigger SQS con `batchSize: 5`, `maximumBatchingWindow: 1`, `functionResponseType: ReportBatchItemFailures`.
- [x] **E.5** SQS principal: visibility timeout 300 s, redrive policy hacia DLQ con `maxReceiveCount: 3`.
- [x] **E.6** SQS DLQ definida con retention 14 días.
- [x] **E.7** DynamoDB `idempotency_keys`: PK `idempotencyKey` (S), TTL en `ttl`, billing `PAY_PER_REQUEST`.
- [x] **E.8** DynamoDB `pagos`: PK `transaccionId` (S), SK `timestamp` (S), billing `PAY_PER_REQUEST`, PITR habilitado.
- [x] **E.9** IAM roles least privilege vía `serverless-iam-roles-per-function`: Receiver → `PutItem` en `idempotency_keys` + `SendMessage` en webhook queue. Processor → `PutItem` en `pagos` + `ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes` en webhook queue. Cero `Resource: '*'`.
- [x] **E.10** Variables de entorno parametrizadas por stage via `${self:provider.stage}` y maps en `custom.logLevel/logRetention`.
- [x] **E.11** `provider.tracing.lambda: true` y `apiGateway: true` (X-Ray).
- [x] **E.12** Logs retention parametrizada por stage (dev:14, staging:30, prod:90 días).
- [x] **E.13** `serverless print --stage dev` corre sin errores (validado: resuelve provider/functions/resources/outputs sin warnings).

## F. Tarea 3 — Verificación HMAC (~30 min)

- [x] **F.1** `src/lib/hmac.ts` exporta `verifySignature(body: string, signature: string, secret: string): boolean`.
- [x] **F.2** Implementación usa `crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')` en función privada `computeSignatureHex`.
- [x] **F.3** Comparación con `crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'))`.
- [x] **F.4** Si las longitudes difieren → `return false` sin throw (validado por test "no tira cuando las longitudes difieren").
- [x] **F.5** Body vacío, signature vacía o secret vacío → `return false` sin reventar (validado por 4 tests).
- [x] **F.6** Cero `===` para comparar HMAC: validado por grep — los únicos `===` en `hmac.ts` son `body === ''` / `signature === ''` / `secret === ''` (guards de presencia) y comentarios JSDoc.
- [x] **F.7** 22 tests unitarios cubriendo: firma válida (3), inválida (3), longitudes/formatos (5), inputs vacíos (4), no-throw (4), sensibilidad a cambios mínimos (3). Coverage de `hmac.ts`: 100% statements/branches/functions/lines.

## G. Tarea 4 — Receiver Lambda (~45 min)

- [x] **G.1** Handler en `src/handlers/receiver.ts` exporta `handler: APIGatewayProxyHandlerV2`.
- [x] **G.2** Paso 1: HMAC verify → 401 con body `{ status: 'unauthorized' }`, sin DDB, sin SQS. Log warn.
- [x] **G.3** Paso 2: validar `x-payhub-idempotency-key` y `x-payhub-origin` → 400 si falta alguno. (`x-payhub-signature` ya se valida en G.2.)
- [x] **G.4** Paso 3: Zod safeParse del body → 400 con issues serializados (sin el `received` raw para evitar leak de datos).
- [x] **G.5** Paso 4: `PutCommand` con `ConditionExpression: 'attribute_not_exists(idempotencyKey)'` y items `{ idempotencyKey, transaccionId, status:'received', createdAt:ISO, ttl:floor(now/1000)+86400 }`.
- [x] **G.6** Paso 5: `SendMessageCommand` con `WebhookMessage` (idempotencyKey, correlationId, ingestionTimestamp, payload) + `MessageAttributes` para correlationId.
- [x] **G.7** Paso 6: 202 con `{ status: 'accepted', idempotencyKey }`.
- [x] **G.8** `ConditionalCheckFailedException` → 200 `{ status: 'already_processed', idempotencyKey }`, NO encola (validado por test "responde 200 sin encolar cuando idempotencyKey ya existe").
- [x] **G.9** Catch-all → 500 `{ status: 'internal_error' }`. Validado por test "NO expone stack traces en el body de 500".
- [x] **G.10** Powertools Logger con `addContext(context)` + `appendKeys({ correlationId })`. CorrelationId = header X-PayHub-Idempotency-Key, fallback `context.awsRequestId`.
- [x] **G.11** Tracer auto-instrumenta DDB y SQS clients con `captureAWSv3Client`. Subsegments custom `putIdempotencyKey` y `enqueueWebhook` vía `withSubsegment`.
- [x] **G.12** 16 tests con `aws-sdk-client-mock`: happy (2), 401 invalid sig (3), 400 bad request (7), 200 duplicate (1), 500 unexpected (3). Coverage receiver.ts 100% statements/lines.

## H. Tarea 5 — Processor Lambda (~45 min)

- [x] **H.1** Handler en `src/handlers/processor.ts` con firma `(event: SQSEvent, context: Context) => Promise<SQSBatchResponse>`.
- [x] **H.2** Itera `event.Records`. Por cada uno: parse JSON → `normalizeWebhookMessage` (acepta shape moderno + legacy) → `persistPago` con `PutCommand` y `ConditionExpression: 'attribute_not_exists(transaccionId)'` (defense in depth) incluyendo `idempotencyKey` cross-table.
- [x] **H.3** Simulación fallo transient configurable via `TRANSIENT_FAILURE_RATE` (default 0.05). En tests se setea a 0/1 para determinismo.
- [x] **H.4** Try/catch por record agrega `itemIdentifier: record.messageId` a `batchItemFailures` y continúa con los siguientes.
- [x] **H.5** Retorna `{ batchItemFailures }`. NUNCA tira al runtime (validado por test "NUNCA tira excepción al runtime").
- [x] **H.6** Métricas custom emitidas: `PagosProcesados` (Count), `PagosFallidos` (Count), `LatenciaProcesado` (Milliseconds, end-to-end desde `ingestionTimestamp`). Dimensiones default: `Pasarela=PAYHUB`, `Stage`.
- [x] **H.7** Tracer auto-instrumenta DDB (capturAWSv3Client) + subsegment custom `persistPago` con annotations `transaccionId`, `idempotencyKey`.
- [x] **H.8** Correlation ID: extraído de `record.messageAttributes.correlationId` (prioritario, lo setea nuestro Receiver) → fallback al `correlationId` del body normalizado → fallback final `record.messageId`. Inyectado al Logger via `appendKeys`.
- [x] **H.9** 12 tests con `aws-sdk-client-mock`: happy moderno (2), happy legacy (1), partial batch incluyendo replica EXACTA del fixture `batch-partial-failure.json` (2), schema inválido (2), transient (2), defense in depth (1), errores no anticipados (2). Coverage processor.ts 100% lines.

## I. Tarea 6 — DynamoDB design (~30 min)

- [x] **I.1** `idempotency_keys` definida en IaC: PK `idempotencyKey` (S). Atributos `transaccionId`, `status`, `createdAt`, `ttl` se escriben desde el código (Fase 4).
- [x] **I.2** TTL habilitado sobre atributo `ttl` (24 h se calculan en código en Fase 4).
- [x] **I.3** `pagos` definida en IaC: PK `transaccionId` (S), SK `timestamp` (S). Atributos restantes se escriben desde el código (Fase 5).
- [x] **I.4** Billing mode `PAY_PER_REQUEST` en ambas tablas.
- [x] **I.5** Decisión "estándar vs FIFO" documentada en `DECISIONS.md` (D7) con trade-offs explícitos.
- [x] **I.6** Decisión "sin GSI inicial" documentada en `DECISIONS.md` (D13) con plan de escalado.

## J. Tarea 7 — Observabilidad (~45 min)

- [x] **J.1** Logs JSON con `Logger` Powertools en Receiver y Processor. `addContext` + `appendKeys` patrón estándar.
- [x] **J.2** CorrelationId propagado end-to-end: header HTTP → Logger del Receiver → `MessageAttributes.correlationId` + body SQS → Logger del Processor → todos los downstream logs.
- [x] **J.3** Métricas custom emitidas vía EMF: `PagosProcesados`, `PagosFallidos`, `LatenciaProcesado` con dimensiones `Pasarela=PAYHUB`, `Stage`.
- [x] **J.4** X-Ray con `captureAWSv3Client` + helper `withSubsegment` aplicado a `putIdempotencyKey`, `enqueueWebhook`, `persistPago` con annotations de negocio.
- [x] **J.5** `OBSERVABILITY.md` completo: estructura logs con ejemplo JSON; métricas (3 emitidas + derivadas + automáticas); traces (auto + custom con subsegments listados); alarmas en 3 niveles (críticas, warnings, informativas) con métrica/umbral/justificación; cómo investigar 2 escenarios de incidente; tabla de costos.

## K. Tarea 8 — Docs + script E2E (~30 min)

- [x] **K.1** `README.md` 250+ líneas con: quick start, arquitectura ASCII, estructura del repo, prerrequisitos, setup detallado, uso (curl + invoke + e2e), tests, mapeo rúbrica→código, lo NO entregado, AI usage, preguntas anticipadas para revisión en vivo. Links a `CLAUDE/REQUIREMENTS/METHODOLOGY/DECISIONS/OBSERVABILITY/AI_USAGE.md`.
- [x] **K.2** `scripts/e2e-test.sh` ejecutable, sintaxis bash validada. 10 tests: 5 webhooks válidos (202), 2 duplicados (200 already_processed), 1 firma inválida (401), 1 header faltante (400), 1 body inválido (400). Salida colorizada, asserts de status + body content, exit code 0/1 según fallos.
- [x] **K.3** `DECISIONS.md` con 18 trade-offs documentados (D1–D18), incluyendo decisiones de stack, IaC, idempotencia, observabilidad, y limitaciones conocidas (D17, D18).

## L. Decisiones técnicas a justificar (DECISIONS.md)

- [x] **L.1** SQS estándar vs FIFO (D7).
- [x] **L.2** `PAY_PER_REQUEST` vs `PROVISIONED` (D11).
- [x] **L.3** `batchSize: 5` y `maximumBatchingWindow: 1` (D8).
- [x] **L.4** `maxReceiveCount: 3` (D9).
- [x] **L.5** Visibility timeout 300 s (D10).
- [x] **L.6** Propagación del correlation ID documentada en `OBSERVABILITY.md` sección 1, implementada en Receiver y Processor.
- [x] **L.7** Alarmas propuestas en `OBSERVABILITY.md` sección 4 (críticas/warnings/informativas con umbrales).
- [x] **L.8** Defense in depth: PutItem condicional en Receiver (`attribute_not_exists(idempotencyKey)`) + PutItem condicional en Processor (`attribute_not_exists(transaccionId)` en pagos). Documentado en DECISIONS.md.
- [x] **L.9** Lo NO entregado documentado en README sección "Lo NO entregado y por qué": 9 ítems agrupados en "Implementado pero NO en producción" y "Decisiones deliberadas de NO hacer".

## M. Calidad transversal

- [ ] **M.1** Coverage de tests ≥ 70% (configurado en jest/vitest).
- [ ] **M.2** Cero `Resource: '*'` en IAM (`grep` en el IaC que falle si aparece).
- [ ] **M.3** Cero `console.log` directos (todo vía Logger).
- [ ] **M.4** Stack traces nunca expuestos en respuestas HTTP del Receiver.
- [ ] **M.5** Tipos TS estrictos: sin `any` salvo en mocks de tests con justificación.
- [ ] **M.6** Lint pasa limpio (configuración mínima: `tsc --noEmit`).
- [ ] **M.7** `e2e-test.sh` corre limpio contra el stack local.

## N. Pruebas locales (entorno docker-compose)

- [x] **N.1** `docker-compose.yml` con DynamoDB Local 2.5.2 + ElasticMQ 1.5.7 y healthchecks.
- [x] **N.2** Script `scripts/bootstrap-local.sh` crea tablas DDB con TTL; colas SQS pre-creadas vía `scripts/elasticmq.conf` con redrive policy.
- [~] **N.3** `serverless-offline` configurado en `serverless.yml` para `localhost:3000`. _Verificación pendiente: requiere `npm install` + `docker compose up`._
- [ ] **N.4** Tests unitarios corren sin Docker — pendiente Fases 3-5.
- [ ] **N.5** README documenta el flujo end-to-end — pendiente Fase 6.

---

## O. Fixtures del template (`Template_B2_Serverless/sample-events/`)

- [~] **O.1** `valid-webhook.json` invocado vía `npm run invoke:receiver:valid` (requiere reemplazar `[REEMPLAZAR_CON_HMAC_REAL]` con HMAC real). El fixture es un evento de tipo SQS, NO API Gateway — útil para invocación local pero el flujo real (con HMAC válido) se prueba mejor con `e2e-test.sh`.
- [x] **O.2** `invalid-signature.json` → comportamiento esperado validado en tests de Receiver (test "rechaza con 401 si la firma no coincide").
- [x] **O.3** `duplicate-event.json` → comportamiento validado en test "responde 200 sin encolar cuando idempotencyKey ya existe".
- [x] **O.4** `batch-partial-failure.json` → **test "replica exactamente el fixture batch-partial-failure.json de Altera"** lee el JSON real e invoca el Processor; verifica `batchItemFailures: [{itemIdentifier: 'msg-103'}]` y 4 PutCommand a DDB.
- [x] **O.5** `Template_B2_Serverless/scripts/firmar-evento.sh` documentado en README para generar HMAC. El `e2e-test.sh` propio reemplaza esa necesidad (firma inline con `openssl dgst`).
