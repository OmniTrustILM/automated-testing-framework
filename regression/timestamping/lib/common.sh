#!/usr/bin/env bash
# Shared helpers for the timestamping regression runner.
# Sourced by run.sh; not executable on its own.

# --- Component topology -------------------------------------------------------
# A component is a piece of the system under test. Each one is either `published` — taken
# from the registry, which is the default — or `local`, built from a checkout in the
# workspace. `development-environment` is not a component: it carries the Compose files, the
# shared .env and the provisioning script, so it is always a checkout, in every mode.
#
# COMPONENTS is what `--local all` expands to. INFRA_COMPONENTS are managed the same way but
# stay out of `all`: they are platform services almost nobody has checked out, and letting
# Compose build them implicitly from unmanaged sources is the behaviour this replaces.
COMPONENTS=(
  interfaces
  core
  common-credential-provider
  ejbca-ng-connector
  software-cryptography-provider
  timestamp-formatting-connector
  time-quality-monitor
)

INFRA_COMPONENTS=(
  auth
  scheduler
  opa-bundle-server
)

ALL_COMPONENTS=("${COMPONENTS[@]}" "${INFRA_COMPONENTS[@]}")

# Profiles started on every run. core-standalone is appended by apply_component_sources when
# Core itself comes from the registry.
BASE_COMPOSE_PROFILES=(
  database
  core-dev
  software-cryptography-provider-standalone
  ejbca-ng-connector-standalone
  common-credential-provider-standalone
  timestamp-formatting-connector-standalone
  time-quality-monitor-standalone
  ntp-standalone
)

# Containers that must reach a healthy state before provisioning. `core` is appended by
# apply_component_sources in published mode; a locally built Core runs on the host instead.
BASE_STACK_CONTAINERS=(
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

# Component names are Compose service names wherever a service exists, so only the
# divergences below need mapping. Bash 3.2 has no associative arrays — the suite runs on
# stock macOS bash as well as on Linux — hence the case statements.

# The repository a component is built from, when it is built at all.
component_repo() {
  case "$1" in
    opa-bundle-server) echo "auth-opa-policies" ;;
    *)                 echo "$1" ;;
  esac
}

# The Compose service running a component. Fails for components that have no service:
# `interfaces` is a Maven library, and a locally built Core runs on the host.
component_service() {
  case "$1" in
    interfaces) return 1 ;;
    core)       core_in_container && echo "core" || return 1 ;;
    *)          echo "$1" ;;
  esac
}

# The image name the Compose files use for a locally built component.
component_local_image() {
  case "$1" in
    opa-bundle-server) echo "ilm-opa-bundles" ;;
    *)                 echo "ilm-$1" ;;
  esac
}

# The published image repository, registry included and tag excluded. Fails for components
# that publish no image.
component_image_base() {
  local override="PUBLISHED_IMAGE_${1//-/_}"
  if [[ -n "${!override:-}" ]]; then echo "${!override}"; return 0; fi

  case "$1" in
    core|auth|scheduler|common-credential-provider|ejbca-ng-connector|software-cryptography-provider)
      echo "${PUBLISHED_REGISTRY}/ilm/$1" ;;
    timestamp-formatting-connector|time-quality-monitor)
      echo "${PUBLISHED_REGISTRY}/ilm-private/$1" ;;
    # auth-opa-policies never got an ILM registry publish; only the legacy 3Key Harbor
    # carries it, under the pre-rebranding name. Repoint with PUBLISHED_IMAGE_opa_bundle_server.
    opa-bundle-server)
      echo "harbor.3key.company/czertainly/czertainly-auth-opa-policies" ;;
    # interfaces is a Maven artifact on Maven Central, not an image.
    *) return 1 ;;
  esac
}

component_is_known() {
  local candidate
  for candidate in "${ALL_COMPONENTS[@]}"; do [[ "$candidate" == "$1" ]] && return 0; done
  return 1
}

# --- Component sources --------------------------------------------------------
set_component_source() { printf -v "COMPONENT_SOURCE_${1//-/_}" '%s' "$2"; }

component_source() {
  local var="COMPONENT_SOURCE_${1//-/_}"
  echo "${!var:-published}"
}

component_is_local() { [[ "$(component_source "$1")" == "local" ]]; }

# Core is the one component whose source changes how it runs: built locally it is a jar on
# the host, published it is the Compose service on port CORE_CONTAINER_PORT.
core_in_container() { [[ "$(component_source core)" != "local" ]]; }

# The tag a published component resolves to: per-component pin, else the run-wide default.
component_tag() {
  local var="PUBLISHED_TAG_${1//-/_}"
  echo "${!var:-$PUBLISHED_TAG}"
}

component_image_ref() {
  local base
  base=$(component_image_base "$1") || return 1
  echo "${base}:$(component_tag "$1")"
}

# Turns --published-ref into the tag the publish workflows actually push. Anything that is
# neither alias is passed through, so a digest-pinning `--published-ref develop-<sha>` works.
resolve_published_tag() {
  case "$PUBLISHED_REF" in
    develop) PUBLISHED_TAG="develop-latest" ;;
    release) PUBLISHED_TAG="latest" ;;
    *)       PUBLISHED_TAG="$PUBLISHED_REF" ;;
  esac
}

# Derives everything that depends on which components are local. Called once, after the
# command line and config.env have both been read.
apply_component_sources() {
  resolve_published_tag
  COMPOSE_PROFILES=("${BASE_COMPOSE_PROFILES[@]}")
  STACK_CONTAINERS=("${BASE_STACK_CONTAINERS[@]}")
  if core_in_container; then
    COMPOSE_PROFILES+=(core-standalone)
    STACK_CONTAINERS+=(core)
  fi
}

# Expands one --local/--published list onto the component source table. `all` covers
# COMPONENTS only: the platform services in INFRA_COMPONENTS are checkouts almost nobody has,
# and sweeping them into a source build is never what "everything" means here.
apply_source_list() {
  local list="$1" source="$2" entry component entries=()
  IFS=',' read -r -a entries <<< "$list"
  for entry in "${entries[@]}"; do
    [[ -z "$entry" ]] && continue
    if [[ "$entry" == "all" ]]; then
      [[ "$source" == "local" ]] \
        || die "'all' is only meaningful for --local; name the components to publish"
      for component in "${COMPONENTS[@]}"; do set_component_source "$component" local; done
      continue
    fi
    component_is_known "$entry" \
      || die "Unknown component '${entry}'. Known: $(printf '%s ' "${ALL_COMPONENTS[@]}")"
    set_component_source "$entry" "$source"
  done
}

# LOCAL_COMPONENTS from config.env first, then --local, then --published: the command line
# refines a stored default rather than being merged with it.
select_component_sources() {
  local component
  apply_source_list "${LOCAL_COMPONENTS:-}" local
  apply_source_list "${CLI_LOCAL:-}" local
  apply_source_list "${CLI_PUBLISHED:-}" published

  for component in "${ALL_COMPONENTS[@]}"; do
    component_is_local "$component" && continue
    # A component with no Compose service is not a container and needs nothing pulled:
    # `interfaces` is published to Maven Central and resolved by Core's own build.
    component_service "$component" >/dev/null || continue
    component_image_base "$component" >/dev/null \
      || die "${component} publishes no image; it can only be used with --local ${component}"
  done
}

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

# Options that land in variables config.env may also set. parse_args records them here
# instead of assigning directly, so the command line stays the outer layer.
CLI_OVERRIDES=()

apply_cli_overrides() {
  local entry name
  for entry in "${CLI_OVERRIDES[@]:-}"; do
    [[ -z "$entry" ]] && continue
    name="${entry%%=*}"
    printf -v "$name" '%s' "${entry#*=}"
    export "${name?}"
  done
}

load_config() {
  local config="${SUITE_DIR}/config.env"
  [[ -f "$config" ]] || die "Missing ${config}. Copy config.env.example and fill in the local paths."
  source_env_file "$config"
  # config.env is sourced with `set -a`, so it would otherwise overwrite the very options the
  # command line just set.
  apply_cli_overrides

  resolve_workspace_dir
  GIT_REMOTE_BASE="${GIT_REMOTE_BASE:-git@github.com:OmniTrustILM}"
  PUBLISHED_REGISTRY="${PUBLISHED_REGISTRY:-hub.omnitrustregistry.com}"
  PUBLISHED_REF="${PUBLISHED_REF:-develop}"
  select_component_sources

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
  CORE_CONTAINER_PORT="${CORE_CONTAINER_PORT:-8280}"
  JAVA_BIN="${JAVA_BIN:-java}"
  MVN_BIN="${MVN_BIN:-mvn}"
  DB_HOST_PORT="${DB_HOST_PORT:-5432}"
  DB_NAME="${DB_NAME:-ilm}"

  apply_component_sources
  resolve_core_endpoints

  [[ -f "$ADMIN_CERT_PEM" ]] || die "Admin certificate not found: $ADMIN_CERT_PEM"
  [[ -f "$EJBCA_PKCS12_BUNDLE" ]] || die "EJBCA PKCS12 bundle not found: $EJBCA_PKCS12_BUNDLE"
}

# Where the suite talks to Core, and where Core talks to the connectors. Both follow from
# how Core runs: on the host it shares the connectors' published ports, in a container it
# reaches the same ports through the host gateway.
resolve_core_endpoints() {
  local expected
  if core_in_container; then
    expected="http://localhost:${CORE_CONTAINER_PORT}"
    CONNECTOR_HOST="${CONNECTOR_HOST:-host.docker.internal}"
  else
    expected="http://localhost:${CORE_PORT}"
    CONNECTOR_HOST="${CONNECTOR_HOST:-localhost}"
  fi

  if [[ -z "${ILM_HOST:-}" ]]; then
    ILM_HOST="$expected"
  elif [[ "$ILM_HOST" != "$expected" ]]; then
    warn "ILM_HOST=${ILM_HOST} in config.env, but a $(core_in_container && echo containerised || echo host) Core listens on ${expected}. Comment ILM_HOST out to let it follow the Core source; using the configured value for now."
  fi
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

any_component_is_local() {
  local component
  for component in "${ALL_COMPONENTS[@]}"; do component_is_local "$component" && return 0; done
  return 1
}

# Compose resolves build contexts as ${ILM_SOURCES_BASE_DIR}/<repo>, with the
# development-environment root as its working directory. That has to land on the workspace,
# or the connector images would be rebuilt from checkouts this run never refreshed. With
# every component published nothing is ever built, so the setting cannot mislead anyone.
resolve_sources_base_dir() {
  local configured="${ILM_SOURCES_BASE_DIR:-.}" base="${ILM_SOURCES_BASE_DIR:-.}"
  [[ "$base" == /* ]] || base="${DEV_DIR}/${base}"
  SOURCES_BASE_DIR=$(cd -- "$base" 2>/dev/null && pwd -P) || SOURCES_BASE_DIR=""

  any_component_is_local || return 0

  [[ -n "$SOURCES_BASE_DIR" ]] \
    || die "ILM_SOURCES_BASE_DIR=${configured} in ${DEV_DIR}/.env points at a directory that does not exist (${base})"
  [[ "$SOURCES_BASE_DIR" == "$WORKSPACE_DIR" ]] || die \
    "ILM_SOURCES_BASE_DIR=${configured} in ${DEV_DIR}/.env resolves to ${SOURCES_BASE_DIR}, but the suite drives the checkouts in ${WORKSPACE_DIR}. Compose would build the locally sourced images from sources this run never refreshed. Set ILM_SOURCES_BASE_DIR=${WORKSPACE_DIR}."
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
# The published overlay pins the image of every component this run takes from the registry.
# It lives in .state/ rather than the run directory so --teardown and --status resolve the
# same set of services as the run that started them.
published_overlay_file() { echo "${SUITE_DIR}/.state/compose-published.yml"; }

compose() {
  local args=(--file postgres-compose.yml --file ilm-compose.yml) overlay profile
  overlay=$(published_overlay_file)
  [[ -f "$overlay" ]] && args+=(--file "$overlay")
  for profile in "${COMPOSE_PROFILES[@]}"; do args+=(--profile "$profile"); done
  (cd "$DEV_DIR" && docker compose "${args[@]}" "$@")
}

# --- Run manifest -------------------------------------------------------------
manifest_set() {
  local path="$1" value="$2" tmp="${RUN_DIR}/manifest.json.tmp"
  jq "${path} = \$v" --arg v "$value" "${RUN_DIR}/manifest.json" > "$tmp" && mv "$tmp" "${RUN_DIR}/manifest.json"
}

# Records what a component resolved to. `entry` is a JSON object built by the caller; the
# shape differs per source, and the summary and any downstream report read it back.
manifest_component() {
  local component="$1" entry="$2" tmp="${RUN_DIR}/manifest.json.tmp"
  jq --arg name "$component" --argjson entry "$entry" '.components[$name] = $entry' \
     "${RUN_DIR}/manifest.json" > "$tmp" && mv "$tmp" "${RUN_DIR}/manifest.json"
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
