#!/usr/bin/env bash
# =============================================================================
# bootstrap-local.sh
#
# Crea las tablas DynamoDB en DDB Local (las colas SQS las pre-crea ElasticMQ
# desde scripts/elasticmq.conf al levantar el contenedor).
#
# Prerrequisitos:
#   - docker compose up -d  (servicios DDB Local y ElasticMQ corriendo)
#   - aws-cli instalado     (cualquier versión >= 2.0)
#
# Idempotente: si las tablas ya existen, no falla.
# =============================================================================

set -euo pipefail

# --- Configuración ----------------------------------------------------------
DDB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://localhost:8000}"
SQS_ENDPOINT="${SQS_ENDPOINT:-http://localhost:9324}"
STAGE="${STAGE:-dev}"
REGION="${AWS_REGION:-us-east-1}"
SERVICE="prueba-altera-b2"

IDEMPOTENCY_TABLE="${SERVICE}-idempotency-${STAGE}"
PAGOS_TABLE="${SERVICE}-pagos-${STAGE}"

# DDB Local + ElasticMQ aceptan cualquier credencial. Exportamos fakes para
# que el SDK/aws-cli no falle al inicializar.
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-local}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-local}"
export AWS_DEFAULT_REGION="${REGION}"

# --- Helpers ----------------------------------------------------------------
log() { printf '\033[1;36m▶\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m!\033[0m %s\n' "$*"; }

ddb() { aws dynamodb --endpoint-url "${DDB_ENDPOINT}" "$@"; }
sqs() { aws sqs       --endpoint-url "${SQS_ENDPOINT}" "$@"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { warn "Falta '$1' en PATH"; exit 1; }
}

wait_for_url() {
  local url="$1" attempts=30
  for ((i=1; i<=attempts; i++)); do
    if curl -sf -o /dev/null "$url" || [ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" =~ ^(200|400|404)$ ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# --- Pre-flight checks ------------------------------------------------------
require_cmd aws
require_cmd curl

log "Esperando DynamoDB Local en ${DDB_ENDPOINT}..."
if ! wait_for_url "${DDB_ENDPOINT}"; then
  warn "DynamoDB Local no responde. ¿Levantaste 'docker compose up -d'?"
  exit 1
fi
ok "DynamoDB Local listo."

log "Esperando ElasticMQ en ${SQS_ENDPOINT}..."
if ! wait_for_url "${SQS_ENDPOINT}"; then
  warn "ElasticMQ no responde. ¿Levantaste 'docker compose up -d'?"
  exit 1
fi
ok "ElasticMQ listo."

# --- Tabla idempotency_keys -------------------------------------------------
log "Creando tabla ${IDEMPOTENCY_TABLE}..."
if ddb describe-table --table-name "${IDEMPOTENCY_TABLE}" >/dev/null 2>&1; then
  warn "  Ya existe, se omite create."
else
  ddb create-table \
    --table-name "${IDEMPOTENCY_TABLE}" \
    --attribute-definitions AttributeName=idempotencyKey,AttributeType=S \
    --key-schema AttributeName=idempotencyKey,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  ok "  Creada."
fi

log "Habilitando TTL en ${IDEMPOTENCY_TABLE} (attr: ttl)..."
if ddb describe-time-to-live --table-name "${IDEMPOTENCY_TABLE}" \
     --query 'TimeToLiveDescription.TimeToLiveStatus' --output text 2>/dev/null \
     | grep -qE 'ENABLED|ENABLING'; then
  warn "  TTL ya habilitado."
else
  ddb update-time-to-live \
    --table-name "${IDEMPOTENCY_TABLE}" \
    --time-to-live-specification "Enabled=true,AttributeName=ttl" >/dev/null 2>&1 || warn "  DDB Local puede no soportar TTL real; setting registrado igualmente."
  ok "  TTL configurado."
fi

# --- Tabla pagos ------------------------------------------------------------
log "Creando tabla ${PAGOS_TABLE}..."
if ddb describe-table --table-name "${PAGOS_TABLE}" >/dev/null 2>&1; then
  warn "  Ya existe, se omite create."
else
  ddb create-table \
    --table-name "${PAGOS_TABLE}" \
    --attribute-definitions \
      AttributeName=transaccionId,AttributeType=S \
      AttributeName=timestamp,AttributeType=S \
    --key-schema \
      AttributeName=transaccionId,KeyType=HASH \
      AttributeName=timestamp,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null
  ok "  Creada."
fi

# --- Verificación de colas SQS ---------------------------------------------
log "Verificando colas pre-creadas por ElasticMQ..."
sqs list-queues --output text | sed 's/^/  /' || true

# --- Resumen ----------------------------------------------------------------
echo
ok "Stack local listo."
echo
echo "  DynamoDB endpoint  : ${DDB_ENDPOINT}"
echo "  SQS endpoint       : ${SQS_ENDPOINT}"
echo "  Idempotency table  : ${IDEMPOTENCY_TABLE}"
echo "  Pagos table        : ${PAGOS_TABLE}"
echo "  Webhook queue      : ${SQS_ENDPOINT}/queue/webhook-queue-${STAGE}"
echo "  Webhook DLQ        : ${SQS_ENDPOINT}/queue/webhook-dlq-${STAGE}"
echo
echo "Siguiente: 'npm run offline' (API Gateway local en :3000)"
