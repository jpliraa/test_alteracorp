# CLAUDE.md — Brain del proyecto

> Contexto operativo para sesiones de Claude Code en esta carpeta.
> Fuente: `Prueba_Personalizada_C04_Juan_Pablo_Lira_B2.docx` + `Template_B2_Serverless/`.

---

## 1. Identidad del proyecto

- **Prueba técnica**: Webhook Serverless de Pagos con Idempotencia y DLQ.
- **Empresa**: Altera — Equipo de Innovación y Desarrollo.
- **Cargo postulado**: Desarrollador Backend Senior.
- **Código de prueba**: `ALT-B2-0526-C04` (incluir en el asunto del correo de entrega).
- **Candidato**: Juan Pablo Lira (`jplira@flink.la`).
- **Plazo de entrega**: Lunes 25 de mayo de 2026 (4 días corridos desde la asignación).
- **Tiempo estimado**: 3 horas objetivo; 5–6 horas tope. Si excede, priorizar tareas centrales y documentar lo no entregado.

## 2. Objetivo funcional

PayHub (pasarela externa ficticia) envía webhooks de pago confirmado. Hay que:

1. Recibir el webhook por HTTPS.
2. Validar autenticidad con HMAC-SHA256 (header `X-PayHub-Signature`).
3. Garantizar idempotencia (no procesar dos veces el mismo `eventoId`/`X-PayHub-Idempotency-Key`).
4. Encolar para procesar asíncrono (responder rápido al externo: 200/202).
5. Procesar el pago: persistir en DynamoDB; reintentar con backoff; aislar venenos en DLQ.
6. Observabilidad productiva: logs estructurados, métricas custom, traces X-Ray.

### Contrato del webhook

```
Headers:
  X-PayHub-Signature: <HMAC-SHA256 hex del body con secret>
  X-PayHub-Idempotency-Key: <UUID único por evento>
  X-PayHub-Origin: PAYHUB

Body:
  {
    "transaccionId": "TX-12345",
    "referencia": "AB12CD34",
    "clienteRut": "11.111.111-1",
    "monto": 5000,
    "timestamp": "2026-05-19T14:30:00Z"
  }
```

> Nota: los JSON de `sample-events/` usan el campo `eventoId` y un body alternativo (`cobroId`, `monto`, `clienteRut`). Mantener coherencia con el contrato del .docx en el código real; los samples son fixtures de SQS, no del body HTTP original.

## 3. Arquitectura objetivo

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
                   Processor Lambda  ─PutItem─►  DynamoDB pagos (tabla principal)
                            │
                            └─► CloudWatch (Logs · Metrics · Alarms) + X-Ray
```

> Fuente: diagrama embebido en el .docx (`word/media/image1.png`).

- Receiver = camino crítico, rápido, idempotente, devuelve 200/202.
- Processor = trabajo pesado, con partial batch failure y reintentos automáticos.
- Defense in depth: la idempotencia vive en el Receiver (PutItem condicional) y se refuerza en el Processor (la tabla `pagos` también puede usar `attribute_not_exists(transaccionId)` o registrar `idempotencyKey` para detectar duplicados que cruzaron la cola).

## 4. Stack obligatorio

- **IaC**: Serverless Framework o AWS SAM (cualquiera; debe ser desplegable con `serverless deploy --stage dev` aunque no se despliegue de verdad).
- **Runtime**: Node.js + **TypeScript estricto**.
- **AWS SDK v3**: `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-sqs`.
- **Powertools**: `@aws-lambda-powertools/logger`, `metrics`, `tracer`.
- **Validación**: `zod`.
- **Testing**: `aws-sdk-client-mock` + `jest` o `vitest`, `@types/aws-lambda`. Coverage objetivo ≥ 70%.

## 5. Tareas (todas obligatorias salvo nota)

| # | Tarea                            | Tiempo | Salida principal |
|---|----------------------------------|--------|------------------|
| 1 | Setup inicial                    | 30 min | Proyecto TS + deps instaladas |
| 2 | Plantilla IaC                    | 30 min | `serverless.yml` o `template.yaml` con TODOS los recursos |
| 3 | Verificación HMAC                | 30 min | `verifySignature(body, signature, secret)` con `timingSafeEqual` |
| 4 | Receiver Lambda                  | 45 min | `src/handlers/receiver.ts` con flujo de 6 pasos |
| 5 | Processor Lambda                 | 45 min | `src/handlers/processor.ts` con partial batch failure |
| 6 | DynamoDB design                  | 30 min | Tablas `idempotency_keys` + `pagos`, justificación FIFO en `DECISIONS.md` |
| 7 | Observabilidad                   | 45 min | Logs JSON, métricas custom, X-Ray, `OBSERVABILITY.md` |
| 8 | Documentación + `e2e-test.sh`    | 30 min | README + script bash con 10 invocaciones (incluye duplicados) |

### Detalle por tarea

**T1 — Setup**: TS estricto (`strict: true`), separación `handlers/`, `services/`, `lib/`.

**T2 — IaC**: API Gateway HTTP API expuesto en `POST /webhook`, 2 Lambdas, SQS (visibility timeout 300s = 5 min) + DLQ (`maxReceiveCount: 3`), 2 tablas Dynamo. IAM least privilege (sin `Resource: '*'`). Variables de entorno parametrizadas por stage (`dev`, `staging`, `prod`). `provider.tracing.lambda: true` y `apiGateway: true` (X-Ray).

**T3 — HMAC**:
- `crypto.createHmac('sha256', secret).update(body).digest()`.
- Comparar con `crypto.timingSafeEqual(Buffer.from(received,'hex'), Buffer.from(expected,'hex'))`.
- Si los buffers tienen distinta longitud → `return false` (NO `throw`: `timingSafeEqual` explota si las longitudes difieren).
- Body vacío también debe devolver false sin reventar.
- Tests: válida, inválida, longitudes distintas, body vacío.

**T4 — Receiver** (`src/handlers/receiver.ts`):
1. Verificar firma → 401 si falla (sin escribir en DDB, sin encolar).
2. Validar headers obligatorios.
3. Parsear body con Zod.
4. `PutItem` condicional en `idempotency_keys` con `ConditionExpression: 'attribute_not_exists(idempotencyKey)'`.
5. Enviar a SQS.
6. Responder **202** (nuevo) o **200** con `{ status: "already_processed" }` (duplicado por `ConditionalCheckFailedException`).
- Powertools Logger con correlation ID desde `X-PayHub-Idempotency-Key` (o el header de correlación que definas).
- **Nunca** exponer stack traces al externo.
- Tests con `aws-sdk-client-mock`: happy path, firma inválida, duplicado, body inválido.

**T5 — Processor** (`src/handlers/processor.ts`):
- Event source SQS con `batchSize: 5`, `maximumBatchingWindow: 1`, `functionResponseType: ReportBatchItemFailures`.
- Por cada mensaje: deserializar → persistir en `pagos` → simular llamada externa con **5% de fallo transient** para validar reintento.
- Si falla un mensaje, agregarlo a `batchItemFailures: [{ itemIdentifier: messageId }]` — NO tirar excepción para no perder el batch entero.
- Tras 3 reintentos automáticos por SQS → DLQ.
- Métricas custom: `PagosProcesados`, `PagosFallidos`, `LatenciaProcesado` (dimensión `Pasarela=PAYHUB`).
- Segmentos custom de X-Ray alrededor de las llamadas a DDB.
- Tests: happy path, fallo transient, batch parcialmente fallido (replicando `batch-partial-failure.json`).

**T6 — DynamoDB**:
- Tabla `idempotency_keys`: PK `idempotencyKey`. Atributos: `transaccionId`, `status`, `createdAt`, `ttl`. TTL habilitado sobre `ttl` (24h = `Math.floor(Date.now()/1000) + 86400`).
- Tabla `pagos`: PK `transaccionId`, SK `timestamp`. Atributos: `referencia`, `clienteRut`, `monto`, `estado`, `idempotencyKey`.
- Billing: `PAY_PER_REQUEST` (justificable para tráfico variable).
- `DECISIONS.md` debe explicar: por qué **no** se usó SQS FIFO (o por qué sí). Trade-off: FIFO simplifica orden pero reduce throughput y choca con partial batch failure.

**T7 — Observabilidad**:
- Logs JSON con `Logger` (Powertools), correlation ID propagado en TODOS los logs, incluido el processor (extraerlo del body del mensaje SQS o de un atributo).
- Métricas custom con dimensiones (`Pasarela=PAYHUB`, `Stage=dev/prod`).
- X-Ray segmentos custom con `tracer.getSegment()`.
- `OBSERVABILITY.md`: estructura de logs, métricas, traces, alarmas sugeridas (`DLQ size > 0`, `error rate > 1%`, `p99 latency > X`).

**T8 — Docs + E2E**:
- `README.md`: setup, comandos, ejemplo curl, cómo invocar localmente.
- `e2e-test.sh`: 10 invocaciones curl incluyendo duplicados, valida idempotencia.
- Si se usó AI, documentar qué prompts, qué generó la IA y qué decidió el candidato.

## 6. Reglas y guardrails de la prueba

- **Commits incrementales obligatorios**: mínimo 5 commits con mensajes claros. Un commit gigante = bandera roja.
- **AI assistants permitidos** (Copilot, ChatGPT, Claude) — pero hay que documentarlos en el README con detalle. En la revisión en vivo se piden explicaciones línea a línea y modificaciones en vivo.
- **No hace falta cuenta AWS real ni desplegar de verdad**. Plantilla IaC desplegable es suficiente.
- **"No alcancé X porque..."** es respuesta válida; documentarlo en el README.
- **No exponer stack traces** al externo. HTTP codes correctos.
- **No usar `Resource: '*'`** en IAM. Least privilege siempre.
- **No usar `===`** para comparar HMAC. Solo `timingSafeEqual`.

## 7. Entregables esperados en el repo

```
/
├── src/
│   ├── handlers/
│   │   ├── receiver.ts
│   │   └── processor.ts
│   ├── services/         # lógica de DDB, SQS, validación
│   └── lib/              # utilities (HMAC, logger setup, etc.)
├── tests/                # unit con aws-sdk-client-mock
├── scripts/
│   └── e2e-test.sh
├── serverless.yml        # o template.yaml
├── package.json
├── tsconfig.json
├── README.md             # setup, comandos, decisiones, uso de IA
├── DECISIONS.md          # trade-offs (FIFO, batch size, etc.)
├── OBSERVABILITY.md      # logs/métricas/traces/alarmas
└── .gitignore
```

## 8. Catálogo de fixtures (`Template_B2_Serverless/sample-events/`)

| Archivo                         | Lambda     | Resultado esperado                                                                                  |
|---------------------------------|------------|------------------------------------------------------------------------------------------------------|
| `valid-webhook.json`            | Receiver   | 200 OK · upsert idempotency · enviar a SQS                                                          |
| `invalid-signature.json`        | Receiver   | **401** · NO encolar · NO escribir en DynamoDB                                                       |
| `duplicate-event.json`          | Receiver   | 200 OK · NO encolar · `ConditionalCheckFailedException` capturado en PutItem                         |
| `batch-partial-failure.json`    | Processor  | Procesar #1, #2, #4, #5 → devolver `batchItemFailures: [{ itemIdentifier: 'msg-103' }]`              |

Los archivos traen `[REEMPLAZAR_CON_HMAC_REAL]` en `X-PayHub-Signature`. Generar el HMAC con:

```bash
chmod +x Template_B2_Serverless/scripts/firmar-evento.sh
./Template_B2_Serverless/scripts/firmar-evento.sh '<body-json>' <secret>
```

El script imprime el HMAC en hex para pegarlo en el JSON.

### Invocación local

```bash
# Serverless Framework
serverless invoke local -f receiver  --path Template_B2_Serverless/sample-events/valid-webhook.json
serverless invoke local -f receiver  --path Template_B2_Serverless/sample-events/invalid-signature.json
serverless invoke local -f receiver  --path Template_B2_Serverless/sample-events/duplicate-event.json
serverless invoke local -f processor --path Template_B2_Serverless/sample-events/batch-partial-failure.json

# AWS SAM
sam local invoke ReceiverFunction  --event Template_B2_Serverless/sample-events/valid-webhook.json
sam local invoke ProcessorFunction --event Template_B2_Serverless/sample-events/batch-partial-failure.json
```

## 9. Rúbrica de evaluación (peso %)

| Dimensión                                   | Peso | Qué se mira |
|---------------------------------------------|------|--------------|
| AWS serverless productivo                   | 15%  | Lambdas estructuradas, eventos correctos, memory/timeout sensatos |
| Idempotencia robusta                        | 15%  | PutItem condicional, manejo de `ConditionalCheckFailed`, TTL, defense in depth |
| SQS + DLQ + partial batch failure           | 12%  | Cola configurada, DLQ con `maxReceiveCount`, `reportBatchItemFailures` correcto |
| Seguridad (HMAC + IAM)                      | 12%  | `timingSafeEqual`, IAM sin wildcards |
| IaC completa                                | 10%  | Plantilla parametrizada por stage, sin pasos manuales |
| DynamoDB design                             | 8%   | TTL, PK/SK correctos, GSI cuando aporta |
| Observabilidad                              | 10%  | Logs JSON con correlation ID, métricas custom, X-Ray, `OBSERVABILITY.md` |
| Testing                                     | 10%  | `aws-sdk-client-mock`, happy path + edge cases, coverage ≥ 70% |
| TypeScript + calidad                        | 5%   | Tipos estrictos, error handling consistente, separación handler/services |
| Documentación + script E2E                  | 3%   | README, e2e-test.sh, alarmas documentadas |

**Umbrales**: ≥80% avanza a oferta condicional; 60–79% pasa a panel; <60% no avanza.

## 10. Proceso post-entrega

Tras la entrega hay una **revisión en vivo de 30–45 min** que valida tres cosas:

1. Que el código levanta y funciona end-to-end (juntos en la llamada).
2. Que el candidato entiende a fondo lo entregado: explicación de líneas específicas, justificación de decisiones, anticipación de qué se rompe si cambia X.
3. Que el candidato puede modificar el código en vivo (ej. agregar un campo, cambiar una validación, refactor).

> "La entrega técnica es la mitad de la evaluación; la revisión en vivo es la otra mitad."

## 11. Decisiones técnicas que el README/DECISIONS.md debe justificar

- ¿FIFO Queue o estándar? (estándar + idempotencia es lo esperado, pero hay que justificarlo).
- ¿Por qué `PAY_PER_REQUEST` y no provisioned?
- ¿Batch size 5 y `maximumBatchingWindow: 1`? Trade-off latencia vs throughput.
- ¿`maxReceiveCount = 3` en SQS? Justificar.
- ¿Cómo se propaga el correlation ID desde el header HTTP hasta el processor (que no ve el header original)?
- ¿Qué alarmas se proponen y por qué (DLQ > 0, error rate, latency)?
- ¿Qué NO se hizo y por qué (límite de tiempo, complejidad, etc.)?

## 12. Recordatorios operativos para Claude en esta carpeta

- Esta carpeta **no es un repo git todavía**. **El usuario hará `git init` y todos los commits**; Claude no ejecuta comandos git en esta sesión.
- El `Template_B2_Serverless/` es material de apoyo, **no** el repo a entregar — el repo de entrega se construye al lado o reemplazando esta estructura.
- El shell por defecto es **PowerShell**; usar Bash POSIX vía la herramienta Bash cuando se necesite (`unzip`, `python`, etc. están disponibles vía MSYS).
- Antes de cualquier acción destructiva (rm, reset, force push) confirmar con el usuario.
- Decisiones fijadas (Fase 0): **Serverless Framework v3** para IaC, **Jest + ts-jest** para tests, **Node 20.x** runtime de Lambda.
- Claude propone el mensaje de commit sugerido al cerrar cada fase; el usuario lo ejecuta.
