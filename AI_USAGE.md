# AI_USAGE.md — Uso de AI assistants durante la construcción

> Rúbrica (Regla 1.1): "Si usas AI, debes documentarlo en el README con detalle: qué prompts usaste, qué generó la IA y qué decidiste tú."

Este documento es la versión detallada. El README tiene un resumen.

---

## Stack de AI usado

- **Claude (Anthropic)** via **Claude Code** (CLI agentic con acceso a filesystem y bash).
- Sin otros assistants (no Copilot ni ChatGPT en esta prueba).

---

## Flujo de trabajo

El trabajo se organizó en 7 fases (definidas en `METHODOLOGY.md`). Cada fase fue una conversación corta con Claude donde:

1. Yo definía el alcance ("vamos con Fase X").
2. Claude proponía un plan + decisiones clave.
3. Yo aceptaba, rechazaba o pedía alternativas.
4. Claude generaba archivos y ejecutaba validaciones (`npm test`, `npm run typecheck`).
5. Yo revisaba el código generado y pedía explicaciones o cambios.
6. Al cerrar la fase, Claude proponía el mensaje de commit; **yo ejecutaba el commit** (Claude no toca git en esta sesión).

---

## Detalle por fase

### Fase 0 — Brain del proyecto

**Mi pedido inicial**: "el archivo word tiene la solicitud, y dentro de la carpeta hay unos json y script, lee todo y genera el contexto en un brain asociado al claude.md".

**Lo que Claude hizo**:
- Extrajo el contenido del `.docx` (con Python + unzip vía bash POSIX, porque PowerShell estaba bloqueado por el sandbox).
- Leyó todos los `.json` y el `.sh` del template.
- Detectó la imagen del diagrama de arquitectura embebida en el `.docx` y la procesó visualmente — eso me dio detalles que el texto no tenía (path `POST /webhook`, visibility 5 min, "tras 3 reintentos").
- Generó `CLAUDE.md`, `REQUIREMENTS.md` (80+ ítems), `METHODOLOGY.md` (7 fases).

**Mis decisiones**:
- Pedí revisar antes de avanzar: "revisa bien todos los requerimientos para que no se nos pase nada".
- Acepté la propuesta de fases ordenadas (no estrictamente 1→8 del .docx, sino agrupadas por dependencias).
- Fijé: "el commit lo haré yo". Claude NO ejecuta git.

### Fase 1 — Scaffolding

**Decisiones que Claude propuso y yo elegí**:
- **Serverless Framework v3** vs SAM → elegí v3 (v4 requiere licencia paga).
- **Jest + ts-jest** vs Vitest → elegí Jest (más alineado con el ecosistema AWS Lambda).
- **Node 20.x** → acepté (LTS, soportado por Lambda).
- **esbuild** para bundling → acepté (10× más rápido que tsc, tree-shake del SDK).

**Lo que Claude generó**: `package.json`, `tsconfig.json` (con flags strict explícitas), `jest.config.ts` con threshold 70%, `.gitignore`, `.env.example`, esqueletos de `receiver.ts` y `processor.ts` con JSDoc del flujo.

**Mi review**: pedí que me explicara `tsconfig.json` flag por flag. La explicación me convenció de que `strict: true` + las flags adicionales valían la pena. (En Fase 3 cazó un typo silencioso en `jest.config.ts` — `setupFilesAfterEach` no existe).

### Fase 2 — IaC + stack local

**Lo que Claude propuso**:
- `serverless-iam-roles-per-function` para IAM real least privilege (un role por Lambda).
- `docker-compose.yml` con DynamoDB Local + ElasticMQ (vs LocalStack).
- `serverless-offline` + `serverless-offline-sqs` para el endpoint local.
- 270 líneas comentadas en `serverless.yml`.

**Decisiones documentadas en DECISIONS.md (D6–D15)** que validé yo:
- IAM por función (vs role compartido) → blast radius reducido.
- SQS estándar (vs FIFO) → idempotencia ya está en app layer.
- `batchSize: 5`, `maximumBatchingWindow: 1`.
- `maxReceiveCount: 3`, `VisibilityTimeout: 300`.
- `PAY_PER_REQUEST` (vs provisioned).
- PITR en `pagos`, NO en `idempotency_keys`.
- Sin GSI inicial.

**Validación que corrí yo**: `npx serverless print --stage dev` (resolvió el YAML sin errores).

### Fase 3 — HMAC

**Mi pedido**: "vamos con la tarea 3".

**Lo que Claude generó**: `src/lib/hmac.ts` con 3 guards defensivos (inputs vacíos, regex hex, length match) antes de `timingSafeEqual`. Función `computeSignatureHex` **NO exportada** para prevenir bug de timing-attack.

22 tests cubriendo: happy path, firmas inválidas, longitudes raras, inputs vacíos, no-throw, sensibilidad a single-char tampering. 100% coverage.

**Mi decisión defensiva**: pregunté "¿por qué tantos guards si `timingSafeEqual` ya valida?". La respuesta — `Buffer.from('hex')` trunca silenciosamente con chars inválidos — me convenció. Documentado en D16.

**Bug cazado**: el primer `npm test` falló por `setupFilesAfterEach` (typo de Fase 1). TypeScript estricto + Jest config tipado lo cazaron al toque. **Defendible como ejemplo de por qué TS estricto vale lo que cuesta.**

### Fase 4 — Receiver

**Mi pedido**: "continua con la fase 2", luego revisión, luego "vamos con la tarea 3", luego "continua" tras Fase 3.

**Lo que Claude generó** (en una sola pasada):
- `src/lib/env.ts` con loader Zod tipado, lazy singleton.
- `src/lib/{logger,tracer,metrics}.ts` como singletons de Powertools.
- `withSubsegment(name, fn)` helper para X-Ray custom subsegments.
- `src/services/schemas.ts` con `webhookBodySchema` + `webhookMessageSchema`.
- `src/services/idempotency.ts` y `queue.ts` con clientes auto-trazados.
- `src/handlers/receiver.ts` con flujo de 6 pasos documentado.
- `tests/setup.ts` para env vars de test + silenciar logs.
- 16 tests con `aws-sdk-client-mock`.

**Decisión clave que tomé yo**: cuando Claude planteó "implementar compensación con DeleteItem ante SQS failure vs documentar como limitación", elegí **documentar (D17)** porque la compensación a medias tiene su propio failure mode.

**Lo que rechacé**: Claude inicialmente propuso usar `middy` para middleware de Powertools. Lo rechazamos para evitar una dep extra; usamos `addContext` + `appendKeys` explícito.

### Fase 5 — Processor

**Hallazgo del review pre-fase**: yo pedí "revisa bien lo que tenemos y avanza". Claude detectó que el fixture `batch-partial-failure.json` usa shape legacy (`cobroId/monto/clienteRut`) que NO matchea nuestro `webhookMessageSchema`. Sin compatibilidad, los 5 records irían a `batchItemFailures`, contradiciendo el `_resultado_esperado` del fixture.

**Decisión conjunta**: agregar `legacyWebhookMessageSchema` + función `normalizeWebhookMessage`. Schema moderno intacto; soporte legacy contenido. Documentado en D18.

**Lo que Claude generó**:
- `src/services/payments.ts` con `persistPago` y `ConditionExpression` (defense in depth).
- `src/services/schemas.ts` extendido con union schema + normalizer.
- `src/handlers/processor.ts` completo (~180 líneas comentadas).
- 12 tests, incluyendo uno que **lee el fixture real de Altera** y verifica que solo `msg-103` está en `batchItemFailures`.
- `OBSERVABILITY.md` con 7 secciones (logs, métricas, traces, alarmas críticas/warnings/informativas, dashboards, runbooks, costos).

**Métricas decididas**: `PagosProcesados`, `PagosFallidos`, `LatenciaProcesado` (end-to-end desde `ingestionTimestamp`). Dimensiones `Pasarela=PAYHUB`, `Stage`.

### Fase 6 — README + E2E + AI_USAGE

**Lo que Claude generó**:
- `README.md` con quick start, arquitectura, prerrequisitos, setup, comandos, mapeo rúbrica→código, lo NO entregado, AI usage summary, notas para revisión en vivo.
- `scripts/e2e-test.sh` con 10 invocaciones curl + assertions de status code y body content. Salida colorizada, resumen al final, exit code != 0 si falla.
- Este archivo (`AI_USAGE.md`).

**Mi review**: pedí que el README tuviera un cuadro de preguntas anticipadas con respuestas listas para la revisión en vivo. Claude lo agregó al final.

---

## Resumen de control

| Decisión | Quién la tomó |
|---|---|
| Serverless Framework v3 vs SAM | **Yo** (propuesta de Claude con trade-offs) |
| Jest vs Vitest | **Yo** (recomendación de Claude) |
| Que los commits los hago yo | **Yo** (regla establecida en Fase 0) |
| Estructura `handlers/services/lib` | Claude propuso, **yo acepté** |
| `serverless-iam-roles-per-function` | Claude propuso, **yo acepté** |
| HMAC con 3 guards + `timingSafeEqual` | Claude propuso, **yo cuestioné y entendí** antes de aceptar |
| Documentar D17 vs implementar compensación a medias | **Yo** (rechazamos compensación parcial) |
| Soporte legacy con union schema (D18) | **Yo** (después de que Claude detectó el conflicto) |
| Métricas `PagosProcesados/Fallidos/LatenciaProcesado` | Del enunciado, Claude implementó |
| 50 tests con `aws-sdk-client-mock` | Claude generó, **yo revisé los casos** |
| Defense in depth con `ConditionExpression` en `pagos` | Claude propuso, **yo acepté** (encaja con la rúbrica) |
| No usar `middy` para Powertools middleware | **Yo** (preferí explícito) |
| Threshold de coverage 70% | Del enunciado |

---

## Capacidad de defender el código

Cada línea del repo fue revisada por mí antes de aceptarse. En la revisión en vivo puedo:

1. **Explicar línea por línea** los archivos críticos:
   - `src/lib/hmac.ts` (3 guards, por qué `computeSignatureHex` no se exporta).
   - `src/handlers/receiver.ts` (los 6 pasos, por qué cada respuesta HTTP).
   - `src/handlers/processor.ts` (partial batch, defense in depth, métricas).
   - `serverless.yml` (IAM por función, visibility timeout, redrive policy).

2. **Justificar las 18 decisiones técnicas** (D1–D18 en `DECISIONS.md`) con sus trade-offs.

3. **Modificar código en vivo**: agregar un campo al schema, cambiar el threshold de fallo transient, agregar una métrica, cambiar visibility timeout, agregar un permiso IAM.

4. **Identificar lo que está MAL o INCOMPLETO**:
   - Compensación de SQS-fail-post-DDB-success (D17 — sé la mitigación correcta).
   - Alarmas no creadas en IaC (documentadas en OBSERVABILITY.md).
   - Sin GSI (D13 — sé cuándo agregarla).

---

## Archivos que NO escribí yo desde cero

**Todos los archivos** del repo fueron generados o modificados por Claude bajo mi dirección. Yo aporté:
- El enunciado (.docx + Template_B2_Serverless/).
- Las decisiones estratégicas (stack, alcance, qué incluir/excluir).
- Reviews de cada archivo (acepté/rejecté/pedí cambios).
- Las preguntas que validan mi entendimiento ("¿por qué X?", "¿qué pasa si Y?").
- La ejecución de `npm install` y `git commit` (cuando aplique).

**Esto es transparente.** El reviewer puede asumir que cualquier archivo del repo lo escribió Claude bajo mi instrucción. Lo que NO puede asumir es que no lo entiendo — la revisión en vivo de 30–45 min está diseñada para validar esto, y estoy preparado.

---

## Prompts representativos (para transparencia)

No reproduzco la conversación completa (sería ilegible), pero un sample de prompts que usé:

- "el archivo word tiene la solicitud, y dentro de la carpeta hay unos json y script, lee todo y genera el contexto en un brain asociado al claude.md"
- "es posible hacer todo en local?"
- "antes de avanzar quiero que me expliques bien lo que tenemos hasta ahora y lo que se ha hecho en cada fase explicando los archivos mas importantes"
- "vamos con la tarea 3"
- "continua"
- "revisa bien lo que tenemos y avanza"

El tono fue de **pair programming**, no de "genera todo el proyecto". Cada fase requirió mi go-ahead después de ver el plan, y mi revisión después de ver el código.
