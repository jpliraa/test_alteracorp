# OBSERVABILITY.md

Estrategia de observabilidad del webhook serverless `ALT-B2-0526-C04`.
Tres pilares: **logs estructurados · métricas custom · trazas X-Ray**, todo
integrado con AWS Lambda Powertools v2.

---

## 1. Logs estructurados

### Framework
`@aws-lambda-powertools/logger` — emite JSON a stdout, CloudWatch lo ingiere
nativo. **NO usamos `console.log` directo** en código de producción.

### Estructura de una log line

```json
{
  "timestamp": "2026-05-19T14:30:00.123Z",
  "level": "INFO",
  "service": "prueba-altera-b2",
  "function_name": "prueba-altera-b2-dev-receiver",
  "function_version": "$LATEST",
  "function_memory_size": 512,
  "function_arn": "arn:aws:lambda:us-east-1:...",
  "function_request_id": "req-abc-123",
  "cold_start": false,
  "correlationId": "idem-001",
  "transaccionId": "TX-12345",
  "message": "Webhook aceptado para procesamiento asíncrono",
  "xray_trace_id": "1-..."
}
```

Las claves debajo de `correlationId` son las que **agregamos vía `appendKeys`**
en cada handler — viajan automáticamente en TODA log line subsiguiente de la
misma invocación.

### Claves de contexto inyectadas

| Clave | Origen | Presente en |
|---|---|---|
| `correlationId` | Header `X-PayHub-Idempotency-Key` (Receiver) o `messageAttributes.correlationId` (Processor); fallback `awsRequestId` | TODO log line |
| `transaccionId` | Validado del payload, agregado tras Zod | Logs post-validación |
| `sqsMessageId` | `record.messageId` del trigger SQS | Logs del Processor por record |
| `function_*` | Inyectado por `logger.addContext(context)` | TODO log line |

### Niveles por stage

| Stage | `POWERTOOLS_LOG_LEVEL` |
|---|---|
| dev | DEBUG |
| staging | INFO |
| prod | WARN |
| tests | SILENT |

Configurado en `serverless.yml → custom.logLevel`.

### Propagación del correlation ID (end-to-end)

```
PayHub
  │  X-PayHub-Idempotency-Key: idem-001
  ▼
Receiver Lambda
  │  logger.appendKeys({ correlationId: "idem-001" })       ← se loguea en todo el handler
  │  enqueueWebhook({ correlationId: "idem-001", ... })     ← viaja en el body SQS
  │                                                            y en MessageAttributes
  ▼
SQS Queue
  ▼
Processor Lambda
  │  attrCorr = record.messageAttributes.correlationId      ← prioritario
  │           ?? message.correlationId (body)               ← fallback
  │  logger.appendKeys({ correlationId: "idem-001" })
  │  persistPago(...)  ← logs adentro también tienen el correlationId
  ▼
CloudWatch Logs
```

Buscar todo lo relacionado a un webhook específico:

```
fields @timestamp, level, message
| filter correlationId = "idem-001"
| sort @timestamp asc
```

---

## 2. Métricas custom

### Framework
`@aws-lambda-powertools/metrics` — emite en formato EMF (Embedded Metric Format)
a stdout. CloudWatch detecta el formato y crea las métricas SIN llamadas API
extra (vs `PutMetricData`), ahorrando latencia y costo.

### Dimensiones por defecto

Configuradas en `src/lib/metrics.ts`:

```ts
defaultDimensions: {
  Pasarela: 'PAYHUB',   // requerido por el enunciado
  Stage: 'dev|staging|prod',
}
```

Toda métrica emitida lleva ambas dimensiones automáticamente.

### Métricas emitidas

| Métrica | Tipo | Unidad | Cuándo se emite | Lambda |
|---|---|---|---|---|
| `PagosProcesados` | Counter | Count | Cada record exitoso (incluye duplicados detectados por defense in depth) | Processor |
| `PagosFallidos` | Counter | Count | Cada record que va a `batchItemFailures` | Processor |
| `LatenciaProcesado` | Histogram | Milliseconds | Por record exitoso: `now - ingestionTimestamp` (end-to-end desde Receiver) | Processor |

### Métricas derivadas en CloudWatch

Se calculan a partir de las anteriores sin emisión adicional:

- **Throughput**: `SUM(PagosProcesados) over 1m`
- **Error rate**: `SUM(PagosFallidos) / (SUM(PagosProcesados) + SUM(PagosFallidos))`
- **p50/p99 latency**: `PERCENTILE(LatenciaProcesado, 50/99)`

### Métricas automáticas que CloudWatch ya da gratis

- `AWS/Lambda → Errors, Duration, Throttles, ConcurrentExecutions`
- `AWS/SQS → ApproximateNumberOfMessagesVisible, ApproximateAgeOfOldestMessage`
- `AWS/SQS (DLQ) → ApproximateNumberOfMessagesVisible` ← clave para alarma DLQ
- `AWS/DynamoDB → ConsumedReadCapacity, ConsumedWriteCapacity, UserErrors`

---

## 3. Trazas X-Ray

### Framework
`@aws-lambda-powertools/tracer` con dos niveles de instrumentación.

### Nivel 1 — Auto-instrumentación de clientes AWS SDK

En `idempotency.ts`, `queue.ts`, `payments.ts`:

```ts
const baseClient = new DynamoDBClient({...});
const tracedClient = tracer.captureAWSv3Client(baseClient);
```

→ Cada `ddb.send(...)` genera un subsegment **automático** llamado
`DynamoDB → PutItem` con timing, request/response y errores. Idem para SQS.

### Nivel 2 — Subsegments custom de negocio

Helper `withSubsegment(name, fn)` en `src/lib/tracer.ts`:

```ts
await withSubsegment('persistPago', async (sub) => {
  sub?.addAnnotation('transaccionId', id);
  await ddb.send(...);  // ← auto-subsegment nested aquí
});
```

→ El subsegment `persistPago` agrupa el AWS call y las anotaciones de negocio.
En X-Ray UI se ve la jerarquía:

```
Lambda invocation
  ├─ persistPago [annotation: transaccionId=TX-001]
  │   └─ DynamoDB PutItem
  └─ ...
```

### Subsegments custom emitidos

| Subsegment | Lambda | Annotations |
|---|---|---|
| `putIdempotencyKey` | Receiver | `idempotencyKey`, `transaccionId` |
| `enqueueWebhook` | Receiver | `idempotencyKey`, `correlationId` |
| `persistPago` | Processor | `transaccionId`, `idempotencyKey` |

### Configuración

- `provider.tracing.lambda: true` y `apiGateway: true` en `serverless.yml`.
- IAM policy `AWSXRayDaemonWriteAccess` agregada automáticamente por Serverless.

---

## 4. Alarmas sugeridas

> No las creamos en IaC en esta entrega (out of scope temporal), pero las
> dejamos documentadas para implementación en CloudWatch Alarms o Datadog.

### Críticas (paginan al on-call)

| Alarma | Métrica | Umbral | Por qué |
|---|---|---|---|
| **DLQ tiene mensajes** | `AWS/SQS → ApproximateNumberOfMessagesVisible` (DLQ) | `> 0` por 5 min | Hay venenos sin atender; pago confirmado por PayHub que no se procesó. Riesgo financiero/regulatorio. |
| **Error rate alto** | `SUM(PagosFallidos) / (SUM(PagosProcesados) + SUM(PagosFallidos))` | `> 1%` por 10 min | Algo está fallando sistemáticamente en el Processor. |
| **Latencia p99 alta** | `PERCENTILE(LatenciaProcesado, 99)` | `> 5000 ms` por 5 min | SLO de procesamiento webhook típico (< 5 s p99). Investigar throttling DDB o backpressure SQS. |

### Warnings (Slack)

| Alarma | Métrica | Umbral | Por qué |
|---|---|---|---|
| Cola creciendo | `ApproximateAgeOfOldestMessage` (cola principal) | `> 60 s` por 5 min | El Processor no está sosteniendo el throughput de entrada. |
| Receiver 5xx | `AWS/Lambda → Errors` (filtrado a Receiver) | `> 0` por 5 min | Algo se está respondiendo 500 al cliente PayHub. |
| Receiver 4xx pico | Log Insights: `count(*) where level=WARN and message ~ 'HMAC' or message ~ 'bad_request'` | Spike vs baseline | Posible ataque o cambio de contrato. |
| Throttles DDB | `AWS/DynamoDB → UserErrors` | `> 0` por 5 min | ProvisionedThroughputExceeded. Si pasa con `PAY_PER_REQUEST`, es realmente raro (re-evaluar capacidad). |
| Throttles Lambda | `AWS/Lambda → Throttles` | `> 0` por 5 min | Concurrent execution limit. Subir reserved concurrency. |

### Informativas (dashboard, no alarma)

| Métrica | Para qué |
|---|---|
| `PagosProcesados` rate diario | Capacity planning, billing forecast. |
| Conditional check failures (idempotency) | Cuántos duplicados detecta el Receiver. Spike = PayHub está reintentando demasiado. |
| Conditional check failures (pagos defense in depth) | Cuántas veces SQS at-least-once entregó duplicados. Spike = revisar visibility timeout. |

---

## 5. Dashboards sugeridos

### Dashboard "Webhook Health"
- **Top row**: counters (Procesados, Fallidos, % error) — últimas 24h.
- **Middle row**: time series de Procesados/Fallidos en intervalo 1m.
- **Bottom row**: p50, p95, p99 de LatenciaProcesado.
- **Sidebar**: estado de la DLQ (count + age).

### Dashboard "Webhook Debug"
- Top 20 correlationIds con más logs en la última hora.
- Logs filtrados a level=ERROR.
- Top transaccionIds reintentados (`ApproximateReceiveCount > 1` en SQS).

---

## 6. Cómo investigar un incidente

### Escenario: PayHub reporta "no recibí 200 para idem-001"

1. **CloudWatch Logs**: filtrar `correlationId = "idem-001"` → ver el response del Receiver.
2. Si Receiver respondió 401/400 → ver log warn con el detalle.
3. Si Receiver respondió 202 → el mensaje fue encolado. Buscar logs del Processor con el mismo `correlationId`.
4. Si Processor no procesó → revisar SQS (¿está en visibility timeout? ¿en DLQ?).
5. Si Processor falló → ver `errorName` en el log error → cross-ref con X-Ray para timing.

### Escenario: alarma "Error rate > 1%"

1. Dashboard "Webhook Debug" → ver qué errorName domina.
2. Si todos son `SimulatedTransientFailure` → es el 5% simulado, no es real.
3. Si son `ProvisionedThroughputExceededException` → throttle DDB; subir capacity o agregar retry exponencial.
4. Si son `ConditionalCheckFailedException` no esperados → bug de lógica (la idempotency NO debería fallar en pagos en condiciones normales).

---

## 7. Costos asociados

| Componente | Driver | Costo (referencial us-east-1) |
|---|---|---|
| CloudWatch Logs ingestion | Volume of log bytes | $0.50/GB |
| CloudWatch Logs retention | Storage × días | $0.03/GB/mes |
| CloudWatch custom metrics (EMF) | Metric-name × dimension combos | $0.30/metric/mes después de 10 gratis |
| X-Ray | Traces grabados | $5/M traces grabados |

Decisiones de costo:
- Log retention `dev:14d / staging:30d / prod:90d` (D2 de DECISIONS.md).
- Métricas custom: 3 (PagosProcesados, PagosFallidos, LatenciaProcesado) × 2 dimensiones (Pasarela, Stage) → bien dentro del free tier.
- X-Ray sampling: dejamos default (1 req/s + 5% del resto). Con 1k req/min ≈ 60k traces/mes ≈ gratis.
