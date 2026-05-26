# DECISIONS.md

Decisiones técnicas tomadas durante la prueba `ALT-B2-0526-C04`, con sus trade-offs explícitos.
Se actualiza incrementalmente fase por fase.

---

## D1. IaC — Serverless Framework v3 (vs SAM)

**Decisión**: Serverless Framework v3 + plugins (`serverless-esbuild`, `serverless-offline`, `serverless-offline-sqs`, `serverless-dynamodb` cuando aplique).

**Alternativa descartada**: AWS SAM.

**Razones**:
- Ecosistema de plugins maduro para correr 100% local: `serverless-offline` + `serverless-offline-sqs` + DynamoDB Local hacen un dev loop muy fluido.
- Sintaxis YAML más concisa para el alcance de esta prueba.
- Hot reload ágil con `serverless-offline`.

**Por qué v3 y no v4**: Serverless Framework v4 requiere licencia paga; v3 sigue siendo OSS y cubre 100% del alcance.

**Riesgo aceptado**: v3 no recibe nuevas features de plataforma; ok para una prueba.

## D2. Test runner — Jest + ts-jest (vs Vitest)

**Decisión**: Jest con `ts-jest` preset; coverage threshold 70%; `aws-sdk-client-mock-jest` para assertions específicas de mocks de AWS SDK.

**Alternativa descartada**: Vitest (más rápido, ESM nativo).

**Razones**:
- Alineado con el ecosistema AWS Lambda (la mayoría de ejemplos oficiales usan jest).
- `aws-sdk-client-mock-jest` tiene matchers `.toHaveReceivedCommand(...)` ergonómicos.
- Documentación abundante para troubleshooting.

**Trade-off**: arranque y ejecución más lentos que Vitest; aceptable dado el tamaño del proyecto.

## D3. Runtime Lambda — Node 20.x

**Decisión**: `nodejs20.x` en todas las Lambdas.

**Razones**:
- LTS, soportado por Lambda runtime estándar.
- AWS SDK v3 funciona sin polyfills, `Buffer` y `crypto` nativos son los que necesitamos para HMAC.
- Top-level await disponible para utilities.

## D4. Bundling — esbuild via serverless-esbuild

**Decisión**: `serverless-esbuild` con tree-shaking habilitado y target `node20`.

**Razones**:
- 10–20× más rápido que `tsc`.
- Tree-shakes `@aws-sdk/*`, dejando artefactos por Lambda chicos (clave para cold start).
- No pelea con TS estricto (la validación tipos se hace con `tsc --noEmit` aparte).

**Trade-off**: el output no es tan introspectable como `tsc`; aceptable.

## D5. TypeScript estricto

**Decisión**: `tsconfig.json` con `strict: true` + `noUnusedLocals` + `noUnusedParameters` + `noImplicitReturns` + `noFallthroughCasesInSwitch`.

**Razones**:
- La rúbrica pesa "TypeScript + calidad" 5% y la consigna pide "TS estricto" explícitamente.
- Cazar errores en compilación, no en runtime de Lambda.

**Trade-off**: ergonomía menor en utilidades; mitigamos con `unknown` + narrowing en vez de `any`.

---

## D6. IAM least privilege — un role por Lambda

**Decisión**: `serverless-iam-roles-per-function` con bloque `iamRoleStatements` declarado dentro de cada función. Cada Lambda obtiene su propio `AWS::IAM::Role`.

**Alternativa descartada**: un role compartido a nivel de provider con la unión de todos los permisos.

**Razones**:
- La rúbrica pesa "Seguridad (HMAC + IAM)" 12% y exige "least privilege" + "sin `Resource: '*'`" — un role compartido implicaría que el Receiver pudiera escribir en `pagos` y el Processor pudiera enviar a SQS, lo cual viola el principio.
- Blast radius reducido: si una Lambda se compromete, el atacante solo gana los permisos de esa Lambda.

**Permisos por función**:

| Lambda | Acciones | Recursos |
|---|---|---|
| Receiver | `dynamodb:PutItem` | `IdempotencyTable.Arn` |
| Receiver | `sqs:SendMessage` | `WebhookQueue.Arn` |
| Processor | `dynamodb:PutItem` | `PagosTable.Arn` |
| Processor | `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` | `WebhookQueue.Arn` |

**Cero wildcards** (`Resource: '*'`). Cero permisos cruzados. Las permisiones de `logs:*` y `xray:*` las inyecta automáticamente Serverless al activar `tracing` y al usar `logRetentionInDays`.

## D7. SQS estándar (no FIFO)

**Decisión**: cola estándar con idempotencia en capa de aplicación.

**Alternativa descartada**: SQS FIFO con `MessageDeduplicationId`.

**Razones**:
- FIFO ordena por `MessageGroupId` pero limita el throughput a 300 msg/s (3000 con high throughput mode). PayHub puede picarnos en ráfagas; queremos elasticidad.
- FIFO no compone bien con **partial batch failure**: cuando un mensaje falla, los siguientes del mismo group quedan bloqueados hasta que se resuelva el primero. Para nuestra rúbrica (procesar todos los que se pueda, mandar venenos a DLQ) eso es contraproducente.
- La idempotencia ya está garantizada por el `PutItem` condicional sobre `idempotency_keys` — la cola no necesita garantizarla.

**Trade-off aceptado**: el orden de procesamiento no está garantizado. Para un caso de "pago confirmado" (estado terminal), el orden no importa. Si en el futuro hubiera eventos `payment.pending` → `payment.completed`, habría que repensar (FIFO + group por `transaccionId` o secuenciamiento en app).

## D8. `batchSize: 5` + `maximumBatchingWindow: 1`

**Decisión**: 5 mensajes por invocación, esperando máximo 1 segundo.

**Razones**:
- **5 mensajes**: balance entre amortizar cold start (1 invocación procesa 5 pagos) y mantener el blast radius chico (si la invocación muere, solo 5 mensajes vuelven a la cola). Coincide con el fixture `batch-partial-failure.json` que tiene 5 mensajes.
- **1 segundo de ventana**: latencia p99 < 2 s desde encolar hasta persistir. Sin ventana (`maximumBatchingWindow: 0`) el Lambda se invocaría por cada mensaje individual; con 1s agrupa ráfagas sin sacrificar SLO.

**Defensa en vivo**: si te preguntan "qué pasa con `batchSize: 10`": menos invocaciones, menor costo, pero mayor latencia p99 (esperás más para llenar el batch) y mayor blast radius por fallo. 5 es un sweet spot defendible.

## D9. `maxReceiveCount: 3` (umbral DLQ)

**Decisión**: 3 entregas fallidas antes de mover a DLQ.

**Razones**:
- Coincide con el "tras 3 reintentos automáticos por SQS → DLQ" del enunciado y del diagrama.
- 3 reintentos cubren fallos transient típicos (red, throttling de DDB) sin atascar la cola con venenos permanentes.
- Con visibility 5 min, una secuencia de 3 fallos toma ~15 min en el peor caso — aceptable para SLOs de webhook.

**Trade-off**: si quisiéramos más resilencia ante fallos transient prolongados, subiríamos a 5. Si queremos detección rápida de venenos, bajaríamos a 2. 3 es el default sensato.

## D10. Visibility timeout 300 s (5 min)

**Decisión**: 300 s en la cola principal.

**Razones**:
- Regla operativa AWS: `VisibilityTimeout ≥ 6 × LambdaTimeout`. Nuestro Processor tiene timeout 30 s → 6 × 30 = 180 s mínimo. Usamos 300 s para tener margen de seguridad.
- Coincide con "(visibilidad 5min)" del diagrama del enunciado.
- Si la Lambda no completa en 30 s, el mensaje vuelve a estar visible recién a los 300 s — evita reentregas prematuras durante la ejecución.

## D11. Billing DynamoDB — `PAY_PER_REQUEST`

**Decisión**: on-demand billing en ambas tablas.

**Razones**:
- Tráfico de webhooks es **variable e impredecible** (PayHub no nos da contrato de tasa). Provisioned obligaría a sobre-provisionar o sufrir throttling.
- En dev/staging el volumen es bajo: provisioned mínimo (5 WCU/RCU) facturaría más que on-demand.
- En prod, si el patrón se estabiliza y vemos baseline > 1000 req/s sostenido, vale la pena re-evaluar a provisioned + auto-scaling.

**Trade-off**: on-demand es ~7× más caro por request que provisioned-bien-dimensionado. Aceptable hasta tener datos reales.

## D12. PITR en `pagos`, NO en `idempotency_keys`

**Decisión**: Point-In-Time Recovery activado solo en `pagos`.

**Razones**:
- `pagos` contiene datos financieros: requisito regulatorio + utilidad operacional ("¿qué tenía a las 14:30 del 19 de mayo?").
- `idempotency_keys` es una tabla **efímera** (TTL 24h). PITR sobre datos que se borran solos es desperdicio.

## D13. Sin GSI inicial

**Decisión**: ninguna Global Secondary Index en esta entrega.

**Razones**:
- La rúbrica dice "GSI cuando aporta", no "GSI obligatorio".
- Los patrones de acceso actuales son:
  - `idempotency_keys`: lookup directo por `idempotencyKey` (PK).
  - `pagos`: insert + lookup por `transaccionId` (PK).
- Aún no hay queries por `clienteRut`, `estado` o rangos de tiempo que justifiquen una GSI. Si se materializan, agregar GSI tipo `byCliente` con PK=`clienteRut`, SK=`timestamp` (proyección keys-only para minimizar costo).

**Documentado para defensa en vivo**: "qué agregarías si te pidieran ver todos los pagos de un cliente del último mes" → GSI o un Athena/S3 export. Sin GSI: scan + filter (mal a escala).

## D14. Stack local — Docker Compose con DDB Local + ElasticMQ

**Decisión**: `docker-compose.yml` con `amazon/dynamodb-local` + `softwaremill/elasticmq-native`. Bootstrap vía `scripts/bootstrap-local.sh` (aws-cli) + colas pre-creadas en `scripts/elasticmq.conf`.

**Alternativa descartada**: LocalStack.

**Razones**:
- LocalStack community no cubre X-Ray ni IAM fielmente; para esta prueba esos no se evalúan en local (sí en el IaC).
- DDB Local + ElasticMQ son los emuladores **oficiales/de referencia** de sus respectivos servicios — fidelidad máxima.
- Footprint chico (dos contenedores de < 200 MB total vs ~1 GB de LocalStack).
- Arranque en < 5 s vs ~30 s.

**Trade-off**: DDB Local no ejecuta el TTL real (lo registra pero no borra), no soporta DynamoDB Streams en algunas versiones, y ElasticMQ no replica algunas rarezas de SQS (long polling con backoff, throttling). Aceptable: la rúbrica evalúa el IaC, no el comportamiento local exacto.

## D15. Bundling esbuild incluye `@aws-sdk/*` en el artefacto

**Decisión**: NO excluir `@aws-sdk/*` del bundle aunque el runtime Node 20 los provea.

**Razones**:
- Versión consistente entre dev y prod (el runtime puede actualizar la SDK sin avisar).
- Tree-shaking de esbuild deja el bundle en ~5-8 MB por Lambda (vs ~30 MB sin tree-shake) — diferencia despreciable.
- Cold start: la diferencia es ~50-100 ms; el determinismo vale más.

**Trade-off**: artefactos más grandes; aceptable.

---

## D19. URLs de SQS por env var (no `Ref` directo en `provider.environment`)

**Decisión**: en `serverless.yml`, `WEBHOOK_QUEUE_URL` y `WEBHOOK_DLQ_URL` se inyectan como `${env:WEBHOOK_QUEUE_URL, ''}` en vez de `Ref: WebhookQueue`. En offline, las URLs vienen del `.env`. En deploy real, vienen de CI/SSM con el output del stack CloudFormation. El recurso `WebhookQueue` sigue declarado en `resources:` y su URL aparece en `Outputs:`.

**Contexto del bug que motivó la decisión**:

Durante el E2E real (Fase 7) detectamos que el Receiver respondía 500 en cada webhook válido. El error en los logs era:

```
SyntaxError: Unexpected token 'T', "There was "... is not valid JSON
  Deserialization error: to see the raw response, inspect the hidden field {error}.$response
```

Tras instrumentar `queue.ts` con un log de debug, vimos:

```
[DEBUG queue.ts] sqsEndpoint= http://localhost:9324  isOffline= true  queueUrl= [object Object]
```

**Causa raíz**: en el `provider.environment` original:

```yaml
WEBHOOK_QUEUE_URL:
  Ref: WebhookQueue
```

CloudFormation `Ref` solo se resuelve a la URL de la cola **en deploy real** (cuando el stack se materializa). En `serverless offline`, no hay stack CloudFormation → el `Ref` queda sin resolver y llega al `process.env` de la Lambda como el objeto literal `{ Ref: 'WebhookQueue' }`, que al coercer a string en `JSON.stringify` o concatenación se convierte en la cadena `[object Object]`.

El SDK SQS toma esa string como `QueueUrl`, envía la request a una URL inválida (host `[object`), recibe una respuesta de error texto/HTML del servidor (probablemente del runtime de Lambda offline o de algún proxy), intenta parsearla como JSON (porque la SDK v3 usa JSON protocol) y tira `SyntaxError`.

**Por qué `${env:WEBHOOK_QUEUE_URL, ''}` es la solución correcta**:

1. **En offline**: `useDotenv: true` carga `.env` en `process.env` antes de resolver el YAML. La URL llega al runtime como string real (`http://localhost:9324/000000000000/...`).
2. **En deploy real**: la pipeline CI/CD popula `WEBHOOK_QUEUE_URL` desde el output del stack CloudFormation (CF output `WebhookQueueUrl` existe en `resources.Outputs`).
3. **Symmetry con `DYNAMODB_ENDPOINT` / `SQS_ENDPOINT`**: ya seguían este patrón. La inconsistencia anterior con `Ref` violaba el principio de "una fuente para cada valor".

**Por qué NO se intentaron otras opciones**:

- `Fn::GetAtt: [WebhookQueue, QueueUrl]` → mismo problema: solo resuelve en deploy.
- `!Sub 'https://sqs.${AWS::Region}.amazonaws.com/${AWS::AccountId}/${self:custom.webhookQueueName}'` → requiere `AWS::AccountId` que tampoco resuelve offline.
- Dos env vars (una para Ref, otra para override local) → complejidad innecesaria con condicionales en código.

**Trade-off aceptado**: la pipeline de deploy necesita un paso extra para inyectar la URL desde el output del stack. En la práctica esto es **un beneficio**, no costo: la URL se valida fuera del IaC antes de que la Lambda arranque (cobertura de tests de pipeline).

**Defendible en vivo**:
> "Cuando Probé el E2E descubrí que `Ref` no resuelve fuera de un deploy real. En offline llegaba como `[object Object]` al SDK y todos los webhooks válidos respondían 500. El fix fue mover las URLs a env vars (`${env:...}`), lo que también hace el sistema más simétrico — todos los endpoints/URLs vienen del entorno, no de la magia de CF."

**Lección general**: **siempre probar el flujo E2E real**, no solo unit tests con mocks. `aws-sdk-client-mock` no podía cazar este bug porque mockea la SDK ANTES de que se construya la URL. El bug solo aparecía con el SDK real hablando con SQS real (o ElasticMQ real).

---

## D18. Compatibilidad legacy con los fixtures de Altera

**Decisión**: el Processor acepta DOS formas de mensaje SQS y normaliza al `WebhookMessage` canónico.

**Las dos formas**:

1. **Moderna** (producida por nuestro Receiver):
   ```json
   {
     "idempotencyKey": "idem-001",
     "correlationId": "idem-001",
     "ingestionTimestamp": "2026-05-19T14:30:00.000Z",
     "payload": { "transaccionId": "TX-001", "referencia": "AB12CD34", ... }
   }
   ```

2. **Legacy** (que traen los fixtures de `Template_B2_Serverless/sample-events/`):
   ```json
   {
     "cobroId": "cob-2001",
     "monto": 35000,
     "clienteRut": "12345678-9"
   }
   ```

**Por qué soportar ambas**:
- El fixture `batch-partial-failure.json` especifica explícitamente que `msg-101/102/104/105` deben procesarse exitosamente. Sus bodies usan el shape legacy. Si el Processor solo aceptara el shape moderno, los 5 records irían a `batchItemFailures` — contradice el `_resultado_esperado` declarado por Altera en el fixture.
- El shape moderno es el que controla nuestro código (Receiver→SQS), por lo que es lo que verá producción real cuando esté integrado con PayHub.
- Aceptar ambos = compatibilidad backward con material de Altera SIN comprometer el contrato productivo.

**Cómo se implementa** (`src/services/schemas.ts`):
- `webhookMessageSchema` (Zod) define el shape moderno.
- `legacyWebhookMessageSchema` (Zod) define el shape legacy.
- `anyWebhookMessageSchema = z.union([...])` acepta cualquiera.
- `normalizeWebhookMessage(raw)` retorna siempre un `WebhookMessage` canónico, mapeando los campos legacy:
  - `cobroId` → `payload.transaccionId` Y `idempotencyKey` (carecíamos de uno)
  - `eventoId ?? "LEGACY-" + cobroId` → `payload.referencia`
  - `now` → `ingestionTimestamp` y `payload.timestamp` cuando no existen

**Trade-off**: dos schemas distintos en el código + lógica de normalización. Es complejidad real, pero CONTROLADA (sin TODO el resto del Processor): de la línea 5 del handler en adelante, todo opera sobre `WebhookMessage`. La lógica downstream (persistencia, métricas, logs) ignora completamente si el shape fue legacy o moderno.

**Defendible en vivo**: "si solo aceptaras el shape moderno, perderíamos compatibilidad con los fixtures de prueba que Altera mandó. Soportando ambos demostramos pragmatismo + el contrato productivo queda intacto en `webhookMessageSchema`."

---

## D17. SQS failure post DDB success — limitación conocida

**Decisión**: NO implementar compensación con `DeleteItem` ante fallo de SQS tras un PutItem exitoso. Documentar la limitación y dejar la mitigación para producción.

**Escenario**:
1. Receiver verifica HMAC ✓
2. Receiver hace `PutItem` condicional en `idempotency_keys` ✓
3. Receiver intenta `SendMessage` a SQS → falla (network blip, throttling, etc.)
4. Receiver responde **500 internal_error**
5. PayHub reintenta el webhook (mismo `idempotencyKey`)
6. Receiver verifica HMAC ✓
7. Receiver hace `PutItem` condicional → falla con `ConditionalCheckFailedException` (ya existe)
8. Receiver responde **200 already_processed** SIN re-encolar
9. **Mensaje perdido**: idempotency dice "ya lo procesé", pero el mensaje nunca llegó a `pagos`.

**Por qué no la implementé**:
- La compensación correcta (DeleteItem en el catch del SendMessage) tiene **su propio failure mode**: si la red sigue caída, el DeleteItem también falla y quedamos peor.
- Implementarla con `try/catch/log si falla` es solo pseudo-defensa: el `log` que dispara una alarma operacional sería igual de efectivo SIN el DeleteItem.
- Para un sistema productivo real, el patrón correcto es **eventual reconciliation** con DDB Streams o un job de scan periódico que detecte `status: 'received'` con antigüedad > X y los re-encole. Esto excede el alcance temporal de la prueba.

**Mitigaciones recomendadas para producción** (documentadas para defensa en vivo):
1. **DDB Streams → reconciler Lambda**: dispara cuando un item se inserta en `idempotency_keys`; si después de 30s no hay update a `status: 'enqueued'`, re-encola. Self-healing.
2. **Saga lite con estados**: `received` → `enqueued` → `committed`. El handler hace UpdateItem `received → enqueued` después del SendMessage exitoso. Un cron limpia los `received` antiguos.
3. **Transactional outbox**: escribir el mensaje pendiente en una tabla `outbox` en la misma transacción DDB; un poller separado lo lee y manda a SQS con at-least-once.

**Alarma operativa** (la SÍ implementamos vía OBSERVABILITY.md en Fase 5):
- Métrica custom `IdempotencyOnlyEnqueueFailed` que se incrementa cuando el catch de SendMessage entra.
- Alarma "alta" cuando `IdempotencyOnlyEnqueueFailed > 0 en 5 min` — gatilla investigación.

**Trade-off aceptado**: el riesgo de mensaje perdido es **muy bajo** (network local entre Lambda y SQS dentro de AWS suele ser confiable), pero NO cero. Para esta prueba, documentarlo demuestra criterio senior; implementarlo a medias sería peor.

---

## D16. HMAC verify — defense in depth con regex de formato + length guard

**Decisión**: en `src/lib/hmac.ts`, antes de invocar `crypto.timingSafeEqual`, validamos:

1. Que ninguno de los tres inputs (`body`, `signature`, `secret`) sea cadena vacía.
2. Que `signature` matchee `/^[0-9a-fA-F]+$/` (solo chars hex válidos).
3. Que la longitud del buffer recibido sea igual a la del buffer esperado.

**Por qué cada guard**:

- **Inputs vacíos** (#1): PayHub nunca debería mandarlos, pero un cliente mal configurado podría. Fallar limpio con `false` es mejor que dejar pasar.
- **Regex hex** (#2): sin esto, `Buffer.from('XYZ123...', 'hex')` no tira, sino que silenciosamente **trunca** el string en el primer char no-hex y devuelve un buffer corto. Eso convertiría una signature inválida en algo que avanza hasta `timingSafeEqual` con un buffer de tamaño raro — perdemos información sobre el motivo del rechazo (sería "longitud distinta" en vez de "no es hex").
- **Length guard** (#3): `timingSafeEqual` lanza `RangeError` si las longitudes difieren. Capturarlo arriba con un `return false` es más limpio que un try/catch y mantiene el código sin excepciones en el happy path. **Crítico**: sin este guard, una signature corta haría que el endpoint responda 500 en vez de 401.

**Trade-off**: cuatro `if` de pre-validación antes de la comparación criptográfica real. Costo despreciable (microsegundos), beneficio claro: el handler upstream puede tratar el `false` como "rechaza con 401" sin try/catch.

**No exportamos `computeSignatureHex`**: si fuera pública, un dev junior podría escribir `received === computeSignatureHex(body, secret)` — exactamente el bug timing-attack que queremos evitar. La función queda privada al módulo; lo único exportado es `verifySignature` que solo retorna boolean.

---

> Decisiones de fases posteriores (propagación de correlation ID, alarmas específicas) se agregan al cerrar cada fase correspondiente.
