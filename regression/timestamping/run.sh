#!/usr/bin/env bash
# Timestamping regression suite runner.
#
# One invocation: check out (and with --clone, clone) every dependent repository including
# development-environment, rebuild Core and the connector images, recreate the dependency
# containers, start Core on the host, provision the timestamping objects and run the API
# regression suite against them.
#
# See README.md in this directory.

set -euo pipefail

SUITE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ATF_ROOT="$(cd -- "${SUITE_DIR}/../.." && pwd)"
# development-environment is one of the repositories the suite manages, so its checkout is
# resolved under WORKSPACE_DIR by load_config rather than derived from this file's location.
DEV_DIR=""

# shellcheck source=lib/common.sh
source "${SUITE_DIR}/lib/common.sh"
# shellcheck source=lib/repos.sh
source "${SUITE_DIR}/lib/repos.sh"
# shellcheck source=lib/build.sh
source "${SUITE_DIR}/lib/build.sh"
# shellcheck source=lib/stack.sh
source "${SUITE_DIR}/lib/stack.sh"
# shellcheck source=lib/core.sh
source "${SUITE_DIR}/lib/core.sh"
# shellcheck source=lib/provision.sh
source "${SUITE_DIR}/lib/provision.sh"

DEFAULT_REF="main"
CLONE="false"
CLEAN="false"
SKIP_PULL="false"
SKIP_BUILD="false"
SKIP_STACK="false"
SKIP_CORE="false"
SKIP_PROVISION="false"
SKIP_SLOW="false"
TESTS_ONLY="false"
GREP_PATTERN=""
ACTION="run"
CORE_JAR=""
RUN_DIR=""
RUN_FINALIZED="false"
RUN_TERMINATION=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Runs the full cycle by default: repositories -> build -> containers -> Core -> provisioning -> tests.
The stack and Core are left running afterwards for debugging; stop them with --teardown.

Options:
  --ref REF              Git ref for every repository (default: main)
  --<repo>-ref REF       Git ref for one repository. Known repositories:
                         $(printf '%s ' "${ALL_REPOS[@]}")
  --clone                Clone repositories that are missing from the workspace. Without it a
                         missing checkout is an error naming the git command to run
  --clean                Wipe the PostgreSQL data directory before starting (re-provisions
                         everything, issues fresh TSA certificates)
  --no-pull              Do not fetch or check out anything; build the checkouts as they are
  --no-build             Skip the Maven and Docker builds, reuse the existing artifacts
  --no-stack             Do not recreate the containers
  --no-core              Do not restart Core
  --no-provision         Skip provisioning, assume the environment is already provisioned
  --tests-only           Only run the tests against a running, provisioned environment
  --skip-slow            Skip tests tagged \@slow (the time-quality degradation scenarios)
  --grep PATTERN         Only run tests whose title matches PATTERN
  --teardown             Stop Core and the containers, then exit
  --status               Show what is currently running, then exit
  -h, --help             Show this help

Configuration lives in config.env (copy config.env.example). Repository checkouts are
resolved under WORKSPACE_DIR, by default the parent of the automated-testing-framework
checkout. Run artifacts, logs and reports are written to runs/<timestamp>/, with runs/latest
pointing at the newest run.
EOF
  exit "${1:-0}"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --ref)            DEFAULT_REF="$2"; shift 2 ;;
      --clone)          CLONE="true"; shift ;;
      --clean)          CLEAN="true"; shift ;;
      --no-pull)        SKIP_PULL="true"; shift ;;
      --no-build)       SKIP_BUILD="true"; shift ;;
      --no-stack)       SKIP_STACK="true"; shift ;;
      --no-core)        SKIP_CORE="true"; shift ;;
      --no-provision)   SKIP_PROVISION="true"; shift ;;
      --tests-only)     TESTS_ONLY="true"; shift ;;
      --skip-slow)      SKIP_SLOW="true"; shift ;;
      --grep)           GREP_PATTERN="$2"; shift 2 ;;
      --teardown)       ACTION="teardown"; shift ;;
      --status)         ACTION="status"; shift ;;
      -h|--help)        usage 0 ;;
      --*-ref)
        local repo="${1#--}"; repo="${repo%-ref}"
        local known="false" candidate
        for candidate in "${ALL_REPOS[@]}"; do [[ "$candidate" == "$repo" ]] && known="true"; done
        [[ "$known" == "true" ]] || { echo "Unknown repository in option $1" >&2; usage 1; }
        printf -v "REPO_REF_${repo//-/_}" '%s' "$2"
        export "REPO_REF_${repo//-/_}"
        shift 2 ;;
      *) echo "Unknown option: $1" >&2; usage 1 ;;
    esac
  done

  if [[ "$TESTS_ONLY" == "true" ]]; then
    SKIP_PULL="true"; SKIP_BUILD="true"; SKIP_STACK="true"; SKIP_CORE="true"; SKIP_PROVISION="true"
  fi
}

preflight() {
  require_command docker "Docker with the Compose plugin"
  require_command jq
  require_command curl
  require_command openssl
  require_command git
  [[ "$SKIP_CORE" == "true" ]] || require_command lsof
  require_command node "Node.js, for the Playwright suite"
  require_command npm
  command -v "$MVN_BIN" &>/dev/null || die "Maven not found: ${MVN_BIN}"
  command -v "$JAVA_BIN" &>/dev/null || die "Java not found: ${JAVA_BIN}"
  docker info >/dev/null 2>&1 || die "Docker is not running"
}

start_run_dir() {
  RUN_DIR="${SUITE_DIR}/runs/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$RUN_DIR"
  ln -sfn "$RUN_DIR" "${SUITE_DIR}/runs/latest"
  jq -n --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg ilmHost "$ILM_HOST" \
    '{startedAt: $started, ilmHost: $ilmHost, repos: {}, images: {}, core: {}, result: "running"}' \
    > "${RUN_DIR}/manifest.json"
}

finish_run() {
  local result="$1" tmp="${RUN_DIR}/manifest.json.tmp"
  jq --arg result "$result" --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     '.result = $result | .finishedAt = $finished' "${RUN_DIR}/manifest.json" > "$tmp" \
    && mv "$tmp" "${RUN_DIR}/manifest.json" \
    || return 1
  RUN_FINALIZED="true"
}

handle_signal() {
  RUN_TERMINATION="$1"
  exit "$2"
}

finalize_run_on_exit() {
  local exit_code=$?
  trap - EXIT HUP INT TERM
  set +e

  if [[ -n "${RUN_DIR:-}" && -f "${RUN_DIR}/manifest.json" && "$RUN_FINALIZED" != "true" ]]; then
    local result="failed"
    [[ -n "$RUN_TERMINATION" ]] && result="interrupted"
    finish_run "$result" \
      || warn "could not finalize ${RUN_DIR}/manifest.json after exit ${exit_code}"
  fi
  exit "$exit_code"
}

phase_test() {
  section "Tests"
  local tests_dir="${SUITE_DIR}/tests"
  local provisioning_json
  provisioning_json=$(resolve_provisioning_json)

  if [[ ! -d "${tests_dir}/node_modules" ]]; then
    log "installing test dependencies"
    (cd "$tests_dir" && npm install --no-audit --no-fund) > "${RUN_DIR}/npm-install.log" 2>&1 \
      || die "npm install failed — see ${RUN_DIR}/npm-install.log"
  fi

  local args=(test)
  [[ -n "$GREP_PATTERN" ]] && args+=(--grep "$GREP_PATTERN")
  [[ "$SKIP_SLOW" == "true" ]] && args+=(--grep-invert "@slow")

  set +e
  (cd "$tests_dir" && \
    ILM_HOST="$ILM_HOST" \
    ADMIN_CERT_PEM="$ADMIN_CERT_PEM" \
    PROVISIONING_JSON="$provisioning_json" \
    RUN_DIR="$RUN_DIR" \
    npx playwright "${args[@]}")
  TEST_EXIT=$?
  set -e
}

# The suite reads what to exercise from the provisioning summary. When provisioning was
# skipped, reuse the newest earlier one rather than failing on a missing file.
resolve_provisioning_json() {
  local current="${RUN_DIR}/provisioning.json" previous
  if [[ -f "$current" ]]; then echo "$current"; return 0; fi

  previous=$(find "${SUITE_DIR}/runs" -maxdepth 2 -name provisioning.json 2>/dev/null | sort | tail -1)
  [[ -n "$previous" ]] \
    || die "No provisioning summary available. Run once without --no-provision/--tests-only."
  cp "$previous" "$current"
  warn "provisioning skipped — reusing $(dirname "$previous" | xargs basename)/provisioning.json"
  echo "$current"
}

print_summary() {
  local result="$1"
  section "Summary"
  jq -r '
    "run          : " + (.startedAt) + " -> " + (.finishedAt // "n/a"),
    "core jar     : " + (.core.jar // "n/a"),
    (.repos | to_entries[] | "repo         : " + (.key | . + (" " * (32 - length))) + .value.ref + " @ " + (.value.sha[0:8]) + (if .value.dirty then "  (DIRTY)" else "" end))
  ' "${RUN_DIR}/manifest.json"
  echo "    artifacts    : ${RUN_DIR}"
  echo "    report       : ${RUN_DIR}/playwright-report/index.html"
  if [[ "$result" == "passed" ]]; then
    echo "    ${C_GREEN}${C_BOLD}RESULT: PASSED${C_RESET}"
  else
    echo "    ${C_RED}${C_BOLD}RESULT: FAILED${C_RESET}"
  fi
}

show_status() {
  section "Status"
  local container state pid="" token=""
  for container in "${STACK_CONTAINERS[@]}"; do
    state=$(container_state "$container")
    printf '    %-32s %s\n' "$container" "$state"
  done
  local pid_file; pid_file=$(core_pid_file)
  if [[ -f "$pid_file" ]]; then
    pid=$(sed -n '1p' "$pid_file")
    token=$(sed -n '2p' "$pid_file")
  fi
  if [[ -f "$pid_file" ]] && core_process_matches "$pid" "$token"; then
    printf '    %-32s running (pid %s)\n' "core (local)" "$pid"
  else
    printf '    %-32s not running\n' "core (local)"
  fi
  if curl -s -f -o /dev/null "${ILM_HOST}/api/v1/health/liveness"; then
    printf '    %-32s %s\n' "core liveness" "UP"
  else
    printf '    %-32s %s\n' "core liveness" "DOWN"
  fi
}

main() {
  parse_args "$@"
  load_config

  case "$ACTION" in
    teardown) teardown_stack; exit 0 ;;
    status)   show_status; exit 0 ;;
  esac

  preflight
  start_run_dir
  trap finalize_run_on_exit EXIT
  trap 'handle_signal HUP 129' HUP
  trap 'handle_signal INT 130' INT
  trap 'handle_signal TERM 143' TERM
  section "Run ${RUN_DIR##*/}"

  [[ "$SKIP_PULL" == "true" && "$TESTS_ONLY" == "true" ]] || phase_repos
  if [[ "$SKIP_BUILD" == "true" ]]; then
    [[ "$SKIP_CORE" == "true" ]] || resolve_existing_core_jar
  else
    phase_build
  fi
  [[ "$SKIP_STACK" == "true" ]] || phase_stack
  [[ "$SKIP_CORE" == "true" ]] || phase_core
  [[ "$SKIP_PROVISION" == "true" ]] || phase_provision

  TEST_EXIT=0
  phase_test

  local result="failed"
  [[ "$TEST_EXIT" -eq 0 ]] && result="passed"
  finish_run "$result"
  print_summary "$result"
  exit "$TEST_EXIT"
}

main "$@"
