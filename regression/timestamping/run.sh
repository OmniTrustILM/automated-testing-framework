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
# shellcheck source=lib/published.sh
source "${SUITE_DIR}/lib/published.sh"
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
# Source selection accumulated from the command line, applied over config.env by
# select_component_sources. --published wins over --local so a personal
# LOCAL_COMPONENTS=all can be relaxed for one run without editing config.env.
CLI_LOCAL=""
CLI_PUBLISHED=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Runs the full cycle by default: repositories -> artifacts -> containers -> Core -> provisioning -> tests.
Every component is taken from the registry unless it is listed as local, so a plain run needs
no checkout other than development-environment. The stack is left running afterwards for
debugging; stop it with --teardown.

Component sources:
  --local LIST           Build these components from a checkout instead of pulling them.
                         Comma-separated; 'all' means every component below except the
                         platform ones, which have to be named explicitly.
                         Components: $(printf '%s ' "${COMPONENTS[@]}")
                         Platform:   $(printf '%s ' "${INFRA_COMPONENTS[@]}")
  --published LIST       Force these components back to the registry, overriding --local
                         and LOCAL_COMPONENTS in config.env
  --published-ref REF    Which published build to use: develop (default, the head of main),
                         release (the newest tag), or a literal tag such as develop-<sha>
  --<component>-tag TAG  Pin one component to a specific published tag
  --<repo>-ref REF       Git ref for one checkout; implies --local <repo>

Examples:
  $(basename "$0")                              QA: everything published
  $(basename "$0") --local interfaces,core      Maven side local, images published
  $(basename "$0") --local timestamp-formatting-connector   one image local
  $(basename "$0") --local all                  build everything from sources

Options:
  --ref REF              Git ref for every checkout (default: main)
  --clone                Clone repositories that are missing from the workspace. Without it a
                         missing checkout is an error naming the git command to run
  --clean                Wipe the PostgreSQL data directory before starting (re-provisions
                         everything, issues fresh TSA certificates)
  --no-pull              Do not fetch or check out anything; build the checkouts as they are
  --no-build             Skip the pulls and the Maven and Docker builds, reuse what is there
  --no-stack             Do not recreate the containers
  --no-core              Do not restart a locally built Core
  --no-provision         Skip provisioning, assume the environment is already provisioned
  --tests-only           Only run the tests against a running, provisioned environment
  --skip-slow            Skip tests tagged @slow (the time-quality degradation scenarios)
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
      --local)          CLI_LOCAL="${CLI_LOCAL},$2"; shift 2 ;;
      --published)      CLI_PUBLISHED="${CLI_PUBLISHED},$2"; shift 2 ;;
      --published-ref)  CLI_OVERRIDES+=("PUBLISHED_REF=$2"); shift 2 ;;
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
      --*-tag)
        local tagged="${1#--}"; tagged="${tagged%-tag}"
        component_is_known "$tagged" || { echo "Unknown component in option $1" >&2; usage 1; }
        CLI_OVERRIDES+=("PUBLISHED_TAG_${tagged//-/_}=$2")
        shift 2 ;;
      # Asking for a ref is asking for a source build, so the component follows the checkout.
      --*-ref)
        local repo="${1#--}"; repo="${repo%-ref}"
        [[ "$repo" == "development-environment" ]] || component_is_known "$repo" \
          || { echo "Unknown repository in option $1" >&2; usage 1; }
        CLI_OVERRIDES+=("REPO_REF_${repo//-/_}=$2")
        [[ "$repo" == "development-environment" ]] || CLI_LOCAL="${CLI_LOCAL},${repo}"
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
  require_command node "Node.js, for the Playwright suite"
  require_command npm
  if component_is_local core; then
    [[ "$SKIP_CORE" == "true" ]] || require_command lsof
    command -v "$JAVA_BIN" &>/dev/null || die "Java not found: ${JAVA_BIN}"
  fi
  if component_is_local core || component_is_local interfaces; then
    command -v "$MVN_BIN" &>/dev/null || die "Maven not found: ${MVN_BIN}"
  fi
  docker info >/dev/null 2>&1 || die "Docker is not running"
}

start_run_dir() {
  RUN_DIR="${SUITE_DIR}/runs/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$RUN_DIR"
  ln -sfn "$RUN_DIR" "${SUITE_DIR}/runs/latest"
  jq -n --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg ilmHost "$ILM_HOST" \
    --arg publishedTag "$PUBLISHED_TAG" --arg registry "$PUBLISHED_REGISTRY" \
    '{startedAt: $started, ilmHost: $ilmHost, registry: $registry, publishedTag: $publishedTag,
      components: {}, core: {}, result: "running"}' \
    > "${RUN_DIR}/manifest.json"

  # The overlay decides which images the stack runs; keep it with the run it belongs to.
  local overlay; overlay=$(published_overlay_file)
  [[ -f "$overlay" ]] && cp "$overlay" "${RUN_DIR}/compose-published.yml"
  return 0
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
  # One line per component, whatever its source, because "what was this run actually
  # testing" is the first question asked of a red result.
  jq -r '
    "run          : " + (.startedAt) + " -> " + (.finishedAt // "n/a"),
    "core jar     : " + (.core.jar // "n/a (published Core)"),
    (.components | to_entries[] | "component    : " + (.key | . + (" " * (32 - length))) +
      (if .value.source == "published"
       then "published  " + (.value.tag // "?") + " @ " + ((.value.digest // "unknown")[0:19])
       else "local      " + (.value.ref // "?") + " @ " + ((.value.sha // "")[0:8]) +
            (if .value.dirty then "  (DIRTY)" else "" end)
       end))
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

  if component_is_local core; then
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
  write_published_overlay

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
    phase_artifacts
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
