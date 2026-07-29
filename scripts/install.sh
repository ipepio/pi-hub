#!/usr/bin/env bash
# install.sh — Instala pihub como servicio de systemd en Debian/Ubuntu.
#
# Uso:
#   sudo ./scripts/install.sh                 # el agente corre como root (dueño de la máquina)
#   sudo ./scripts/install.sh --user pihub    # usuario dedicado, sin privilegios de sistema
#   sudo ./scripts/install.sh --no-start      # instala y deja el servicio parado
#   sudo ./scripts/install.sh --governor      # panel web, se configura todo desde ahí (por defecto)
#   sudo ./scripts/install.sh --governed      # sin panel, todo por /api/v1 (para un dashboard externo)
#
# Sin --governor/--governed y con terminal interactiva, pregunta. Sin
# terminal (script no interactivo), instala en modo gobernador.
#
# Idempotente: reinstalar sobre una instalación existente actualiza el código y
# la unidad, y NUNCA toca los datos, el token ni el modo de control ya
# elegidos — --governor/--governed en un reinstall no cambia nada existente
# (ver "Configuración" abajo); para cambiar de modo edita PIHUB_PANEL_ENABLED
# en el config y reinicia el servicio.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PREFIX=/opt/pihub
DATA_DIR=/var/lib/pihub
CONFIG_DIR=/etc/pihub
CONFIG_FILE="$CONFIG_DIR/pihub.env"
UNIT_FILE=/etc/systemd/system/pihub.service
SERVICE_USER=root
SERVICE_GROUP=root
START_SERVICE=1
CONTROL_MODE=""   # "governor" | "governed" | "" (decidir más abajo)

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)      SERVICE_USER="${2:?--user necesita un nombre}"; SERVICE_GROUP="$SERVICE_USER"; shift 2 ;;
    --no-start)  START_SERVICE=0; shift ;;
    --governor)  CONTROL_MODE=governor; shift ;;
    --governed)  CONTROL_MODE=governed; shift ;;
    -h|--help)   sed -n '2,18p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *)           die "opción desconocida: $1" ;;
  esac
done

# --- Comprobaciones previas -------------------------------------------------

[[ $EUID -eq 0 ]] || die "hay que ejecutarlo como root (usa sudo)."
command -v systemctl >/dev/null || die "esto necesita systemd. Para otros sistemas usa Docker: docker compose up -d --build"
command -v apt-get   >/dev/null || die "instalador pensado para Debian/Ubuntu. En otras distros instala Node 22 + uv a mano y copia packaging/pihub.service."

# --- Dependencias del sistema ----------------------------------------------

log "Instalando dependencias del sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git ripgrep >/dev/null

if ! command -v node >/dev/null || [[ "$(node -v | sed 's/^v\([0-9]*\).*/\1/')" -lt 22 ]]; then
  log "Instalando Node 22 (nodesource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq --no-install-recommends nodejs >/dev/null
fi
log "Node $(node -v)"

# uv/uvx: los MCP servers en Python se ejecutan con uvx. Mismo criterio que la
# imagen Docker — sin él queda fuera medio catálogo de MCPs.
if ! command -v uv >/dev/null; then
  log "Instalando uv/uvx"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh >/dev/null
fi
log "uv $(uv --version | awk '{print $2}')"

NODE_BIN="$(command -v node)"

# --- Usuario del servicio ---------------------------------------------------

if [[ "$SERVICE_USER" != root ]]; then
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    log "Creando usuario de servicio '$SERVICE_USER'"
    useradd --system --home-dir "$DATA_DIR/home" --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
fi

# --- Código -----------------------------------------------------------------

log "Copiando pihub a $PREFIX"
mkdir -p "$PREFIX"
# --delete deja $PREFIX igual al repo: sin esto, un fichero borrado del código
# sobreviviría para siempre en la instalación. Los datos NO viven aquí.
if command -v rsync >/dev/null; then
  rsync -a --delete \
    --exclude .git --exclude node_modules --exclude .env \
    "$REPO_ROOT"/ "$PREFIX"/
else
  find "$PREFIX" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  tar -C "$REPO_ROOT" --exclude=.git --exclude=node_modules --exclude=.env -cf - . | tar -C "$PREFIX" -xf -
fi

log "Instalando dependencias y construyendo"
cd "$PREFIX"
npm ci --ignore-scripts --silent
npm run build --silent

# `pihub` en el PATH, igual que en la imagen
ln -sf "$PREFIX/packages/cli/dist/index.js" /usr/local/bin/pihub
chmod +x "$PREFIX/packages/cli/dist/index.js"

# --- Datos ------------------------------------------------------------------

log "Preparando $DATA_DIR"
mkdir -p "$DATA_DIR/home"
if [[ "$SERVICE_USER" != root ]]; then
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$DATA_DIR"
fi

# --- Configuración ----------------------------------------------------------

mkdir -p "$CONFIG_DIR"
if [[ -f "$CONFIG_FILE" ]]; then
  log "Conservando la configuración existente en $CONFIG_FILE (incluido el modo de control)"
else
  # Modo de control: si no vino por flag, pregunta con terminal interactiva;
  # sin terminal (p.ej. un script de provisión), gobernador por defecto —
  # es el que trae panel, así que nunca deja la instalación sin forma de
  # administrarla.
  if [[ -z "$CONTROL_MODE" ]]; then
    if [[ -t 0 ]]; then
      echo
      echo "¿Modo de control?"
      echo "  1) Gobernador — panel web local, se configura todo desde ahí (recomendado)"
      echo "  2) Gobernado  — sin panel, todo por /api/v1 (para un dashboard externo, p.ej. Docker)"
      read -rp "Elige [1]: " respuesta_modo
      case "$respuesta_modo" in
        2) CONTROL_MODE=governed ;;
        *) CONTROL_MODE=governor ;;
      esac
    else
      CONTROL_MODE=governor
      warn "Sin terminal interactiva: se instala en modo gobernador (por defecto)."
      warn "Para modo gobernado: sudo ./scripts/install.sh --governed"
    fi
  fi

  PANEL_ENABLED=true
  [[ "$CONTROL_MODE" == governed ]] && PANEL_ENABLED=false

  log "Generando $CONFIG_FILE con un API_TOKEN nuevo (modo $CONTROL_MODE)"
  TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 43)"
  {
    echo "# Configuración de pihub. Ver .env.example en el repo para todas las opciones."
    echo "# Cambios aquí requieren: systemctl restart pihub"
    echo
    echo "API_TOKEN=$TOKEN"
    echo "PIHUB_MANAGER_PORT=4000"
    echo "PIHUB_AGENT_PORT_RANGE=4100-4199"
    echo "# true = modo gobernador (panel web); false = modo gobernado (solo /api/v1)"
    echo "PIHUB_PANEL_ENABLED=$PANEL_ENABLED"
    echo
    echo "# API keys de proveedores — añade las que uses"
    echo "ANTHROPIC_API_KEY="
    echo "OPENAI_API_KEY="
    echo "GEMINI_API_KEY="
  } > "$CONFIG_FILE"
fi
# El token vive aquí: solo el dueño del servicio puede leerlo.
chmod 600 "$CONFIG_FILE"
[[ "$SERVICE_USER" != root ]] && chown "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG_FILE"

# --- Unidad de systemd ------------------------------------------------------

log "Instalando la unidad de systemd"
sed -e "s|__PIHUB_USER__|$SERVICE_USER|g" \
    -e "s|__PIHUB_GROUP__|$SERVICE_GROUP|g" \
    -e "s|__PIHUB_PREFIX__|$PREFIX|g" \
    -e "s|__PIHUB_DATA__|$DATA_DIR|g" \
    -e "s|__PIHUB_CONFIG__|$CONFIG_FILE|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$PREFIX/packaging/pihub.service" > "$UNIT_FILE"
systemctl daemon-reload
systemctl enable pihub >/dev/null 2>&1

if [[ $START_SERVICE -eq 1 ]]; then
  log "Arrancando pihub"
  systemctl restart pihub
  sleep 2
  systemctl is-active --quiet pihub \
    || die "el servicio no arrancó. Mira: journalctl -u pihub -n 50 --no-pager"
fi

# --- Resumen ----------------------------------------------------------------

PORT="$(grep -E '^PIHUB_MANAGER_PORT=' "$CONFIG_FILE" | cut -d= -f2)"
PANEL_ENABLED_ACTUAL="$(grep -E '^PIHUB_PANEL_ENABLED=' "$CONFIG_FILE" | cut -d= -f2)"
echo
log "pihub instalado"
if [[ "$PANEL_ENABLED_ACTUAL" == false ]]; then
  echo "   modo      gobernado — sin panel, todo por /api/v1 (Authorization: Bearer \$API_TOKEN)"
else
  echo "   modo      gobernador — panel en http://localhost:${PORT:-4000}"
fi
echo "   token     grep API_TOKEN $CONFIG_FILE"
echo "   config    $CONFIG_FILE   (systemctl restart pihub tras editar)"
echo "   cambiar modo: edita PIHUB_PANEL_ENABLED en $CONFIG_FILE y systemctl restart pihub"
echo "   datos     $DATA_DIR"
echo "   logs      journalctl -u pihub -f"
echo
if [[ "$SERVICE_USER" == root ]]; then
  warn "Los agentes corren como root: son dueños de esta máquina y pueden"
  warn "administrarla, abrir conexiones y entrar por SSH a otros equipos."
  warn "Si no es lo que quieres: sudo ./scripts/install.sh --user pihub"
else
  echo "   Los agentes corren como '$SERVICE_USER', sin privilegios de sistema."
fi
