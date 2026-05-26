import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import {
  ConditionalCheckFailedException,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';

import { handler } from '../../../src/handlers/processor';
import type { WebhookMessage } from '../../../src/services/schemas';

// -----------------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------------
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
  // Reset a 0 (sin fallo transient). Tests que requieren fallo lo setean a '1'.
  process.env['TRANSIENT_FAILURE_RATE'] = '0';
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function buildContext(): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'prueba-altera-b2-dev-processor',
    functionVersion: '$LATEST',
    invokedFunctionArn:
      'arn:aws:lambda:us-east-1:123456789012:function:prueba-altera-b2-dev-processor',
    memoryLimitInMB: '512',
    awsRequestId: 'aws-req-proc-001',
    logGroupName: '/aws/lambda/prueba-altera-b2-dev-processor',
    logStreamName: '2026/05/19/[$LATEST]yyy',
    getRemainingTimeInMillis: () => 30000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

function buildRecord(opts: {
  messageId: string;
  body: string | object;
  correlationId?: string;
}): SQSRecord {
  const body =
    typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);

  const messageAttributes: SQSRecord['messageAttributes'] = {};
  if (opts.correlationId !== undefined) {
    messageAttributes['correlationId'] = {
      stringValue: opts.correlationId,
      stringListValues: [],
      binaryListValues: [],
      dataType: 'String',
    };
  }

  return {
    messageId: opts.messageId,
    receiptHandle: `rh-${opts.messageId}`,
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '1747663800000',
      SenderId: 'AIDA...',
      ApproximateFirstReceiveTimestamp: '1747663800000',
    },
    messageAttributes,
    md5OfBody: 'mock-md5',
    eventSource: 'aws:sqs',
    eventSourceARN:
      'arn:aws:sqs:us-east-1:123456789012:prueba-altera-b2-webhook-queue-test',
    awsRegion: 'us-east-1',
  };
}

function modernMessage(transaccionId: string, idempotencyKey: string): WebhookMessage {
  return {
    idempotencyKey,
    correlationId: idempotencyKey,
    ingestionTimestamp: '2026-05-19T14:30:00.000Z',
    payload: {
      transaccionId,
      referencia: 'AB12CD34',
      clienteRut: '11.111.111-1',
      monto: 5000,
      timestamp: '2026-05-19T14:30:00.000Z',
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Processor handler', () => {
  // ---------------------------------------------------------------------------
  // Happy path: shape moderno
  // ---------------------------------------------------------------------------
  describe('happy path con shape moderno (lo que produce nuestro Receiver)', () => {
    it('persiste un único mensaje y devuelve batchItemFailures vacío', async () => {
      const msg = modernMessage('TX-001', 'idem-001');
      const event: SQSEvent = {
        Records: [
          buildRecord({ messageId: 'sqs-1', body: msg, correlationId: 'idem-001' }),
        ],
      };

      const result = await handler(event, buildContext());

      expect(result).toEqual({ batchItemFailures: [] });
      expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 1);
      expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
        TableName: 'prueba-altera-b2-pagos-test',
        Item: expect.objectContaining({
          transaccionId: 'TX-001',
          referencia: 'AB12CD34',
          clienteRut: '11.111.111-1',
          monto: 5000,
          estado: 'procesado',
          idempotencyKey: 'idem-001',
          timestamp: '2026-05-19T14:30:00.000Z',
        }) as unknown,
        ConditionExpression: 'attribute_not_exists(transaccionId)',
      });
    });

    it('procesa un batch de 5 mensajes correctamente', async () => {
      const event: SQSEvent = {
        Records: Array.from({ length: 5 }, (_, i) =>
          buildRecord({
            messageId: `sqs-${i + 1}`,
            body: modernMessage(`TX-${i + 1}`, `idem-${i + 1}`),
          }),
        ),
      };

      const result = await handler(event, buildContext());

      expect(result.batchItemFailures).toEqual([]);
      expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 5);
    });
  });

  // ---------------------------------------------------------------------------
  // Happy path: shape legacy (fixtures de Altera)
  // ---------------------------------------------------------------------------
  describe('compatibilidad con shape legacy (fixtures Template_B2_Serverless)', () => {
    it('normaliza el shape legacy y persiste con cobroId como transaccionId', async () => {
      const event: SQSEvent = {
        Records: [
          buildRecord({
            messageId: 'msg-101',
            body: {
              cobroId: 'cob-2001',
              monto: 35000,
              clienteRut: '12345678-9',
            },
          }),
        ],
      };

      const result = await handler(event, buildContext());

      expect(result.batchItemFailures).toEqual([]);
      expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
        TableName: 'prueba-altera-b2-pagos-test',
        Item: expect.objectContaining({
          transaccionId: 'cob-2001',
          clienteRut: '12345678-9',
          monto: 35000,
          referencia: 'LEGACY-cob-2001',
          estado: 'procesado',
          idempotencyKey: 'cob-2001',
        }) as unknown,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Partial batch failure (este es el corazón del Tarea 5)
  // ---------------------------------------------------------------------------
  describe('partial batch failure', () => {
    it('procesa los válidos y reporta SOLO el inválido en batchItemFailures', async () => {
      const event: SQSEvent = {
        Records: [
          buildRecord({
            messageId: 'msg-101',
            body: { cobroId: 'cob-2001', monto: 35000, clienteRut: '12345678-9' },
          }),
          buildRecord({
            messageId: 'msg-102',
            body: { cobroId: 'cob-2002', monto: 67000, clienteRut: '14567891-2' },
          }),
          buildRecord({
            messageId: 'msg-103',
            body: '{ESTO NO ES JSON VALIDO, debe fallar al parsear}',
          }),
          buildRecord({
            messageId: 'msg-104',
            body: { cobroId: 'cob-2003', monto: 89000, clienteRut: '16789012-3' },
          }),
          buildRecord({
            messageId: 'msg-105',
            body: { cobroId: 'cob-2004', monto: 123000, clienteRut: '18901234-K' },
          }),
        ],
      };

      const result = await handler(event, buildContext());

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-103' }]);
      expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 4);
    });

    it('replica exactamente el fixture batch-partial-failure.json de Altera', async () => {
      const fixturePath = join(
        __dirname,
        '..',
        '..',
        '..',
        'Template_B2_Serverless',
        'sample-events',
        'batch-partial-failure.json',
      );
      const raw = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<
        string,
        unknown
      > & { Records: SQSRecord[] };

      // Quitamos los campos `_descripcion`/`_resultado_esperado` que no son del shape SQS real.
      const event: SQSEvent = { Records: raw.Records };

      const result = await handler(event, buildContext());

      // Match exacto al "_resultado_esperado" del fixture.
      expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-103' }]);
      expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 4);
    });
  });

  // ---------------------------------------------------------------------------
  // Schema inválido → batchItemFailures
  // ---------------------------------------------------------------------------
  describe('validación de schema', () => {
    it('falla un record cuyo body es JSON válido pero no matchea ningún schema', async () => {
      const event: SQSEvent = {
        Records: [
          buildRecord({ messageId: 'sqs-1', body: { algo: 'random', sin: 'shape' } }),
        ],
      };

      const result = await handler(event, buildContext());

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'sqs-1' }]);
      expect(ddbMock).not.toHaveReceivedAnyCommand();
    });

    it('falla un record con monto negativo (viola legacy schema)', async () => {
      const event: SQSEvent = {
        Records: [
          buildRecord({
            messageId: 'sqs-1',
            body: { cobroId: 'cob-X', monto: -100, clienteRut: '11.111.111-1' },
          }),
        ],
      };

      const result = await handler(event, buildContext());

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'sqs-1' }]);
    });
  });

  // ---------------------------------------------------------------------------
  // Fallo transient simulado (5% por defecto, 100% en este test)
  // ---------------------------------------------------------------------------
  describe('fallo transient simulado', () => {
    it('reporta el record en batchItemFailures cuando el servicio externo falla', async () => {
      process.env['TRANSIENT_FAILURE_RATE'] = '1'; // forzamos fallo

      const event: SQSEvent = {
        Records: [
          buildRecord({
            messageId: 'sqs-tx-1',
            body: modernMessage('TX-100', 'idem-100'),
          }),
        ],
      };

      const result = await handler(event, buildContext());

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'sqs-tx-1' }]);
      // El fallo es ANTES de persistir → DDB no recibe nada.
      expect(ddbMock).not.toHaveReceivedAnyCommand();
    });

    it('NO falla cuando TRANSIENT_FAILURE_RATE = 0 (default tests)', async () => {
      // Doble verificación de que el default es 0 y el camino feliz no se rompe.
      const event: SQSEvent = {
        Records: Array.from({ length: 20 }, (_, i) =>
          buildRecord({
            messageId: `sqs-${i}`,
            body: modernMessage(`TX-${i}`, `idem-${i}`),
          }),
        ),
      };

      const result = await handler(event, buildContext());

      expect(result.batchItemFailures).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Defense in depth: ConditionalCheckFailedException en pagos
  // ---------------------------------------------------------------------------
  describe('defense in depth (PutItem condicional en pagos)', () => {
    it('trata ConditionalCheckFailedException como ÉXITO (no en batchItemFailures)', async () => {
      ddbMock.on(PutCommand).rejects(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: 'The conditional request failed',
        }),
      );

      const event: SQSEvent = {
        Records: [
          buildRecord({
            messageId: 'sqs-dup',
            body: modernMessage('TX-DUP', 'idem-DUP'),
          }),
        ],
      };

      const result = await handler(event, buildContext());

      expect(result.batchItemFailures).toEqual([]); // ¡éxito!
      expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Errores no esperados de DDB
  // ---------------------------------------------------------------------------
  describe('errores no anticipados', () => {
    it('reporta el record cuando DDB tira un error que NO es ConditionalCheckFailed', async () => {
      ddbMock.on(PutCommand).rejects(
        new DynamoDBServiceException({
          $metadata: {},
          message: 'Throttled',
          name: 'ProvisionedThroughputExceededException',
          $fault: 'client',
        }),
      );

      const event: SQSEvent = {
        Records: [
          buildRecord({
            messageId: 'sqs-throttled',
            body: modernMessage('TX-T', 'idem-T'),
          }),
        ],
      };

      const result = await handler(event, buildContext());

      expect(result.batchItemFailures).toEqual([
        { itemIdentifier: 'sqs-throttled' },
      ]);
    });

    it('NUNCA tira excepción al runtime (no perder batch entero)', async () => {
      ddbMock.on(PutCommand).rejects(new Error('Algo completamente inesperado'));

      const event: SQSEvent = {
        Records: [
          buildRecord({ messageId: 'sqs-A', body: modernMessage('TX-A', 'idem-A') }),
          buildRecord({ messageId: 'sqs-B', body: modernMessage('TX-B', 'idem-B') }),
        ],
      };

      // No debe tirar:
      const result = await handler(event, buildContext());

      // Ambos fueron a batchItemFailures.
      expect(result.batchItemFailures).toHaveLength(2);
      expect(result.batchItemFailures.map((f) => f.itemIdentifier).sort()).toEqual([
        'sqs-A',
        'sqs-B',
      ]);
    });
  });
});
