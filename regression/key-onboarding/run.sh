#!/usr/bin/env bash
# Runs the key onboarding suite against a running stack.

set -euo pipefail

SUITE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
CONFIG="${SUITE_DIR}/config.env"

[[ -f "$CONFIG" ]] || { echo "ERROR: ${CONFIG} not found; copy config.env.example and fill it in" >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. "$CONFIG"
set +a

RUN_DIR="${SUITE_DIR}/runs/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN_DIR"
ln -sfn "$RUN_DIR" "${SUITE_DIR}/runs/latest"
export RUN_DIR

cd "${SUITE_DIR}/tests"
if [[ ! -d node_modules ]]; then
  npm install --no-audit --no-fund > "${RUN_DIR}/npm-install.log" 2>&1 \
    || { echo "ERROR: npm install failed; see ${RUN_DIR}/npm-install.log" >&2; exit 1; }
fi
npx playwright test "$@"
