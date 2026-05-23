# Template — Prueba Backend #2 (Webhook Serverless)

Este paquete incluye eventos SQS de muestra y un helper para firmarlos con HMAC. Te ayuda a probar tu Lambda receiver y processor localmente sin esperar a desplegarlo en AWS real.

## Estructura

```
sample-events/
├── valid-webhook.json          ← evento válido (Receiver: 200, encolar en SQS)
├── invalid-signature.json      ← firma HMAC inválida (Receiver: 401, NO encolar)
├── duplicate-event.json        ← duplicado del primero (Receiver: 200 idempotente, NO encolar)
└── batch-partial-failure.json  ← batch de 5 mensajes con #3 inválido (Processor: partial batch)

scripts/
└── firmar-evento.sh            ← genera HMAC-SHA256 de un body con tu secret
```

## Cómo usar los eventos de muestra

### 1. Invocar tu Lambda localmente con un evento

Con Serverless Framework:

```bash
serverless invoke local -f receiver --path sample-events/valid-webhook.json
serverless invoke local -f receiver --path sample-events/invalid-signature.json
serverless invoke local -f receiver --path sample-events/duplicate-event.json
serverless invoke local -f processor --path sample-events/batch-partial-failure.json
```

Con AWS SAM:

```bash
sam local invoke ReceiverFunction --event sample-events/valid-webhook.json
sam local invoke ProcessorFunction --event sample-events/batch-partial-failure.json
```

### 2. Firmar un evento con HMAC

Los archivos `*.json` tienen `[REEMPLAZAR_CON_HMAC_REAL]` en el header `X-PayHub-Signature`. Generas el HMAC así:

```bash
chmod +x scripts/firmar-evento.sh
./scripts/firmar-evento.sh '{"eventoId":"evt-001","tipo":"payment.completed",...}' tu-payhub-secret
```

El script te imprime el HMAC para que lo pegues en el JSON.

## Comportamientos esperados por tipo de evento

| Evento                       | Receiver λ                                  | Processor λ                                                                |
|------------------------------|----------------------------------------------|----------------------------------------------------------------------------|
| `valid-webhook.json`         | 200 OK · upsert idempotency · enviar SQS    | -                                                                          |
| `invalid-signature.json`     | **401 Unauthorized · NO encolar · NO escribir DynamoDB** | -                                                              |
| `duplicate-event.json`       | 200 OK · NO encolar (idempotente) · `CONDITIONAL_CHECK_FAILED` en PutItem condicional | -                                          |
| `batch-partial-failure.json` | -                                           | Procesar #1, #2, #4, #5 → `batchItemFailures: [{itemIdentifier:'msg-103'}]` |

## Comportamientos importantes a probar manualmente

- **HMAC con `timingSafeEqual`**: usa `crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))`. NO uses `===` (timing attack).
- **PutItem condicional**: la condición debe ser `ConditionExpression: 'attribute_not_exists(eventoId)'`. Si falla, capturas `ConditionalCheckFailedException` y respondes 200 igual.
- **TTL de 24h en idempotency keys**: el item de DynamoDB tiene atributo `ttl` con `Math.floor(Date.now()/1000) + 86400`.
- **Partial batch failure**: tu Processor retorna `{ batchItemFailures: [...] }`. Configura el event source mapping con `FunctionResponseTypes: ['ReportBatchItemFailures']` en `serverless.yml` / `template.yaml`.

## Notas adicionales

- Los `messageId` y `receiptHandle` son ficticios; AWS los reemplaza por valores reales en producción.
- El `eventSourceARN` apunta a una cuenta ficticia (123456789012). Tu IaC define los ARNs reales.
- Para testing con `aws-sdk-client-mock`, no necesitas estos archivos; los usas para invocaciones locales o integration tests.
