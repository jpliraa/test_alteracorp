import { createHmac } from 'node:crypto';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import {
  ConditionalCheckFailedException,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';

// El env setupFile ya seteó PAYHUB_HMAC_SECRET = 'test-secret-payhub'.
const HMAC_SECRET = 'test-secret-payhub';

// Importamos el handler DESPUÉS de mockear globalmente (no es estrictamente
// necesario con aws-sdk-client-mock pero es la convención).
import { handler } from '../../../src/handlers/receiver';

// -----------------------------------------------------------------------------
// Setup mocks
// -----------------------------------------------------------------------------
const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);

beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  // Defaults sanos: ambos clientes resuelven OK salvo que un test los override.
  ddbMock.on(PutCommand).resolves({});
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'sqs-msg-001' });
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const VALID_BODY = {
  transaccionId: 'TX-12345',
  referencia: 'AB12CD34',
  clienteRut: '11.111.111-1',
  monto: 5000,
  timestamp: '2026-05-19T14:30:00Z',
};

function sign(body: string, secret: string = HMAC_SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

interface BuildEventOpts {
  body?: unknown;
  rawBody?: string;
  signature?: string;
  idempotencyKey?: string | null;
  origin?: string | null;
}

function buildEvent(opts: BuildEventOpts = {}): APIGatewayProxyEventV2 {
  const rawBody =
    opts.rawBody !== undefined
      ? opts.rawBody
      : JSON.stringify(opts.body ?? VALID_BODY);

  const signature = opts.signature ?? sign(rawBody);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-payhub-signature': signature,
  };

  if (opts.idempotencyKey !== null) {
    headers['x-payhub-idempotency-key'] = opts.idempotencyKey ?? 'idem-001';
  }
  if (opts.origin !== null) {
    headers['x-payhub-origin'] = opts.origin ?? 'PAYHUB';
  }

  return {
    version: '2.0',
    routeKey: 'POST /webhook',
    rawPath: '/webhook',
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-test',
      domainName: 'api-test.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'api-test',
      http: {
        method: 'POST',
        path: '/webhook',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'PayHub/1.0',
      },
      requestId: 'req-test-001',
      routeKey: 'POST /webhook',
      stage: '$default',
      time: '19/May/2026:14:30:00 +0000',
      timeEpoch: 1747663800000,
    },
    body: rawBody,
    isBase64Encoded: false,
  };
}

function buildContext(): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'prueba-altera-b2-dev-receiver',
    functionVersion: '$LATEST',
    invokedFunctionArn:
      'arn:aws:lambda:us-east-1:123456789012:function:prueba-altera-b2-dev-receiver',
    memoryLimitInMB: '512',
    awsRequestId: 'aws-req-test-001',
    logGroupName: '/aws/lambda/prueba-altera-b2-dev-receiver',
    logStreamName: '2026/05/19/[$LATEST]xxx',
    getRemainingTimeInMillis: () => 30000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

function parseBody(result: unknown): Record<string, unknown> {
  if (
    typeof result === 'object' &&
    result !== null &&
    'body' in result &&
    typeof (result as { body: unknown }).body === 'string'
  ) {
    return JSON.parse((result as { body: string }).body);
  }
  throw new Error(`Unexpected handler response shape: ${JSON.stringify(result)}`);
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('Receiver handler', () => {
  // ===========================================================================
  // Happy path
  // ===========================================================================
  describe('happy path (202 accepted)', () => {
    it('acepta un webhook válido y lo encola en SQS', async () => {
      const event = buildEvent();
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 202 });
      expect(parseBody(result)).toEqual({
        status: 'accepted',
        idempotencyKey: 'idem-001',
      });

      // Validamos los detalles del PutItem condicional.
      expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
        TableName: 'prueba-altera-b2-idempotency-test',
        Item: expect.objectContaining({
          idempotencyKey: 'idem-001',
          transaccionId: 'TX-12345',
          status: 'received',
          createdAt: expect.any(String),
          ttl: expect.any(Number),
        }) as unknown,
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      });

      // El TTL debe ser ~24h en el futuro.
      const putCall = ddbMock.commandCalls(PutCommand)[0];
      const item = putCall?.args[0]?.input?.Item as Record<string, unknown>;
      const ttl = item['ttl'] as number;
      const nowSec = Math.floor(Date.now() / 1000);
      expect(ttl).toBeGreaterThanOrEqual(nowSec + 24 * 3600 - 5);
      expect(ttl).toBeLessThanOrEqual(nowSec + 24 * 3600 + 5);

      // Y la cola debe haber recibido el mensaje envuelto en WebhookMessage.
      expect(sqsMock).toHaveReceivedCommandWith(SendMessageCommand, {
        QueueUrl:
          'https://sqs.us-east-1.amazonaws.com/123456789012/prueba-altera-b2-webhook-test',
        MessageBody: expect.any(String) as unknown,
      });

      const sqsCall = sqsMock.commandCalls(SendMessageCommand)[0];
      const messageBody = JSON.parse(
        sqsCall?.args[0]?.input?.MessageBody as string,
      );
      expect(messageBody).toMatchObject({
        idempotencyKey: 'idem-001',
        correlationId: 'idem-001',
        ingestionTimestamp: expect.any(String) as unknown,
        payload: VALID_BODY,
      });
    });

    it('acepta cuando el monto es decimal (no .int)', async () => {
      const event = buildEvent({
        body: { ...VALID_BODY, monto: 5000.55 },
      });
      const result = await handler(event, buildContext(), () => {});
      expect(result).toMatchObject({ statusCode: 202 });
    });
  });

  // ===========================================================================
  // 401 — HMAC inválido
  // ===========================================================================
  describe('401 unauthorized — HMAC inválido', () => {
    it('rechaza con 401 si la firma no coincide', async () => {
      const event = buildEvent({ signature: 'a'.repeat(64) });
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 401 });
      expect(parseBody(result)).toEqual({ status: 'unauthorized' });
      expect(ddbMock).not.toHaveReceivedAnyCommand();
      expect(sqsMock).not.toHaveReceivedAnyCommand();
    });

    it('rechaza con 401 si el header de firma falta', async () => {
      const event = buildEvent();
      delete event.headers['x-payhub-signature'];
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 401 });
      expect(ddbMock).not.toHaveReceivedAnyCommand();
      expect(sqsMock).not.toHaveReceivedAnyCommand();
    });

    it('rechaza con 401 si el body fue alterado tras firmar', async () => {
      // Firmamos UN body pero mandamos otro.
      const originalBody = JSON.stringify(VALID_BODY);
      const tamperedBody = JSON.stringify({ ...VALID_BODY, monto: 999999 });
      const event = buildEvent({
        rawBody: tamperedBody,
        signature: sign(originalBody),
      });
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 401 });
      expect(ddbMock).not.toHaveReceivedAnyCommand();
      expect(sqsMock).not.toHaveReceivedAnyCommand();
    });
  });

  // ===========================================================================
  // 400 — Headers/body inválidos
  // ===========================================================================
  describe('400 bad request — headers o body inválidos', () => {
    it('rechaza con 400 si falta X-PayHub-Idempotency-Key', async () => {
      const event = buildEvent({ idempotencyKey: null });
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 400 });
      expect(parseBody(result)).toEqual({ status: 'bad_request' });
      expect(ddbMock).not.toHaveReceivedAnyCommand();
      expect(sqsMock).not.toHaveReceivedAnyCommand();
    });

    it('rechaza con 400 si falta X-PayHub-Origin', async () => {
      const event = buildEvent({ origin: null });
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 400 });
      expect(ddbMock).not.toHaveReceivedAnyCommand();
      expect(sqsMock).not.toHaveReceivedAnyCommand();
    });

    it('rechaza con 400 si el body no es JSON parseable', async () => {
      const rawBody = '{esto no es json valido';
      const event = buildEvent({
        rawBody,
        signature: sign(rawBody),
      });
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 400 });
      expect(ddbMock).not.toHaveReceivedAnyCommand();
      expect(sqsMock).not.toHaveReceivedAnyCommand();
    });

    it('rechaza con 400 si falta un campo obligatorio del schema', async () => {
      const incompleteBody = { transaccionId: 'TX-1', monto: 100 };
      const event = buildEvent({ body: incompleteBody });
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 400 });
      expect(ddbMock).not.toHaveReceivedAnyCommand();
    });

    it('rechaza con 400 si monto es negativo', async () => {
      const event = buildEvent({ body: { ...VALID_BODY, monto: -100 } });
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 400 });
    });

    it('rechaza con 400 si timestamp no es ISO 8601', async () => {
      const event = buildEvent({
        body: { ...VALID_BODY, timestamp: 'ayer a las 3' },
      });
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 400 });
    });

    it('rechaza con 400 si monto no es número', async () => {
      const event = buildEvent({
        body: { ...VALID_BODY, monto: 'cinco mil' },
      });
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 400 });
    });
  });

  // ===========================================================================
  // 200 — Evento duplicado (idempotencia)
  // ===========================================================================
  describe('200 already_processed — evento duplicado', () => {
    it('responde 200 sin encolar cuando idempotencyKey ya existe', async () => {
      // Forzamos que DDB rechace el PutItem con ConditionalCheckFailed.
      ddbMock.on(PutCommand).rejects(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: 'The conditional request failed',
        }),
      );

      const event = buildEvent();
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 200 });
      expect(parseBody(result)).toEqual({
        status: 'already_processed',
        idempotencyKey: 'idem-001',
      });

      // DDB sí recibió el comando, pero SQS NO.
      expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 1);
      expect(sqsMock).not.toHaveReceivedAnyCommand();
    });
  });

  // ===========================================================================
  // 500 — Errores inesperados
  // ===========================================================================
  describe('500 internal_error — errores inesperados', () => {
    it('responde 500 si DDB tira un error distinto a ConditionalCheckFailed', async () => {
      ddbMock.on(PutCommand).rejects(
        new DynamoDBServiceException({
          $metadata: {},
          message: 'Throttled',
          name: 'ProvisionedThroughputExceededException',
          $fault: 'client',
        }),
      );

      const event = buildEvent();
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 500 });
      expect(parseBody(result)).toEqual({ status: 'internal_error' });
      // NO expone detalles del error.
      expect(parseBody(result)).not.toHaveProperty('message');
      expect(parseBody(result)).not.toHaveProperty('stack');
      expect(sqsMock).not.toHaveReceivedAnyCommand();
    });

    it('responde 500 si SQS tira tras PutItem exitoso', async () => {
      sqsMock.on(SendMessageCommand).rejects(new Error('SQS network blip'));

      const event = buildEvent();
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 500 });
      expect(parseBody(result)).toEqual({ status: 'internal_error' });
      // El item ya quedó en DDB. Limitación documentada en DECISIONS.md (D17).
      expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 1);
    });

    it('NO expone stack traces en el body de 500', async () => {
      const sensitiveError = new Error(
        'AWS_SECRET_ACCESS_KEY=AKIA...fakesecretXYZ leaked in logs',
      );
      sqsMock.on(SendMessageCommand).rejects(sensitiveError);

      const event = buildEvent();
      const result = await handler(event, buildContext(), () => {});

      expect(result).toMatchObject({ statusCode: 500 });
      const body = parseBody(result);
      expect(JSON.stringify(body)).not.toContain('AKIA');
      expect(JSON.stringify(body)).not.toContain('fakesecretXYZ');
      expect(JSON.stringify(body)).not.toContain('stack');
    });
  });
});
