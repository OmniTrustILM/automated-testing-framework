#!/usr/bin/env bash
# Runs the timestamping suite once per target of a matrix descriptor: one Core, and behind it
# every cryptography provider and HSM backend the descriptor names. Each target gets TSA sets
# of its own, provisioned through scripts/timestamping-setup.sh and reused by later runs.
#
# See README.md in this directory.

set -euo pipefail

SUITE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ATF_ROOT="$(cd -- "${SUITE_DIR}/../.." && pwd)"
DEV_DIR=""
CLONE="false"
CORE_MANAGED="false"

# shellcheck source=lib/common.sh
source "${SUITE_DIR}/lib/common.sh"
# shellcheck source=lib/provision.sh
source "${SUITE_DIR}/lib/provision.sh"

MATRIX_FILE=""
FRESH="false"
SKIP_SLOW="false"
GREP_PATTERN=""
SELECTED_TARGETS=()
MATRIX_RUN_DIR=""
FAILED_TARGETS=0
PIN_NAMES=()
PIN_VALUES=()

usage() {
  cat <<EOF
Usage: $(basename "$0") --matrix FILE [options] [TARGET...]

Provisions and tests every target in the matrix descriptor, or only the TARGETs named. Core and
the backends must already be up.

Options:
  --matrix FILE      The matrix descriptor (see matrix.json.example)
  --fresh            Provision new TSA sets for the selected targets instead of reusing them
  --skip-slow        Skip tests tagged @slow
  --grep PATTERN     Only run tests whose title matches PATTERN
  -h, --help         Show this help

A target's token PIN is read from the environment variable its pinEnv names. Results are
written to runs/matrix-<timestamp>/, one directory per target.
EOF
  exit "${1:-0}"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --matrix)    MATRIX_FILE="$2"; shift 2 ;;
      --fresh)     FRESH="true"; shift ;;
      --skip-slow) SKIP_SLOW="true"; shift ;;
      --grep)      GREP_PATTERN="$2"; shift 2 ;;
      -h|--help)   usage 0 ;;
      --*)         echo "Unknown option: $1" >&2; usage 1 ;;
      *)           SELECTED_TARGETS+=("$1"); shift ;;
    esac
  done
  [[ -n "$MATRIX_FILE" ]] || { echo "--matrix is required" >&2; usage 1; }
}

matrix_field() { jq -r "$1 // empty" "$MATRIX_FILE"; }

target_spec() { jq -c --arg name "$1" '.targets[] | select(.name == $name)' "$MATRIX_FILE"; }

# A target's TSA families, one JSON object per line: its own list, else the descriptor's, else the
# built-in rsa and mldsa65. A string names a built-in family; an object's label defaults to its name.
target_families() {
  jq -c --arg name "$1" --arg mldsaCa "${MLDSA_EJBCA_CA:-}" '
    {
      rsa:     {name: "rsa",     label: "RSA",    setupArgs: ["--key-algorithm", "RSA"]},
      mldsa65: {name: "mldsa65", label: "ML-DSA", setupArgs: ["--key-algorithm", "MLDSA", "--ejbca-ca", $mldsaCa]}
    } as $builtin
    | (.targets[] | select(.name == $name).families) // .families // ["rsa", "mldsa65"]
    | .[]
    | if type == "string" then ($builtin[.] // error("unknown built-in family \(.)"))
      else {label: .name, setupArgs: []} + . end' "$MATRIX_FILE"
}

# Family names become part of object names and file paths, and labels part of test titles.
validate_families() {
  local target="$1" families problem
  families=$(target_families "$target" 2>&1) || die "${MATRIX_FILE}: target ${target}: ${families}"
  problem=$(jq -rs '
      (if length == 0 then "names no families" else empty end),
      (map(select((.name // "") | test("^[a-z0-9][a-z0-9-]*$") | not) | .name // "(unnamed)")
        | if length > 0 then "family names must be lower-case letters, digits and dashes: \(join(" "))" else empty end),
      (map(.name) | group_by(.) | map(select(length > 1) | .[0])
        | if length > 0 then "duplicate family names: \(join(" "))" else empty end),
      (map(.label) | group_by(.) | map(select(length > 1) | .[0])
        | if length > 0 then "duplicate family labels: \(join(" "))" else empty end)' <<< "$families")
  [[ -z "$problem" ]] || die "${MATRIX_FILE}: target ${target}: ${problem}"
}

# Target names become part of object names and file paths.
validate_matrix() {
  [[ -f "$MATRIX_FILE" ]] || die "Matrix descriptor not found: ${MATRIX_FILE}"
  jq -e . "$MATRIX_FILE" >/dev/null 2>&1 || die "${MATRIX_FILE} is not valid JSON"

  MATRIX_NAME=$(matrix_field .name)
  [[ "$MATRIX_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "${MATRIX_FILE}: name must be lower-case letters, digits and dashes"
  [[ -n "$(matrix_field .ilmHost)" ]] || die "${MATRIX_FILE}: ilmHost is required"

  local invalid duplicate
  invalid=$(jq -r '.targets[]? | select((.name // "") | test("^[a-z0-9][a-z0-9-]*$") | not) | .name // "(unnamed)"' "$MATRIX_FILE")
  [[ -z "$invalid" ]] || die "${MATRIX_FILE}: target names must be lower-case letters, digits and dashes: ${invalid}"
  duplicate=$(jq -r '[.targets[]?.name] | group_by(.) | map(select(length > 1) | .[0]) | join(" ")' "$MATRIX_FILE")
  [[ -z "$duplicate" ]] || die "${MATRIX_FILE}: duplicate target names: ${duplicate}"
  invalid=$(jq -r '.targets[]? | select(.pinEnv != null and ((.pinEnv | test("^[A-Z_][A-Z0-9_]*$")) | not)) | .name' "$MATRIX_FILE")
  [[ -z "$invalid" ]] || die "${MATRIX_FILE}: pinEnv must name an environment variable: ${invalid}"
  invalid=$(jq -r '[.targets[]? | select(has("mldsa")) | .name] | join(" ")' "$MATRIX_FILE")
  [[ -z "$invalid" ]] || die "${MATRIX_FILE}: mldsa is replaced by families, e.g. \"families\": [\"rsa\"]: ${invalid}"
  local target
  while IFS= read -r target; do validate_families "$target"; done < <(jq -r '.targets[]?.name' "$MATRIX_FILE")

  if [[ ${#SELECTED_TARGETS[@]} -eq 0 ]]; then
    while IFS= read -r target; do SELECTED_TARGETS+=("$target"); done < <(jq -r '.targets[]?.name' "$MATRIX_FILE")
  fi
  [[ ${#SELECTED_TARGETS[@]} -gt 0 ]] || die "${MATRIX_FILE} names no targets"
  for target in "${SELECTED_TARGETS[@]}"; do
    [[ -n "$(target_spec "$target")" ]] || die "Unknown target '${target}'. Known: $(jq -r '[.targets[].name] | join(" ")' "$MATRIX_FILE")"
  done
}

# load_config sources development-environment's .env, which can carry the local SoftHSM's PIN.
# A target's PIN comes only from the environment this runner was started in, so whatever .env
# set is replaced by the exported value, or dropped when nothing was exported.
remember_exported_pins() {
  local name
  while IFS= read -r name; do
    PIN_NAMES+=("$name")
    PIN_VALUES+=("${!name:-}")
  done < <(jq -r '[.targets[]?.pinEnv // empty] | unique[]' "$MATRIX_FILE")
}

restore_exported_pins() {
  local i
  for (( i = 0; i < ${#PIN_NAMES[@]}; i++ )); do
    if [[ -n "${PIN_VALUES[i]}" ]]; then
      export "${PIN_NAMES[i]}=${PIN_VALUES[i]}"
    else
      unset "${PIN_NAMES[i]}"
    fi
  done
}

# The descriptor decides who the administrator is. A client P12 means mTLS, for Core behind an
# ingress; without one the administrator certificate from config.env goes in the header.
configure_matrix_admin() {
  ILM_HOST=$(matrix_field .ilmHost)
  ADMIN_CLIENT_P12=$(matrix_field .adminClientP12)
  ADMIN_CLIENT_P12_PASSWORD=$(matrix_field .adminClientP12Password)
  if [[ -n "$ADMIN_CLIENT_P12" ]]; then
    [[ -f "$ADMIN_CLIENT_P12" ]] || die "Administrator client P12 not found: ${ADMIN_CLIENT_P12}"
    SETUP_AUTH_ARGS=(--auth-mode mtls --client-p12-bundle "$ADMIN_CLIENT_P12" --client-p12-password "$ADMIN_CLIENT_P12_PASSWORD")
  else
    SETUP_AUTH_ARGS=(--client-cert-pem "$ADMIN_CERT_PEM")
  fi
  ilm_api GET /v1/connectors >/dev/null || die "Core at ${ILM_HOST} does not accept the administrator"
}

preflight() {
  require_command jq
  require_command curl
  require_command node "Node.js, for the Playwright suite"
  require_command npm
  require_command perl
  [[ -x "$TIMESTAMPING_SETUP_SCRIPT" ]] || die "Setup script not executable: ${TIMESTAMPING_SETUP_SCRIPT}"
  require_named_set_summary
}

start_matrix_run() {
  MATRIX_RUN_DIR="${SUITE_DIR}/runs/matrix-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$MATRIX_RUN_DIR"
  cp "$MATRIX_FILE" "${MATRIX_RUN_DIR}/descriptor.json"
  chmod 600 "${MATRIX_RUN_DIR}/descriptor.json"
  jq -n --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg matrix "$MATRIX_NAME" --arg ilmHost "$ILM_HOST" \
    --arg script "$TIMESTAMPING_SETUP_SCRIPT" \
    --arg scriptSha256 "$(shasum -a 256 "$TIMESTAMPING_SETUP_SCRIPT" | cut -d' ' -f1)" \
    '{startedAt: $started, matrix: $matrix, ilmHost: $ilmHost,
      setupScript: {path: $script, sha256: $scriptSha256}, targets: []}' \
    > "${MATRIX_RUN_DIR}/matrix.json"
}

# --- TSA sets -----------------------------------------------------------------
# A set is identified by one name, used for its key, profiles and certificate DN alike. The
# name is pinned while the set provisions cleanly, so a later run reuses the set and issues no
# certificate. A failed attempt forgets it: its key may already be bound to an EJBCA end entity.
set_state_file() { echo "${SUITE_DIR}/.state/matrix/${MATRIX_NAME}/$1-$2"; }

set_identity() {
  local state; state=$(set_state_file "$1" "$2")
  if [[ -f "$state" ]]; then cat "$state"; else echo "atf-$1-$2-$(date +%Y%m%d%H%M%S)"; fi
}

# The token defaults to one per target, because a token belongs to one cryptography provider.
# The descriptor's, the target's and the family's arguments follow the defaults in that order, each
# winning over what precedes it; the set's own names come last and are never overridden.
setup_arguments() {
  local target="$1" family="$2" spec="$3" identity="$4" summary="$5" arg pin_env
  SETUP_ARGS=(--ilm-host "$ILM_HOST" "${SETUP_AUTH_ARGS[@]}"
    --pkcs12-bundle "$EJBCA_PKCS12_BUNDLE" --pkcs12-password "$EJBCA_PKCS12_PASSWORD"
    --token-name "atf-${target}" --token-profile-name "atf-${target}")
  while IFS= read -r arg; do SETUP_ARGS+=("$arg"); done < <(jq -r '.setupArgs[]?' "$MATRIX_FILE")
  while IFS= read -r arg; do SETUP_ARGS+=("$arg"); done < <(jq -r '.setupArgs[]?' <<< "$spec")

  pin_env=$(jq -r '.pinEnv // empty' <<< "$spec")
  [[ -n "$pin_env" ]] && SETUP_ARGS+=(--pin-env "$pin_env")
  while IFS= read -r arg; do SETUP_ARGS+=("$arg"); done < <(jq -r '.setupArgs[]' <<< "$family")
  SETUP_ARGS+=(--certificate-dn "$identity" --key-name "$identity" --ra-profile-name "$identity"
    --tsp-profile-name "$identity" --signing-profile-name "$identity" --json-summary "$summary")
}

# provision_set TARGET FAMILY SPEC SUMMARY LOG, where FAMILY is one object from target_families.
provision_set() {
  local target="$1" family="$2" spec="$3" summary="$4" log_file="$5" name identity state
  name=$(jq -r .name <<< "$family")
  identity=$(set_identity "$target" "$name")
  state=$(set_state_file "$target" "$name")
  setup_arguments "$target" "$family" "$spec" "$identity" "$summary"

  log "${name}: ${identity}"
  if "$TIMESTAMPING_SETUP_SCRIPT" "${SETUP_ARGS[@]}" > "$log_file" 2>&1; then
    mkdir -p "$(dirname "$state")"
    echo "$identity" > "$state"
    return 0
  fi

  rm -f "$state"
  # Trusting a CA changes what every user of a shared Core accepts, so that is left to its operator.
  needs_issuer_ca_repair "$log_file" \
    && warn "${name}: the issuing CA is not trusted in Core; upload and trust it, then re-run"
  grep -m5 -E 'ERROR|HTTP [0-9]{3}' "$log_file" | redact_pin "$spec" >&2 || true
  return 1
}

# Masks the target's PIN in whatever it reads, so a leaked PIN is never echoed to the terminal.
redact_pin() {
  local pin_env; pin_env=$(jq -r '.pinEnv // empty' <<< "$1")
  if [[ -z "$pin_env" || -z "${!pin_env:-}" ]]; then cat; return 0; fi
  PIN_VALUE="${!pin_env}" perl -pe 'BEGIN { $pin = $ENV{PIN_VALUE} } s/\Q$pin\E/***/g'
}

# How often the PIN occurs in the target's provisioning output. A short PIN can also match
# inside a UUID or a timestamp, so a hit is a reason to look rather than proof of a leak.
pin_hits() {
  local spec="$1" dir="$2" pin_env
  pin_env=$(jq -r '.pinEnv // empty' <<< "$spec")
  [[ -n "$pin_env" ]] || { echo 0; return 0; }
  local count
  count=$(cat "${dir}"/provisioning*.log "${dir}"/provisioning*.json 2>/dev/null \
    | grep -o -F -- "${!pin_env}" | wc -l) || true
  echo "${count//[[:space:]]/}"
}

# --- Tests --------------------------------------------------------------------
# Tests tagged @docker drive the local Docker stack, so they run only where the descriptor says
# Core is that stack.
run_target_tests() {
  local dir="$1" args=(test) inverted=()
  [[ -n "$GREP_PATTERN" ]] && args+=(--grep "$GREP_PATTERN")
  [[ "$(matrix_field .localStack)" == "true" ]] || inverted+=("@docker")
  [[ "$SKIP_SLOW" == "true" ]] && inverted+=("@slow")
  [[ ${#inverted[@]} -gt 0 ]] && args+=(--grep-invert "$(IFS='|'; echo "${inverted[*]}")")

  local auth_env=(ADMIN_CERT_PEM="$ADMIN_CERT_PEM")
  [[ -n "$ADMIN_CLIENT_P12" ]] \
    && auth_env=(ADMIN_CLIENT_P12="$ADMIN_CLIENT_P12" ADMIN_CLIENT_P12_PASSWORD="$ADMIN_CLIENT_P12_PASSWORD")

  (cd "${SUITE_DIR}/tests" && env "${auth_env[@]}" ILM_HOST="$ILM_HOST" \
    PROVISIONING_JSON="${dir}/provisioning.json" RUN_DIR="$dir" \
    npx playwright "${args[@]}") > "${dir}/playwright.log" 2>&1
}

# Prints "tests failures skipped" from the JUnit report's root element.
junit_counts() {
  local root
  root=$(grep -o -m1 '<testsuites[^>]*>' "$1" 2>/dev/null) || { echo "0 0 0"; return 0; }
  local attribute value counts=()
  for attribute in tests failures skipped; do
    value=$(sed -n "s/.* ${attribute}=\"\([0-9]*\)\".*/\1/p" <<< "$root")
    counts+=("${value:-0}")
  done
  local errors; errors=$(sed -n 's/.* errors="\([0-9]*\)".*/\1/p' <<< "$root")
  echo "${counts[0]} $((counts[1] + ${errors:-0})) ${counts[2]}"
}

# --- One target ---------------------------------------------------------------
record_target() {
  local tmp="${MATRIX_RUN_DIR}/matrix.json.tmp"
  jq --argjson entry "$1" '.targets += [$entry]' "${MATRIX_RUN_DIR}/matrix.json" > "$tmp" \
    && mv "$tmp" "${MATRIX_RUN_DIR}/matrix.json"
}

run_target() {
  local target="$1" spec dir started provisioning="ok" hits=0 tests=0 failures=0 skipped=0 result
  local families=() failed=() family name
  spec=$(target_spec "$target")
  dir="${MATRIX_RUN_DIR}/${target}"
  mkdir -p "$dir"
  started=$(date +%s)
  section "Target ${target}"

  local pin_env; pin_env=$(jq -r '.pinEnv // empty' <<< "$spec")
  if [[ -n "$pin_env" && -z "${!pin_env:-}" ]]; then
    warn "${pin_env} is not set; export the token PIN before running this target"
    provisioning="no PIN"
  else
    # Read up front, because the setup script inherits stdin.
    while IFS= read -r family; do families+=("$family"); done < <(target_families "$target")
    for family in "${families[@]}"; do
      name=$(jq -r .name <<< "$family")
      if ! provision_set "$target" "$family" "$spec" "${dir}/provisioning-${name}.json" "${dir}/provisioning-${name}.log" \
         || ! add_sets_to_summary "${dir}/provisioning.json" "${dir}/provisioning-${name}.json" "$(jq -r .label <<< "$family")"; then
        failed+=("$name")
      fi
    done
    [[ ${#failed[@]} -eq 0 ]] || provisioning="failed: $(IFS=,; echo "${failed[*]}")"
    hits=$(pin_hits "$spec" "$dir")
    [[ "$hits" -eq 0 ]] || warn "the ${pin_env} value occurs ${hits} times in ${dir}; check whether that is the PIN"
  fi

  # The families that did provision are tested even when another one failed.
  if [[ -f "${dir}/provisioning.json" ]]; then
    if run_target_tests "$dir" && [[ ${#failed[@]} -eq 0 ]]; then result="passed"; else result="failed"; fi
    read -r tests failures skipped <<< "$(junit_counts "${dir}/junit.xml")"
    log "tests: $((tests - failures - skipped)) passed, ${failures} failed, ${skipped} skipped — ${dir}/playwright.log"
  else
    result="failed"
  fi
  [[ "$provisioning" == "ok" ]] || log "provisioning ${provisioning} — ${dir}"

  [[ "$result" == "passed" ]] || FAILED_TARGETS=$((FAILED_TARGETS + 1))
  record_target "$(jq -n --arg name "$target" --arg result "$result" --arg provisioning "$provisioning" \
    --argjson tests "$tests" --argjson failures "$failures" --argjson skipped "$skipped" \
    --argjson pinHits "$hits" --argjson seconds "$(( $(date +%s) - started ))" \
    '{name: $name, result: $result, provisioning: $provisioning, tests: $tests, failures: $failures,
      skipped: $skipped, pinHits: $pinHits, seconds: $seconds}')"
}

print_matrix_summary() {
  section "Summary"
  jq -r '.targets[] | [.name, .result, .provisioning, "\(.tests - .failures - .skipped)/\(.tests)",
    (.pinHits | tostring), "\(.seconds)s"] | @tsv' "${MATRIX_RUN_DIR}/matrix.json" \
    | awk -F'\t' 'BEGIN { printf "    %-16s %-8s %-14s %-8s %-8s %s\n", "target", "result", "provisioning", "passed", "pinHits", "time" }
                  { printf "    %-16s %-8s %-14s %-8s %-8s %s\n", $1, $2, $3, $4, $5, $6 }'
  echo "    artifacts: ${MATRIX_RUN_DIR}"
}

main() {
  parse_args "$@"
  require_command jq
  validate_matrix
  remember_exported_pins
  load_config
  restore_exported_pins
  preflight
  configure_matrix_admin

  if [[ ! -d "${SUITE_DIR}/tests/node_modules" ]]; then
    log "installing test dependencies"
    (cd "${SUITE_DIR}/tests" && npm install --no-audit --no-fund) >/dev/null 2>&1 || die "npm install failed"
  fi

  local target name
  if [[ "$FRESH" == "true" ]]; then
    for target in "${SELECTED_TARGETS[@]}"; do
      while IFS= read -r name; do rm -f "$(set_state_file "$target" "$name")"; done < <(target_families "$target" | jq -r .name)
    done
  fi

  start_matrix_run
  section "Matrix ${MATRIX_NAME} against ${ILM_HOST}"
  for target in "${SELECTED_TARGETS[@]}"; do run_target "$target"; done

  local tmp="${MATRIX_RUN_DIR}/matrix.json.tmp"
  jq --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.finishedAt = $finished' "${MATRIX_RUN_DIR}/matrix.json" > "$tmp" \
    && mv "$tmp" "${MATRIX_RUN_DIR}/matrix.json"
  print_matrix_summary
  [[ "$FAILED_TARGETS" -eq 0 ]]
}

main "$@"
