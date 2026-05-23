#!/usr/bin/env bash
# scripts/firmar-evento.sh
# Genera el HMAC-SHA256 hex de un body JSON con el secret de PayHub.
# Uso: ./firmar-evento.sh '<json-string>' <secret>

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Uso: $0 '<body-json>' <secret>"
  echo ""
  echo "Ejemplo:"
  echo "  ./firmar-evento.sh '{\"eventoId\":\"evt-001\"}' mi-secret-de-payhub"
  exit 1
fi

BODY="$1"
SECRET="$2"

HMAC=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

echo "Body:      $BODY"
echo "Secret:    ${SECRET:0:8}..."
echo "HMAC SHA-256: $HMAC"
echo ""
echo "Header completo a usar:"
echo "  X-PayHub-Signature: $HMAC"
