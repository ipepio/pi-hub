#!/usr/bin/env bash
# check-pi-pin.sh — Verifica que Pi está fijado a una versión exacta en todo pihub
# Uso: ./scripts/check-pi-pin.sh
# Falla si: hay "latest", rangos (^, ~), o inconsistencias entre packages/lock/Dockerfile.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ERRORS=0
PI_VERSION=""

echo "=== Verificando pin de Pi ==="

# 1. Verificar que ningún package.json declara Pi con latest, ^, ~ o rango
echo ""
echo "--- Verificando package.json ---"
while IFS= read -r pkg; do
  # Extraer la versión declarada (valor entre las últimas comillas)
  version=$(grep -o '"@earendil-works/pi-coding-agent"[[:space:]]*:[[:space:]]*"[^"]*"' "$pkg" | sed 's/.*: *"\([^"]*\)"/\1/')
  if [ -z "$version" ]; then
    continue
  fi

  echo "  $pkg → $version"

  if [ "$version" = "latest" ]; then
    echo "  ❌ FAIL: usa 'latest' — debe ser versión exacta"
    ERRORS=$((ERRORS + 1))
  elif [[ "$version" =~ ^[\^~] ]]; then
    echo "  ❌ FAIL: usa rango ($version) — debe ser versión exacta"
    ERRORS=$((ERRORS + 1))
  else
    # Es versión exacta (ej. 0.80.3)
    if [ -z "$PI_VERSION" ]; then
      PI_VERSION="$version"
    elif [ "$PI_VERSION" != "$version" ]; then
      echo "  ❌ FAIL: versión inconsistente con otros packages ($PI_VERSION vs $version)"
      ERRORS=$((ERRORS + 1))
    fi
  fi
done < <(find "$REPO_ROOT/packages" -name "package.json" -exec grep -l "@earendil-works/pi-coding-agent" {} \;)

if [ -z "$PI_VERSION" ]; then
  echo "  ❌ FAIL: no se encontró ninguna declaración de @earendil-works/pi-coding-agent"
  ERRORS=$((ERRORS + 1))
fi

# 2. Verificar que el Dockerfile instala la misma versión exacta
echo ""
echo "--- Verificando Dockerfile ---"
if [ -f "$REPO_ROOT/Dockerfile" ]; then
  # Buscar la línea de npm install de pi-coding-agent
  pi_install_line=$(grep "pi-coding-agent" "$REPO_ROOT/Dockerfile" || true)
  if [ -z "$pi_install_line" ]; then
    echo "  ❌ FAIL: Dockerfile no instala @earendil-works/pi-coding-agent"
    ERRORS=$((ERRORS + 1))
  else
    echo "  Línea: $pi_install_line"
    # Verificar que no tenga latest ni rango
    if echo "$pi_install_line" | grep -q '"latest"'; then
      echo "  ❌ FAIL: Dockerfile usa 'latest' — debe ser versión exacta"
      ERRORS=$((ERRORS + 1))
    elif echo "$pi_install_line" | grep -q "@earendil-works/pi-coding-agent$" ; then
      echo "  ❌ FAIL: Dockerfile instala sin versión — debe ser @earendil-works/pi-coding-agent@X.Y.Z"
      ERRORS=$((ERRORS + 1))
    elif [ -n "$PI_VERSION" ]; then
      if echo "$pi_install_line" | grep -q "@${PI_VERSION}"; then
        echo "  ✅ Dockerfile usa versión exacta $PI_VERSION"
      else
        echo "  ❌ FAIL: Dockerfile usa versión diferente a $PI_VERSION"
        ERRORS=$((ERRORS + 1))
      fi
    fi
  fi
else
  echo "  ⚠️  No se encontró Dockerfile"
fi

# 3. Verificar que no hay "latest" en ningún package.json del repo
echo ""
echo "--- Verificando 'latest' en todo el repo ---"
latest_refs=$(grep -r '"@earendil-works/pi-coding-agent"[[:space:]]*:[[:space:]]*"latest"' "$REPO_ROOT" --include="package.json" 2>/dev/null || true)
if [ -n "$latest_refs" ]; then
  echo "  ❌ FAIL: se encontraron referencias a 'latest':"
  echo "$latest_refs"
  ERRORS=$((ERRORS + 1))
else
  echo "  ✅ No hay referencias a 'latest'"
fi

echo ""
echo "=== Resultado ==="
if [ "$ERRORS" -gt 0 ]; then
  echo "❌ FAIL: $ERRORS error(es) encontrado(s)"
  exit 1
else
  echo "✅ Todo OK — Pi fijado a $PI_VERSION"
  exit 0
fi