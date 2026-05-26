#!/usr/bin/env bash
# =============================================================================
# e2e-test.sh — 10 invocaciones curl contra el endpoint local del webhook.
#
# Cobertura:
#   - 5 webhooks válidos                            → esperado HTTP 202
#   - 2 duplicados (mismo idempotencyKey)           → esperado HTTP 200 already_processed
#   - 1 firma HMAC inválida                         → esperado HTTP 401
#   - 1 header obligatorio faltante                 → esperado HTTP 400
#   - 1 body inválido (no cumple schema)            → esperado HTTP 400
#
# Prerrequisitos:
#   1. `docker compose up -d` (DDB Local + ElasticMQ corriendo)
#   2. `npm run bootstrap:local` (tablas DDB creadas)
#   3. `npm run offline` corriendo en otra terminal (API Gateway en :3000)
#
# Exit code:
#   0 si TODAS las assertions pasan
#   1 si alguna falla (con detalle por test)
# =============================================================================

# NOTA sobre `set -e`: NO lo usamos porque queremos que el script continúe
# corriendo todas las assertions aunque alguna falle, y reporte el resumen
# al final. Usamos `set -uo pipefail` para las otras protecciones bash.
set -uo pipefail

# -----------------------------------------------------------------------------
# Configuración
# -----------------------------------------------------------------------------
ENDPOINT="${ENDPOINT:-http://localhost:3000/webhook}"
SECRET="${PAYHUB_HMAC_SECRET:-dev-secret-change-me}"

# Colores ANSI (Git Bash en Windows los soporta).
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;36m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' BLUE='' BOLD='' NC=''
fi

# Contadores
TOTAL=0
PASS=0
FAIL=0
FAILED_NAMES=()

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

log_info()    { printf "${BLUE}▶ %s${NC}\n" "$*"; }
log_pass()    { printf "  ${GREEN}✓ PASS${NC} %s\n" "$*"; }
log_fail()    { printf "  ${RED}✗ FAIL${NC} %s\n" "$*"; }
log_section() { printf "\n${BOLD}${BLUE}═══ %s ═══${NC}\n" "$*"; }

# Genera HMAC-SHA256 hex del body usando el secret.
sign() {
  local body="$1"
  local secret="$2"
  printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" | awk '{print $NF}'
}

# Hace el POST y retorna el HTTP status code en stdout.
# Args: $1=body $2=signature $3=idempotencyKey $4=origin($5=extraHeader)
do_post() {
  local body="$1"
  local sig="$2"
  local key="$3"
  local origin="$4"
  local extra_header="${5:-}"

  local headers=(
    -H "Content-Type: application/json"
    -H "X-PayHub-Signature: $sig"
  )
  # idempotencyKey vacío significa "no enviar header" (para el test 400).
  if [ -n "$key" ]; then
    headers+=(-H "X-PayHub-Idempotency-Key: $key")
  fi
  if [ -n "$origin" ]; then
    headers+=(-H "X-PayHub-Origin: $origin")
  fi
  if [ -n "$extra_header" ]; then
    headers+=(-H "$extra_header")
  fi

  curl -sS -o /tmp/e2e-response.json -w "%{http_code}" \
    -X POST "$ENDPOINT" \
    "${headers[@]}" \
    -d "$body"
}

# Asserts.
assert_status() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"

  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    log_pass "$test_name  ($actual)"
    PASS=$((PASS + 1))
  else
    log_fail "$test_name  (expected $expected, got $actual)"
    if [ -s /tmp/e2e-response.json ]; then
      printf "      response: %s\n" "$(cat /tmp/e2e-response.json)"
    fi
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$test_name")
  fi
}

assert_response_contains() {
  local test_name="$1"
  local needle="$2"

  TOTAL=$((TOTAL + 1))
  if grep -q "$needle" /tmp/e2e-response.json 2>/dev/null; then
    log_pass "$test_name  (response contains '$needle')"
    PASS=$((PASS + 1))
  else
    log_fail "$test_name  (response missing '$needle')"
    if [ -s /tmp/e2e-response.json ]; then
      printf "      response: %s\n" "$(cat /tmp/e2e-response.json)"
    fi
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$test_name")
  fi
}

# Pre-flight: verifica que el endpoint esté arriba.
check_endpoint() {
  log_info "Verificando que $ENDPOINT esté reachable..."
  if ! curl -sS --max-time 3 -o /dev/null "$ENDPOINT" -X POST -d 'x' 2>/dev/null; then
    printf "${RED}✗ El endpoint no responde.${NC}\n\n"
    printf "  ¿Está corriendo 'npm run offline' en otra terminal?\n"
    printf "  ¿Están up DDB Local y ElasticMQ ('docker compose up -d')?\n\n"
    exit 1
  fi
  printf "${GREEN}✓ Endpoint responde${NC}\n"
}

# -----------------------------------------------------------------------------
# Test cases
# -----------------------------------------------------------------------------

run_test_1_webhook_valido() {
  local body='{"transaccionId":"TX-E2E-001","referencia":"REF001","clienteRut":"11.111.111-1","monto":5000,"timestamp":"2026-05-19T14:30:00Z"}'
  local sig
  sig=$(sign "$body" "$SECRET")
  local status
  status=$(do_post "$body" "$sig" "idem-e2e-001" "PAYHUB")
  assert_status "1. Webhook válido #1"                        "202" "$status"
  assert_response_contains "   └ body trae status=accepted"   '"status":"accepted"'
}

run_test_2_webhook_valido() {
  local body='{"transaccionId":"TX-E2E-002","referencia":"REF002","clienteRut":"22.222.222-2","monto":7500,"timestamp":"2026-05-19T14:31:00Z"}'
  local sig
  sig=$(sign "$body" "$SECRET")
  local status
  status=$(do_post "$body" "$sig" "idem-e2e-002" "PAYHUB")
  assert_status "2. Webhook válido #2"                        "202" "$status"
}

run_test_3_webhook_valido() {
  local body='{"transaccionId":"TX-E2E-003","referencia":"REF003","clienteRut":"33.333.333-3","monto":12000,"timestamp":"2026-05-19T14:32:00Z"}'
  local sig
  sig=$(sign "$body" "$SECRET")
  local status
  status=$(do_post "$body" "$sig" "idem-e2e-003" "PAYHUB")
  assert_status "3. Webhook válido #3"                        "202" "$status"
}

run_test_4_duplicado_de_1() {
  # Mismo idempotencyKey que test 1: debe responder 200 already_processed.
  local body='{"transaccionId":"TX-E2E-001","referencia":"REF001","clienteRut":"11.111.111-1","monto":5000,"timestamp":"2026-05-19T14:30:00Z"}'
  local sig
  sig=$(sign "$body" "$SECRET")
  local status
  status=$(do_post "$body" "$sig" "idem-e2e-001" "PAYHUB")
  assert_status "4. Duplicado de #1 (mismo idem-e2e-001)"     "200" "$status"
  assert_response_contains "   └ body trae status=already_processed" '"status":"already_processed"'
}

run_test_5_webhook_valido() {
  local body='{"transaccionId":"TX-E2E-004","referencia":"REF004","clienteRut":"44.444.444-4","monto":9999,"timestamp":"2026-05-19T14:33:00Z"}'
  local sig
  sig=$(sign "$body" "$SECRET")
  local status
  status=$(do_post "$body" "$sig" "idem-e2e-004" "PAYHUB")
  assert_status "5. Webhook válido #4"                        "202" "$status"
}

run_test_6_firma_invalida() {
  local body='{"transaccionId":"TX-E2E-FAKE","referencia":"REF","clienteRut":"55.555.555-5","monto":1000,"timestamp":"2026-05-19T14:34:00Z"}'
  # Firma con OTRO secret → será inválida contra el server.
  local bad_sig
  bad_sig=$(sign "$body" "secret-totalmente-equivocado")
  local status
  status=$(do_post "$body" "$bad_sig" "idem-e2e-005" "PAYHUB")
  assert_status "6. Firma HMAC inválida"                      "401" "$status"
  assert_response_contains "   └ body trae status=unauthorized" '"status":"unauthorized"'
}

run_test_7_falta_idempotency_key() {
  # HMAC válido pero sin el header X-PayHub-Idempotency-Key.
  local body='{"transaccionId":"TX-E2E-006","referencia":"REF","clienteRut":"66.666.666-6","monto":1000,"timestamp":"2026-05-19T14:35:00Z"}'
  local sig
  sig=$(sign "$body" "$SECRET")
  local status
  # 3er arg vacío → no se envía idempotencyKey header.
  status=$(do_post "$body" "$sig" "" "PAYHUB")
  assert_status "7. Falta X-PayHub-Idempotency-Key"           "400" "$status"
  assert_response_contains "   └ body trae status=bad_request" '"status":"bad_request"'
}

run_test_8_body_invalido() {
  # HMAC válido pero body sin transaccionId (campo obligatorio).
  local body='{"referencia":"REF","clienteRut":"77.777.777-7","monto":1000,"timestamp":"2026-05-19T14:36:00Z"}'
  local sig
  sig=$(sign "$body" "$SECRET")
  local status
  status=$(do_post "$body" "$sig" "idem-e2e-007" "PAYHUB")
  assert_status "8. Body inválido (sin transaccionId)"        "400" "$status"
}

run_test_9_duplicado_de_2() {
  local body='{"transaccionId":"TX-E2E-002","referencia":"REF002","clienteRut":"22.222.222-2","monto":7500,"timestamp":"2026-05-19T14:31:00Z"}'
  local sig
  sig=$(sign "$body" "$SECRET")
  local status
  status=$(do_post "$body" "$sig" "idem-e2e-002" "PAYHUB")
  assert_status "9. Duplicado de #2 (mismo idem-e2e-002)"     "200" "$status"
  assert_response_contains "   └ body trae status=already_processed" '"status":"already_processed"'
}

run_test_10_webhook_valido_final() {
  local body='{"transaccionId":"TX-E2E-005","referencia":"REF005","clienteRut":"88.888.888-8","monto":150000,"timestamp":"2026-05-19T14:37:00Z"}'
  local sig
  sig=$(sign "$body" "$SECRET")
  local status
  status=$(do_post "$body" "$sig" "idem-e2e-008" "PAYHUB")
  assert_status "10. Webhook válido #5"                       "202" "$status"
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

printf "${BOLD}${BLUE}╔══════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${BLUE}║  E2E Test — Webhook Serverless ALT-B2-0526-C04         ║${NC}\n"
printf "${BOLD}${BLUE}╚══════════════════════════════════════════════════════════╝${NC}\n\n"

printf "  Endpoint:  %s\n" "$ENDPOINT"
printf "  Secret:    %s...\n\n" "${SECRET:0:8}"

check_endpoint

log_section "Caminos exitosos (esperan 202 Accepted)"
run_test_1_webhook_valido
run_test_2_webhook_valido
run_test_3_webhook_valido

log_section "Idempotencia (esperan 200 already_processed)"
run_test_4_duplicado_de_1

log_section "Más webhooks válidos"
run_test_5_webhook_valido

log_section "Rechazos (HMAC + headers + body)"
run_test_6_firma_invalida
run_test_7_falta_idempotency_key
run_test_8_body_invalido

log_section "Segundo duplicado (validar idempotencia consistente)"
run_test_9_duplicado_de_2

log_section "Último webhook válido"
run_test_10_webhook_valido_final

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------

printf "\n${BOLD}${BLUE}╔══════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${BLUE}║  Resumen                                                 ║${NC}\n"
printf "${BOLD}${BLUE}╚══════════════════════════════════════════════════════════╝${NC}\n\n"

printf "  Total assertions: %d\n" "$TOTAL"
printf "  ${GREEN}Passed${NC}:           %d\n" "$PASS"
printf "  ${RED}Failed${NC}:           %d\n\n" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  printf "${RED}${BOLD}✗ E2E FAILED${NC}\n\n"
  printf "  Tests fallidos:\n"
  for name in "${FAILED_NAMES[@]}"; do
    printf "    - %s\n" "$name"
  done
  exit 1
fi

printf "${GREEN}${BOLD}✓ ALL E2E TESTS PASSED${NC}\n\n"
exit 0
