#!/usr/bin/env bash
# Phase: run a locally built Core on the host from its freshly built jar.
#
# Only reached when core is a local component. A published Core runs as the Compose `core`
# service instead, brought up with the rest of the stack.
#
# A locally built Core is deliberately not containerised: the published image trails the
# database schema a locally built Core leaves behind, and Flyway then aborts with
# "Detected applied migration not resolved locally". Host mode also matches the connector
# host defaults used by the provisioning script.

CORE_PID_FILE_NAME="core.pid"
CORE_PROCESS_TOKEN_PROPERTY="ilm.timestampingRegressionRun"

core_pid_file() { echo "${SUITE_DIR}/.state/${CORE_PID_FILE_NAME}"; }

core_process_matches() {
  local pid="$1" token="$2"
  [[ -n "$pid" && -n "$token" ]] \
    && kill -0 "$pid" 2>/dev/null \
    && ps -ww -o command= -p "$pid" 2>/dev/null | grep -Fq -- "-D${CORE_PROCESS_TOKEN_PROPERTY}=${token}"
}

stop_core() {
  local pid_file pid token
  pid_file=$(core_pid_file)

  if [[ -f "$pid_file" ]]; then
    pid=$(sed -n '1p' "$pid_file")
    token=$(sed -n '2p' "$pid_file")
    if core_process_matches "$pid" "$token"; then
      log "stopping Core (pid ${pid})"
      kill "$pid" 2>/dev/null || true
      local waited=0
      while core_process_matches "$pid" "$token" && (( waited < 30 )); do
        sleep 1
        waited=$((waited + 1))
      done
      core_process_matches "$pid" "$token" && kill -9 "$pid" 2>/dev/null || true
    elif [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      warn "pid ${pid} from $(basename "$pid_file") does not carry this runner's process token — leaving it alone"
    fi
    rm -f "$pid_file"
  fi
}

ensure_core_port_available() {
  local port_pids commands
  port_pids=$(lsof -ti "tcp:${CORE_PORT}" -sTCP:LISTEN 2>/dev/null || true)
  [[ -z "$port_pids" ]] && return 0

  commands=$(ps -o pid=,command= -p "$(echo "$port_pids" | paste -sd, -)" 2>/dev/null || true)
  die "Port ${CORE_PORT} is held by a process this runner did not start:
${commands:-    pid(s): $(echo "$port_pids" | tr '\n' ' ')}
Stop it explicitly or choose another CORE_PORT; the regression runner will not kill unmanaged processes."
}

start_core() {
  local pid_file core_log pid process_token
  pid_file=$(core_pid_file)
  core_log="${RUN_DIR}/core.log"
  process_token="${RUN_DIR##*/}-$$"

  ensure_core_port_available
  log "starting $(basename "$CORE_JAR") on port ${CORE_PORT}"
  (
    cd "$(dirname "$CORE_JAR")" || exit 1
    JDBC_URL="jdbc:postgresql://localhost:${DB_HOST_PORT}/${DB_NAME}?sslmode=${DB_SSLMODE:-disable}" \
    JDBC_USERNAME="${DB_USERNAME}" \
    JDBC_PASSWORD="${DB_PASSWORD}" \
    OPA_BASE_URL="http://localhost:8181" \
    AUTH_SERVICE_BASE_URL="http://localhost:8100" \
    SCHEDULER_BASE_URL="http://localhost:8102" \
    BROKER_URL="amqp://localhost:5672" \
    BROKER_USERNAME="guest" \
    BROKER_PASSWORD="guest" \
    BROKER_VIRTUAL_HOST="" \
    MESSAGING_TIME_QUALITY_ENABLED="true" \
    LOGGING_LEVEL_COM_OTILM="${CORE_LOG_LEVEL:-INFO}" \
    PORT="${CORE_PORT}" \
    nohup "$JAVA_BIN" "-D${CORE_PROCESS_TOKEN_PROPERTY}=${process_token}" -jar "$CORE_JAR" > "$core_log" 2>&1 &
    printf '%s\n%s\n' "$!" "$process_token" > "$pid_file"
  )
  pid=$(sed -n '1p' "$pid_file")
  ok "Core started (pid ${pid}), log: ${core_log}"

  local waited=0
  while (( waited < 300 )); do
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -40 "$core_log" >&2
      die "Core exited during startup — full log: ${core_log}"
    fi
    # Readiness, not liveness: Core answers liveness before the database, messaging and
    # authorization wiring is complete, and provisioning against it fails intermittently.
    if curl -s -f -o /dev/null "${ILM_HOST}/api/v1/health/readiness"; then
      ok "Core is ready after ${waited}s"
      return 0
    fi
    sleep 3; waited=$((waited + 3))
  done
  tail -40 "$core_log" >&2
  die "Core did not become ready within 300s — full log: ${core_log}"
}

phase_core() {
  component_is_local core || return 0
  section "Core (local, java -jar)"
  mkdir -p "${SUITE_DIR}/.state"
  manifest_set '.core.jar' "$CORE_JAR"
  stop_core
  start_core
}
