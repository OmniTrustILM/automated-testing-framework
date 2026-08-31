#!/usr/bin/env bash
# Shared helpers for the timestamping regression runner.
# Sourced by run.sh; not executable on its own.

# --- Repository topology ------------------------------------------------------
# Repositories the suite depends on. `development-environment` carries the Compose files,
# the provisioning script and the shared .env; `interfaces` and `core` are Maven builds run
# on the host; the rest are Docker images built by Compose from their checkout.
ALL_REPOS=(
  development-environment
  interfaces
  core
  timestamp-formatting-connector
  time-quality-monitor
  common-credential-provider
  ejbca-ng-connector
  software-cryptography-provider
)

IMAGE_REPOS=(
  timestamp-formatting-connector
  time-quality-monitor
  common-credential-provider
  ejbca-ng-connector
  software-cryptography-provider
)

COMPOSE_PROFILES=(
  database
  core-dev
  software-cryptography-provider-standalone
  ejbca-ng-connector-standalone
  common-credential-provider-standalone
  timestamp-formatting-connector-standalone
  time-quality-monitor-standalone
  ntp-standalone
)

# Containers that must reach a healthy state before Core is started.
STACK_CONTAINERS=(
  postgres
  rabbitmq
  opa
  opa-bundles
  auth
  scheduler
  common-credential-provider
  ejbca-ng-connector
  software-cryptography-provider
  timestamp-formatting-connector
  time-quality-monitor
  ntp
)

# --- Output -------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

section() { echo ""; echo "${C_BOLD}${C_BLUE}=== $* ===${C_RESET}"; }
log()     { echo "    $*"; }
ok()      { echo "    ${C_GREEN}OK${C_RESET}  $*"; }
warn()    { echo "    ${C_YELLOW}WARN${C_RESET}  $*" >&2; }
die()     { echo "${C_RED}ERROR${C_RESET}  $*" >&2; exit 1; }

# --- Configuration ------------------------------------------------------------
# Loads the suite config.env (local paths and secrets) and the development environment
# .env (database credentials shared with Compose). Both are sourced through a CR-stripped
# copy: the repository's .env carries CRLF endings, and a trailing \r silently corrupts
# every value (a password with \r fails Core's database login with no useful message).
source_env_file() {
  local file="$1" sanitized
  sanitized=$(mktemp)
  tr -d '\r' < "$file" > "$sanitized"
  # shellcheck disable=SC1090
  set -a; source "$sanitized"; set +a
  rm -f "$sanitized"
}

load_config() {
  local config="${SUITE_DIR}/config.env"
  [[ -f "$config" ]] || die "Missing ${config}. Copy config.env.example and fill in the local paths."
  source_env_file "$config"

  resolve_workspace_dir
  GIT_REMOTE_BASE="${GIT_REMOTE_BASE:-git@github.com:OmniTrustILM}"

  # development-environment holds the Compose files and the .env every other phase reads,
  # so it has to be on disk before anything else can be configured. ensure_repo runs in a
  # command substitution, where its die() would only end the subshell.
  note_missing_repo development-environment
  DEV_DIR=$(ensure_repo development-environment) || exit 1
  bootstrap_dev_env_file
  source_env_file "${DEV_DIR}/.env"
  resolve_sources_base_dir

  : "${ADMIN_CERT_PEM:?ADMIN_CERT_PEM must be set in config.env}"
  : "${EJBCA_PKCS12_BUNDLE:?EJBCA_PKCS12_BUNDLE must be set in config.env}"
  EJBCA_PKCS12_PASSWORD="${EJBCA_PKCS12_PASSWORD:-00000000}"
  CORE_PORT="${CORE_PORT:-8080}"
  ILM_HOST="${ILM_HOST:-http://localhost:${CORE_PORT}}"
  JAVA_BIN="${JAVA_BIN:-java}"
  MVN_BIN="${MVN_BIN:-mvn}"
  DB_HOST_PORT="${DB_HOST_PORT:-5432}"
  DB_NAME="${DB_NAME:-ilm}"

  [[ -f "$ADMIN_CERT_PEM" ]] || die "Admin certificate not found: $ADMIN_CERT_PEM"
  [[ -f "$EJBCA_PKCS12_BUNDLE" ]] || die "EJBCA PKCS12 bundle not found: $EJBCA_PKCS12_BUNDLE"
}

# The directory holding every checkout the suite drives. config.env.example documents the
# default and the layouts it covers.
resolve_workspace_dir() {
  local dir="${WORKSPACE_DIR:-${ATF_ROOT}/..}"
  [[ -d "$dir" ]] || die "WORKSPACE_DIR=${dir} does not exist"
  WORKSPACE_DIR=$(cd -- "$dir" && pwd -P)
}

# A fresh development-environment clone has no .env — it is gitignored — and both Compose and
# Core need it. Generate it from .env.example with the build contexts pointed at the
# workspace. An existing file is never touched.
bootstrap_dev_env_file() {
  local env_file="${DEV_DIR}/.env" example="${DEV_DIR}/.env.example" edits=()
  [[ -f "$env_file" ]] && return 0
  [[ -f "$example" ]] || die "Neither ${env_file} nor ${example} exists"

  edits+=(-e "s|^ILM_SOURCES_BASE_DIR=.*|ILM_SOURCES_BASE_DIR=${WORKSPACE_DIR}|")
  [[ -n "${DB_PASSWORD:-}" ]] && edits+=(-e "s|^DB_PASSWORD=.*|DB_PASSWORD=${DB_PASSWORD}|")
  [[ -n "${DB_HOST_PORT:-}" ]] && edits+=(-e "s|^DB_HOST_PORT=.*|DB_HOST_PORT=${DB_HOST_PORT}|")

  { tr -d '\r' < "$example" | sed "${edits[@]}"; echo; } > "$env_file"
  warn "created ${env_file} from .env.example (ILM_SOURCES_BASE_DIR=${WORKSPACE_DIR})"
}

# Compose resolves build contexts as ${ILM_SOURCES_BASE_DIR}/<repo>, with the
# development-environment root as its working directory. That has to land on the workspace,
# or the connector images would be rebuilt from checkouts this run never refreshed.
resolve_sources_base_dir() {
  local configured="${ILM_SOURCES_BASE_DIR:-.}" base="${ILM_SOURCES_BASE_DIR:-.}"
  [[ "$base" == /* ]] || base="${DEV_DIR}/${base}"
  SOURCES_BASE_DIR=$(cd -- "$base" 2>/dev/null && pwd -P) \
    || die "ILM_SOURCES_BASE_DIR=${configured} in ${DEV_DIR}/.env points at a directory that does not exist (${base})"
  [[ "$SOURCES_BASE_DIR" == "$WORKSPACE_DIR" ]] || die \
    "ILM_SOURCES_BASE_DIR=${configured} in ${DEV_DIR}/.env resolves to ${SOURCES_BASE_DIR}, but the suite drives the checkouts in ${WORKSPACE_DIR}. Compose would build the connector images from sources this run never refreshed. Set ILM_SOURCES_BASE_DIR=${WORKSPACE_DIR}."
}

# --- Repository directory resolution -----------------------------------------
# Checkouts may be named after the repository (timestamp-formatting-connector) or carry a
# local suffix (core-timestamping-regression). Resolution order:
#   1. REPO_DIR_<repo name with dashes as underscores> from config.env
#   2. $WORKSPACE_DIR/<repo>
#   3. any $WORKSPACE_DIR/<repo>-* whose origin remote points at the repository
#   4. $WORKSPACE_DIR itself, for the layout where automated-testing-framework is cloned
#      inside the development-environment working tree
# Prints the directory and returns 0, or returns 1 when nothing matches.
find_repo_dir() {
  local repo="$1" override_var dir candidate
  override_var="REPO_DIR_${repo//-/_}"
  dir="${!override_var:-}"
  if [[ -n "$dir" ]]; then
    [[ -d "$dir/.git" ]] || die "${override_var}=${dir} is not a git checkout"
    (cd -- "$dir" && pwd -P); return 0
  fi

  if [[ -d "${WORKSPACE_DIR}/${repo}/.git" ]]; then
    echo "${WORKSPACE_DIR}/${repo}"; return 0
  fi

  for candidate in "${WORKSPACE_DIR}/${repo}"-*; do
    if repo_origin_matches "$candidate" "$repo"; then echo "$candidate"; return 0; fi
  done

  if repo_origin_matches "$WORKSPACE_DIR" "$repo"; then echo "$WORKSPACE_DIR"; return 0; fi

  return 1
}

repo_origin_matches() {
  local dir="$1" repo="$2" origin
  [[ -d "${dir}/.git" ]] || return 1
  origin=$(git -C "$dir" remote get-url origin 2>/dev/null) || return 1
  [[ "$origin" == *"/${repo}.git" || "$origin" == *"/${repo}" ]]
}

repo_clone_url() {
  local repo="$1" var
  var="REPO_URL_${repo//-/_}"
  echo "${!var:-${GIT_REMOTE_BASE%/}/${repo}.git}"
}

missing_repo_hint() {
  local repo="$1"
  printf '%s' "No checkout found for '${repo}' in ${WORKSPACE_DIR}. Re-run with --clone, or clone it yourself:
        git clone $(repo_clone_url "$repo") ${WORKSPACE_DIR}/${repo}
    If it lives elsewhere, set REPO_DIR_${repo//-/_} in config.env."
}

# Resolves a checkout, failing when it is missing. Used by the phases that only ever run
# after phase_repos has put every repository in place.
repo_dir() {
  local repo="$1" dir
  if dir=$(find_repo_dir "$repo"); then echo "$dir"; return 0; fi
  die "$(missing_repo_hint "$repo")"
}

# Repositories this run had to clone. ensure_repo cannot record it itself: it is called in a
# command substitution, so anything it assigns is lost with the subshell.
CLONED_REPOS=()

note_missing_repo() {
  find_repo_dir "$1" >/dev/null || CLONED_REPOS+=("$1")
}

repo_was_cloned() {
  local candidate
  for candidate in "${CLONED_REPOS[@]:-}"; do
    [[ "$candidate" == "$1" ]] && return 0
  done
  return 1
}

# Resolves a checkout, cloning it into the workspace when --clone was given.
# Progress goes to stderr: the resolved directory is this function's stdout.
ensure_repo() {
  local repo="$1" dir url
  if dir=$(find_repo_dir "$repo"); then echo "$dir"; return 0; fi

  [[ "$CLONE" == "true" ]] || die "$(missing_repo_hint "$repo")"

  url=$(repo_clone_url "$repo")
  dir="${WORKSPACE_DIR}/${repo}"
  log "${repo}: cloning ${url}" >&2
  git clone --quiet "$url" "$dir" >&2 || die "${repo}: git clone ${url} failed"
  echo "$dir"
}

# The git ref to use for a repository: per-repo override, else the global default.
repo_ref() {
  local repo="$1" var
  var="REPO_REF_${repo//-/_}"
  echo "${!var:-$DEFAULT_REF}"
}

# --- Compose ------------------------------------------------------------------
compose() {
  local profile_args=() profile
  for profile in "${COMPOSE_PROFILES[@]}"; do profile_args+=(--profile "$profile"); done
  (cd "$DEV_DIR" && docker compose --file postgres-compose.yml --file ilm-compose.yml \
      "${profile_args[@]}" "$@")
}

# --- ILM admin API ------------------------------------------------------------
# Percent-encoded base64 body of the admin certificate, as the ssl-client-cert header expects.
admin_cert_header() {
  if [[ -z "${ADMIN_CERT_HEADER_VALUE:-}" ]]; then
    ADMIN_CERT_HEADER_VALUE=$(sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' "$ADMIN_CERT_PEM" \
      | grep -v "^-----" | tr -d '\n\r' | sed 's/+/%2B/g; s|/|%2F|g; s/=/%3D/g')
  fi
  echo "$ADMIN_CERT_HEADER_VALUE"
}

# ilm_api METHOD PATH [curl args...] -> response body on stdout, non-zero exit on HTTP error
ilm_api() {
  local method="$1" path="$2"; shift 2
  local body http_code tmp
  tmp=$(mktemp)
  http_code=$(curl -s -o "$tmp" -w "%{http_code}" -X "$method" \
    -H "ssl-client-cert: $(admin_cert_header)" \
    -H "content-type: application/json" \
    "${ILM_HOST}/api${path}" "$@" 2>/dev/null || echo "000")
  body=$(<"$tmp"); rm -f "$tmp"
  echo "$body"
  [[ "$http_code" =~ ^2[0-9][0-9]$ ]]
}

# --- Misc ---------------------------------------------------------------------
require_command() {
  command -v "$1" &>/dev/null || die "Required command not found: $1${2:+ ($2)}"
}

# wait_for_http URL TIMEOUT_SECONDS DESCRIPTION
wait_for_http() {
  local url="$1" timeout="$2" what="$3" waited=0
  while (( waited < timeout )); do
    if curl -s -f -o /dev/null "$url"; then ok "$what is up"; return 0; fi
    sleep 2; waited=$((waited + 2))
  done
  return 1
}
