#!/usr/bin/env bash
# uninstall.sh — Retira el servicio de pihub instalado por install.sh.
#
# Uso:
#   sudo ./scripts/uninstall.sh              # quita servicio y código; CONSERVA datos y config
#   sudo ./scripts/uninstall.sh --purge      # borra además /var/lib/pihub y /etc/pihub
#
# Por defecto NO borra nada irrecuperable: los agentes, su memoria y sus
# credenciales viven en /var/lib/pihub, y desinstalar el servicio no es lo mismo
# que querer perderlos.

set -euo pipefail

PREFIX=/opt/pihub
DATA_DIR=/var/lib/pihub
CONFIG_DIR=/etc/pihub
UNIT_FILE=/etc/systemd/system/pihub.service
PURGE=0

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge)   PURGE=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *)         die "opción desconocida: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "hay que ejecutarlo como root (usa sudo)."

if systemctl list-unit-files pihub.service >/dev/null 2>&1; then
  log "Parando y deshabilitando el servicio"
  systemctl stop pihub    >/dev/null 2>&1 || true
  systemctl disable pihub >/dev/null 2>&1 || true
fi

rm -f "$UNIT_FILE" /usr/local/bin/pihub
systemctl daemon-reload

log "Quitando el código de $PREFIX"
rm -rf "$PREFIX"

if [[ $PURGE -eq 1 ]]; then
  warn "Borrando datos y configuración (--purge)"
  rm -rf "$DATA_DIR" "$CONFIG_DIR"
  log "pihub desinstalado por completo"
else
  log "pihub desinstalado"
  echo "   Se conservan (bórralos a mano si ya no los necesitas):"
  echo "     $DATA_DIR   — agentes, memoria y credenciales"
  echo "     $CONFIG_DIR — API_TOKEN y configuración"
  echo "   O reinstala y seguirán donde estaban."
fi
