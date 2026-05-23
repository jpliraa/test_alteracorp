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

> Decisiones de fases posteriores (FIFO vs estándar, batchSize, maxReceiveCount, visibility timeout, propagación de correlation ID, alarmas) se agregan al cerrar cada fase correspondiente.
