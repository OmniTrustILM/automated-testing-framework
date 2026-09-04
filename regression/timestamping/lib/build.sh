#!/usr/bin/env bash
# Phase: put the artifacts under test in place.
#   published components -> pulled from the registry (lib/published.sh)
#   interfaces (local)   -> installed into the local Maven repository
#   core       (local)   -> executable jar, run on the host by lib/core.sh
#   image components     -> Docker images, explicitly built because `compose up` never rebuilds

# Compose resolves build contexts as ${ILM_SOURCES_BASE_DIR}/<repo>, validated by
# resolve_sources_base_dir to be the workspace. A checkout carrying a local name suffix would
# be silently ignored and the previous image kept, so fail loudly.
verify_compose_build_context() {
  local component="$1" repo dir resolved expected_path expected
  repo=$(component_repo "$component")
  dir=$(repo_dir "$repo") || exit 1
  resolved=$(cd "$dir" && pwd -P)
  expected_path="${SOURCES_BASE_DIR}/${repo}"

  [[ -d "$expected_path" ]] \
    || die "${repo}: Compose builds from ${expected_path}, but that path does not exist. Rename the checkout or create a symlink to ${resolved}."
  expected=$(cd "$expected_path" && pwd -P)

  [[ "$resolved" == "$expected" ]] && return 0
  die "${repo}: Compose builds from ${expected_path} (${expected}) but the checkout in use is ${resolved}. Point ${expected_path} at the checkout under test, or the build would use different sources."
}

resolve_core_jar() {
  local core_dir="$1" candidates count
  candidates=$(find "${core_dir}/target" -maxdepth 1 -type f -name 'core-*.jar' \
    ! -name '*-sources.jar' ! -name '*-javadoc.jar' ! -name '*-tests.jar' | sort)
  count=$(printf '%s\n' "$candidates" | sed '/^$/d' | wc -l | tr -d ' ')

  [[ "$count" -eq 1 ]] \
    || die "Expected exactly one executable Core jar in ${core_dir}/target, found ${count}. Run a clean build instead of guessing which artifact to execute."
  CORE_JAR="$candidates"
}

# Core's pom resolves the interfaces SNAPSHOT from Maven Central, so a local interfaces build
# is only needed when interfaces itself is under test. `--local core` alone is a valid, and
# much faster, way to test a Core change.
build_maven_projects() {
  local interfaces_dir core_dir

  if component_is_local interfaces; then
    interfaces_dir=$(repo_dir interfaces) || exit 1
    log "interfaces: mvn clean install (Core compiles against the SNAPSHOT)"
    (cd "$interfaces_dir" && "$MVN_BIN" -B -ntp -DskipTests clean install) \
      > "${RUN_DIR}/build-interfaces.log" 2>&1 \
      || die "interfaces build failed — see ${RUN_DIR}/build-interfaces.log"
    ok "interfaces installed"
  fi

  component_is_local core || return 0
  core_dir=$(repo_dir core) || exit 1

  component_is_local interfaces \
    || log "core: resolving the interfaces SNAPSHOT from Maven Central (interfaces is published)"
  log "core: mvn clean package"
  (cd "$core_dir" && "$MVN_BIN" -B -ntp -DskipTests clean package) \
    > "${RUN_DIR}/build-core.log" 2>&1 \
    || die "core build failed — see ${RUN_DIR}/build-core.log"

  resolve_core_jar "$core_dir"
  manifest_set '.core.jar' "$CORE_JAR"
  ok "core jar: $(basename "$CORE_JAR")"
}

# The components Compose has to build from a checkout on this run.
local_image_components() {
  local component
  for component in "${ALL_COMPONENTS[@]}"; do
    [[ "$component" == interfaces || "$component" == core ]] && continue
    component_is_local "$component" && echo "$component"
  done
}

build_images() {
  local component image image_id components=() services=()
  while IFS= read -r component; do components+=("$component"); done < <(local_image_components)
  [[ ${#components[@]} -eq 0 ]] && return 0

  for component in "${components[@]}"; do
    verify_compose_build_context "$component"
    services+=("$(component_service "$component")")
  done

  log "docker compose build: ${services[*]}"
  compose build "${services[@]}" > "${RUN_DIR}/build-images.log" 2>&1 \
    || die "image build failed — see ${RUN_DIR}/build-images.log"

  for component in "${components[@]}"; do
    image=$(component_local_image "$component")
    image_id=$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || echo "unknown")
    manifest_component "$component" "$(jq -n --arg image "$image" --arg id "${image_id#sha256:}" \
      '{source: "local", image: $image, imageId: $id}')"
    ok "$(printf '%-32s %s' "$image" "${image_id#sha256:}" | cut -c1-70)"
  done
}

phase_artifacts() {
  section "Artifacts"
  pull_published_images
  build_maven_projects
  build_images
}

# Locates an already-built Core jar when the artifacts phase is skipped.
resolve_existing_core_jar() {
  local core_dir
  component_is_local core || return 0
  core_dir=$(repo_dir core) || exit 1
  [[ -d "${core_dir}/target" ]] || die "No Core target directory — run without --no-build first"
  resolve_core_jar "$core_dir"
}
