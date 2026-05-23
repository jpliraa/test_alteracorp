# METHODOLOGY.md — Cómo trabajamos esta prueba

> Marco de trabajo para ejecutar la prueba `ALT-B2-0526-C04` con rigor, cumpliendo la rúbrica completa y dejando trazabilidad para la revisión en vivo.

---

## Principios

1. **Seguir el .docx como fuente de verdad**. Cualquier desviación se documenta en `DECISIONS.md`.
2. **Verificable, no aspiracional**. Cada paso cierra ítems de `REQUIREMENTS.md`. Nada se da por hecho.
3. **Commits incrementales**. Cada fase termina con uno (o varios) commits chicos y con mensaje claro — la rúbrica lo exige (mínimo 5). **Los commits los hace el usuario**; Claude solo prepara los archivos y propone el mensaje sugerido al cerrar cada fase.
4. **Documentar mientras se construye**, no al final. README, DECISIONS, OBSERVABILITY se llenan en paralelo al código.
5. **Defendible en vivo**. Si no podemos justificar línea por línea, no entra. Cero copy-paste sin entender.
6. **Local-first**. Todo corre con `docker-compose up` + `npm run dev`. No se asume cuenta AWS.

## Orden de fases

Las 8 tareas del .docx no se ejecutan estrictamente 1→8: agrupamos por dependencias y commits coherentes. El orden propuesto:

### Fase 0 — Brain y plan (✅ hecho)
- `CLAUDE.md`, `REQUIREMENTS.md`, `METHODOLOGY.md` listos.
- **Commit**: `chore: project brain (CLAUDE.md + requirements + methodology)`.

### Fase 1 — Setup + scaffolding (T1 + T6 design)
- `package.json`, `tsconfig.json`, estructura de carpetas, `.gitignore`.
- Esqueleto `src/handlers/{receiver,processor}.ts` con TODOs marcados.
- `DECISIONS.md` v0 con las decisiones de stack (TS, Serverless Framework vs SAM, vitest vs jest).
- Cierra: D.1–D.7, I.1–I.4 (modelado conceptual).
- **Commit**: `chore: project scaffolding and stack decisions`.

### Fase 2 — IaC (T2 + T6 implementación)
- `serverless.yml` completo con: API Gateway HTTP API, 2 Lambdas, SQS+DLQ, 2 Dynamo tables, IAM least privilege, env vars por stage, X-Ray.
- `docker-compose.yml` con DynamoDB Local + ElasticMQ.
- `scripts/bootstrap-local.sh` que crea tablas y colas locales.
- Cierra: E.1–E.13, I.5–I.6, N.1–N.2.
- **Commit**: `feat(iac): serverless.yml with least-privilege IAM and local docker stack`.

### Fase 3 — HMAC (T3)
- `src/lib/hmac.ts` + tests unitarios.
- Cierra: F.1–F.7.
- **Commit**: `feat(hmac): timing-safe signature verification`.

### Fase 4 — Receiver (T4 con observabilidad ya integrada)
- `src/lib/logger.ts`, `src/lib/tracer.ts`, `src/lib/metrics.ts` (Powertools setup).
- `src/services/idempotency.ts`, `src/services/queue.ts`.
- `src/handlers/receiver.ts` completo con flujo de 6 pasos.
- Tests con `aws-sdk-client-mock`.
- Cierra: G.1–G.12, parte de J.1–J.4.
- **Commit**: `feat(receiver): HMAC + idempotency + enqueue with Powertools`.

### Fase 5 — Processor (T5 + cierra T7)
- `src/services/payments.ts`.
- `src/handlers/processor.ts` con partial batch failure + métricas + tracer.
- Tests con `aws-sdk-client-mock` (happy + transient + invalid JSON).
- `OBSERVABILITY.md` completo.
- Cierra: H.1–H.9, J.1–J.5.
- **Commit**: `feat(processor): partial batch failure with metrics and traces`.

### Fase 6 — E2E + docs (T8 + cierre)
- `scripts/e2e-test.sh` con 10 curl + assertions.
- `scripts/firmar-evento-helper.sh` (wrapper o uso del provisto en `Template_B2_Serverless/scripts/firmar-evento.sh`).
- `README.md` final completo: setup, comandos, decisiones, AI usage, lo no entregado.
- `DECISIONS.md` final con todos los trade-offs (L.1–L.9).
- Cierra: A.4, K.1–K.3, L.1–L.9, M.7, N.5, O.1–O.5.
- **Commit**: `docs: README, DECISIONS, OBSERVABILITY and e2e script`.

### Fase 7 — Calidad y verificación (transversal)
- Coverage ≥ 70%.
- `tsc --noEmit` limpio.
- `grep` de guardrails: cero `Resource: '*'`, cero `===` para HMAC, cero `console.log`.
- Correr `e2e-test.sh` contra el stack local y dejar evidencia (output en README o `EVIDENCE.md`).
- Cierra: M.1–M.7.
- **Commit**: `test: ensure 70% coverage and guardrails pass`.

## Criterios de "done" por fase

Una fase se cierra solo si:

1. Los ítems de `REQUIREMENTS.md` correspondientes están marcados `[x]`.
2. Los tests de esa fase pasan (`npm test`).
3. `tsc --noEmit` no tira errores.
4. Hay un commit con mensaje claro.
5. La documentación afectada (README/DECISIONS/OBSERVABILITY) refleja el cambio.

## Manejo del tiempo

- Presupuesto total estimado: 4–5 horas de trabajo efectivo.
- Si una fase supera el doble del tiempo del .docx, se documenta como "tiempo excedido" en `DECISIONS.md` y se simplifica.
- Si algo no se alcanza, no se oculta: va a la sección "Lo no entregado" del README con la razón.

## Uso de AI assistants

- Cada fase logguea en `AI_USAGE.md` (o sección del README):
  - prompt(s) usado(s).
  - qué generó la IA literalmente.
  - qué decisiones tomó el candidato (modificaciones, validaciones, descartes).
- El criterio es que en la revisión en vivo el candidato pueda explicar **cada línea** y modificar el código bajo demanda.

## Reglas operativas para Claude en esta sesión

- **Claude NO ejecuta comandos git** (`git init`, `git add`, `git commit`, `git push`). Los corre el usuario. Claude prepara archivos y propone el mensaje de commit sugerido al cerrar cada fase.
- Nunca ejecutar `git push --force`, `git reset --hard`, `rm -rf` sin confirmación explícita (aplicaría solo si en algún momento se autoriza).
- Antes de crear un archivo, verificar que no existe ya con `Glob`/`Read`.
- Después de cada fase, actualizar el checklist de `REQUIREMENTS.md` (marcar `[x]`) y avisar al usuario que la fase quedó lista para commit.
- Si una decisión no está clara, plantear opción A/B con trade-offs y esperar confirmación, no decidir solo.
- Mantener TS estricto, sin `any` salvo en mocks con comentario justificando.

## Trazabilidad

Cada commit referencia ítems de `REQUIREMENTS.md` en el body:

```
feat(receiver): HMAC + idempotency + enqueue with Powertools

Closes: G.1, G.2, G.3, G.4, G.5, G.6, G.7, G.8, G.9, G.10, G.11, G.12
Partial: J.1, J.2, J.4
```

Esto permite a la revisión en vivo navegar del entregable a la rúbrica en segundos.
