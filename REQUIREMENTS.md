# REQUIREMENTS.md — Checklist verificable

> Mapeo 1-a-1 de los requisitos del enunciado (`Prueba_Personalizada_C04_Juan_Pablo_Lira_B2.docx` + `Template_B2_Serverless/`) a entregables concretos. Cada ítem es verificable.
>
> Convención: `[ ]` = pendiente · `[x]` = hecho · `[~]` = en progreso · `[!]` = bloqueado o renunciado (documentar en README).

---

## A. Reglas administrativas y de proceso

- [ ] **A.1** Correo de entrega con asunto que incluya `ALT-B2-0526-C04`.
- [ ] **A.2** Plazo cumplido: lunes 25 de mayo de 2026.
- [ ] **A.3** Mínimo 5 commits incrementales con mensajes claros (no monolíticos).
- [ ] **A.4** Uso de AI assistants documentado en README con detalle (prompts, qué generó la IA, qué decidió el candidato).
- [ ] **A.5** Repo entregable es desplegable con un comando IaC (no requiere desplegar de verdad).
- [ ] **A.6** README explicita lo no entregado con la fórmula "No alcancé X porque..." cuando aplique.

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

- [ ] **F.1** `src/lib/hmac.ts` exporta `verifySignature(body: string, signature: string, secret: string): boolean`.
- [ ] **F.2** Implementación usa `crypto.createHmac('sha256', secret).update(body).digest('hex')`.
- [ ] **F.3** Comparación con `crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'))`.
- [ ] **F.4** Si las longitudes difieren → `return false` sin throw.
- [ ] **F.5** Body vacío o signature vacía → `return false` sin reventar.
- [ ] **F.6** Cero `===` para comparar HMAC en todo el repo (`grep` que falle si aparece).
- [ ] **F.7** Tests unitarios: firma válida, firma inválida, lengths distintas, body vacío, signature en formato no-hex.

## G. Tarea 4 — Receiver Lambda (~45 min)

- [ ] **G.1** Handler en `src/handlers/receiver.ts` exporta `handler: APIGatewayProxyHandlerV2`.
- [ ] **G.2** Paso 1: extraer y verificar firma HMAC. Si falla → log de aviso, respuesta **401** con body genérico (sin stack trace), sin escribir Dynamo, sin encolar.
- [ ] **G.3** Paso 2: validar presencia de los 3 headers obligatorios. Falta alguno → **400** con mensaje genérico.
- [ ] **G.4** Paso 3: parsear body con Zod. Si falla → **400** con mensaje genérico.
- [ ] **G.5** Paso 4: `PutCommand` en `idempotency_keys` con `ConditionExpression: 'attribute_not_exists(idempotencyKey)'`, items: `idempotencyKey`, `transaccionId`, `status: 'received'`, `createdAt`, `ttl = floor(now/1000)+86400`.
- [ ] **G.6** Paso 5: `SendMessageCommand` a SQS principal con el body del evento (incluir `idempotencyKey` y `transaccionId` para correlation downstream).
- [ ] **G.7** Paso 6: respuesta **202** con `{ status: 'accepted', idempotencyKey }`.
- [ ] **G.8** Camino duplicado: `ConditionalCheckFailedException` capturado → respuesta **200** con `{ status: 'already_processed', idempotencyKey }`. NO encolar.
- [ ] **G.9** Camino error inesperado: respuesta **500** con `{ status: 'internal_error' }`. NO exponer stack.
- [ ] **G.10** Powertools Logger inicializado con `correlationId = X-PayHub-Idempotency-Key` (o `awsRequestId` como fallback).
- [ ] **G.11** Powertools Tracer envuelve las llamadas a DDB y SQS.
- [ ] **G.12** Tests con `aws-sdk-client-mock`: happy path 202, firma inválida 401, headers faltantes 400, body inválido 400, duplicado 200, fallo DDB inesperado 500.

## H. Tarea 5 — Processor Lambda (~45 min)

- [ ] **H.1** Handler en `src/handlers/processor.ts` exporta `handler: SQSHandler`.
- [ ] **H.2** Itera `event.Records`. Por cada uno: deserializar body, validar con Zod, persistir en `pagos` con `PutCommand` (incluir `idempotencyKey`).
- [ ] **H.3** Simulación de fallo transient: 5% de probabilidad → lanza error simulado de "external API timeout".
- [ ] **H.4** Captura de error por mensaje: agrega a `batchItemFailures: [{ itemIdentifier: record.messageId }]` y CONTINÚA con los siguientes (no rompe el batch entero).
- [ ] **H.5** Retorna `{ batchItemFailures }` (NO `throw`).
- [ ] **H.6** Métricas custom Powertools: `PagosProcesados` (Count), `PagosFallidos` (Count), `LatenciaProcesado` (Milliseconds). Dimensión `Pasarela=PAYHUB` y `Stage=${stage}`.
- [ ] **H.7** Tracer envuelve las llamadas a DDB con segmentos custom (`PutPago`).
- [ ] **H.8** Correlation ID propagado: el Receiver lo serializa dentro del body o como `messageAttributes.correlationId`; el Processor lo extrae y lo setea en el Logger antes de loguear.
- [ ] **H.9** Tests: batch happy path (5 OK), batch con 1 fallo transient (4 OK + 1 en `batchItemFailures`), batch con JSON inválido en uno (replicar `batch-partial-failure.json` → `msg-103` en `batchItemFailures`).

## I. Tarea 6 — DynamoDB design (~30 min)

- [x] **I.1** `idempotency_keys` definida en IaC: PK `idempotencyKey` (S). Atributos `transaccionId`, `status`, `createdAt`, `ttl` se escriben desde el código (Fase 4).
- [x] **I.2** TTL habilitado sobre atributo `ttl` (24 h se calculan en código en Fase 4).
- [x] **I.3** `pagos` definida en IaC: PK `transaccionId` (S), SK `timestamp` (S). Atributos restantes se escriben desde el código (Fase 5).
- [x] **I.4** Billing mode `PAY_PER_REQUEST` en ambas tablas.
- [x] **I.5** Decisión "estándar vs FIFO" documentada en `DECISIONS.md` (D7) con trade-offs explícitos.
- [x] **I.6** Decisión "sin GSI inicial" documentada en `DECISIONS.md` (D13) con plan de escalado.

## J. Tarea 7 — Observabilidad (~45 min)

- [ ] **J.1** Logs JSON estructurados con `@aws-lambda-powertools/logger` en ambos handlers.
- [ ] **J.2** Correlation ID propagado: presente en cada log line, tanto en Receiver como en Processor.
- [ ] **J.3** Métricas custom emitidas vía `@aws-lambda-powertools/metrics` con dimensiones `Pasarela=PAYHUB` y `Stage=${stage}`.
- [ ] **J.4** X-Ray con `tracer.getSegment()` y subsegmentos custom alrededor de operaciones DDB.
- [ ] **J.5** `OBSERVABILITY.md` documenta:
  - estructura de logs (campos, ejemplo).
  - métricas (nombre, unidad, dimensiones, qué responde cada una).
  - traces (subsegmentos esperados, qué se mide).
  - alarmas sugeridas: `DLQSize > 0`, `ErrorRate > 1%`, `p99Latency > X ms`, `IdempotencyConflictRate` (informativa).

## K. Tarea 8 — Docs + script E2E (~30 min)

- [ ] **K.1** `README.md` incluye:
  - descripción funcional y diagrama.
  - prerrequisitos (Node, Docker).
  - setup local (`npm install`, `docker-compose up`, `npm run dev`).
  - cómo invocar local: `serverless invoke local` y curl ejemplo.
  - cómo correr tests y coverage.
  - decisiones técnicas (link a `DECISIONS.md` y `OBSERVABILITY.md`).
  - sección "Uso de AI assistants" con detalle.
  - sección "Trabajo pendiente / lo no entregado".
- [ ] **K.2** `scripts/e2e-test.sh`:
  - ejecutable (`chmod +x`).
  - 10 invocaciones curl al endpoint local.
  - incluye al menos 2 duplicados explícitos (mismo `Idempotency-Key`) para validar idempotencia.
  - incluye 1 firma inválida (espera 401).
  - imprime resultado por request (status code esperado vs recibido).
  - exit code != 0 si alguna assertion falla.
- [ ] **K.3** `DECISIONS.md` con los trade-offs justificados.

## L. Decisiones técnicas a justificar (DECISIONS.md)

- [x] **L.1** SQS estándar vs FIFO (D7).
- [x] **L.2** `PAY_PER_REQUEST` vs `PROVISIONED` (D11).
- [x] **L.3** `batchSize: 5` y `maximumBatchingWindow: 1` (D8).
- [x] **L.4** `maxReceiveCount: 3` (D9).
- [x] **L.5** Visibility timeout 300 s (D10).
- [ ] **L.6** Propagación del correlation ID — pendiente Fase 4/5.
- [ ] **L.7** Alarmas propuestas y umbrales — pendiente Fase 5/7 (`OBSERVABILITY.md`).
- [ ] **L.8** Defense in depth — pendiente Fase 4/5 con la implementación.
- [ ] **L.9** Lo que NO se hizo y por qué — sección viva, se cierra en Fase 6 con el README.

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

- [ ] **O.1** `valid-webhook.json` invocado contra Receiver local → 200/202 + item en DDB + mensaje en SQS.
- [ ] **O.2** `invalid-signature.json` → 401, sin item en DDB, sin mensaje en SQS.
- [ ] **O.3** `duplicate-event.json` (mismo `eventoId` que valid) → 200 `already_processed`, sin segundo mensaje en SQS.
- [ ] **O.4** `batch-partial-failure.json` invocado contra Processor local → 4 items en `pagos`, response `{ batchItemFailures: [{ itemIdentifier: 'msg-103' }] }`.
- [ ] **O.5** `scripts/firmar-evento.sh` usado para generar HMAC y reemplazar `[REEMPLAZAR_CON_HMAC_REAL]` en los fixtures.
