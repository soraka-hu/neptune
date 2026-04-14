#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
VENV_DIR="$BACKEND_DIR/.venv"

log() {
  printf "\n[%s] %s\n" "$(date '+%H:%M:%S')" "$1"
}

fail() {
  printf "\n[ERROR] %s\n" "$1" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing command: $1"
  fi
}

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  fail "Python is required (python3 or python)."
fi

NODE_BIN="node"
NPM_BIN="npm"

require_cmd "$NODE_BIN"
require_cmd "$NPM_BIN"

if [ ! -d "$BACKEND_DIR" ] || [ ! -d "$FRONTEND_DIR" ]; then
  fail "Run this script from the project root (or keep the default repository structure)."
fi

log "Using Python: $($PYTHON_BIN --version 2>&1)"
log "Using Node: $($NODE_BIN --version)"
log "Using npm: $($NPM_BIN --version)"

if [ ! -d "$VENV_DIR" ]; then
  log "Creating virtual environment at $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
else
  log "Virtual environment already exists at $VENV_DIR"
fi

PIP_BIN="$VENV_DIR/bin/pip"
ALEMBIC_BIN="$VENV_DIR/bin/alembic"

[ -x "$PIP_BIN" ] || fail "pip not found in virtual environment."

log "Upgrading pip/setuptools/wheel"
"$PIP_BIN" install --upgrade pip setuptools wheel

log "Installing backend package and dev dependencies"
(cd "$BACKEND_DIR" && "$PIP_BIN" install -e ".[dev]")

if [ -x "$ALEMBIC_BIN" ]; then
  log "Running database migration (alembic upgrade head)"
  (cd "$BACKEND_DIR" && "$ALEMBIC_BIN" upgrade head)
else
  fail "alembic command not found after installation."
fi

if [ -d "$FRONTEND_DIR/node_modules/.pnpm" ]; then
  log "Cleaning pnpm-style node_modules before npm install"
  rm -rf "$FRONTEND_DIR/node_modules"
fi
log "Installing frontend dependencies with npm"
(cd "$FRONTEND_DIR" && "$NPM_BIN" install)

cat <<'EOF'

Bootstrap complete.

Next steps:
1) Start backend
   cd backend
   source .venv/bin/activate
   uvicorn app.main:app --reload --port 8000

2) Start frontend (new terminal)
   cd frontend
   npm run dev

Optional local infra (PostgreSQL/Redis/MinIO/Prometheus):
   docker compose -f infra/docker-compose.yml up -d

EOF
