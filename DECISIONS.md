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

> Decisiones de fases posteriores (propagación de correlation ID, alarmas específicas) se agregan al cerrar cada fase correspondiente.
