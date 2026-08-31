#!/usr/bin/env bash
# Phase: recreate the dependency containers.
# The database lives in a bind mount (./data/postgres/pgsqldata) that survives `compose down`;
# only --clean wipes it, and only through a helper container so root-owned files are removable.

wipe_database_volume() {
  # Deleting the data files of a running PostgreSQL leaves a corrupt cluster behind, so
  # confirm the container is really gone before touching them.
  local state
  state=$(container_state postgres)
  [[ "$state" == "missing" || "$state" == "exited" ]] \
    || die "Refusing to wipe the database: the postgres container is '${state}', not stopped"

  warn "--clean: deleting the PostgreSQL data directory, all provisioning will be re-created"
  docker run --rm -v "${DEV_DIR}/data/postgres:/data" alpine:3 sh -c 'rm -rf /data/pgsqldata' \
    || die "Could not delete the PostgreSQL data directory"
  rm -f "${SUITE_DIR}/.state/provisioning.env"
  ok "database wiped"
}

container_state() {
  local state
  # docker inspect emits a blank line to stdout before failing on an unknown container, so
  # take the last non-empty line rather than whatever the command left behind.
  state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null \
    | tr -d '\r' | grep -v '^$' | tail -1)
  if [[ -n "$state" ]]; then echo "$state"; else echo "missing"; fi
}

# chronyd leaves a pidfile behind in the container filesystem; a plain restart re-reads it
# and the container ends up in a restart loop. Only a recreate clears it.
recreate_ntp_if_stuck() {
  local state
  state=$(container_state ntp)
  [[ "$state" == "healthy" || "$state" == "running" || "$state" == "starting" ]] && return 0
  warn "ntp is '${state}' — recreating it (stale chronyd pidfile is the usual cause)"
  docker rm -f ntp >/dev/null 2>&1 || true
  compose up -d ntp >/dev/null 2>&1 || die "Could not recreate the ntp container"
}

wait_for_containers() {
  local timeout="${1:-300}" waited=0 pending state container
  while (( waited < timeout )); do
    pending=()
    for container in "${STACK_CONTAINERS[@]}"; do
      state=$(container_state "$container")
      [[ "$state" == "healthy" || "$state" == "running" ]] || pending+=("${container}:${state}")
    done
    if [[ ${#pending[@]} -eq 0 ]]; then
      ok "all ${#STACK_CONTAINERS[@]} containers are up"
      return 0
    fi
    (( waited % 30 == 0 )) && log "waiting for: ${pending[*]}"
    (( waited == 60 )) && recreate_ntp_if_stuck
    sleep 5; waited=$((waited + 5))
  done
  die "Containers not ready after ${timeout}s: ${pending[*]}"
}

phase_stack() {
  section "Container stack"
  log "stopping the existing containers"
  compose down --remove-orphans > "${RUN_DIR}/compose-down.log" 2>&1 \
    || die "compose down failed — see ${RUN_DIR}/compose-down.log"

  [[ "$CLEAN" == "true" ]] && wipe_database_volume

  log "starting: ${COMPOSE_PROFILES[*]}"
  compose up -d --force-recreate > "${RUN_DIR}/compose-up.log" 2>&1 \
    || die "compose up failed — see ${RUN_DIR}/compose-up.log"
  wait_for_containers 300
}

# Stops Core and the containers; the database bind mount is left in place.
teardown_stack() {
  section "Teardown"
  stop_core
  if compose down --remove-orphans >/dev/null 2>&1; then
    ok "containers stopped (database preserved; use --clean on the next run to wipe it)"
  else
    die "compose down failed — some containers may still be running"
  fi
}
