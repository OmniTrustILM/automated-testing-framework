#!/usr/bin/env bash
# Phase: build the artifacts under test.
#   interfaces -> installed into the local Maven repository (Core compiles against the SNAPSHOT)
#   core       -> executable jar, run on the host by lib/core.sh
#   connectors -> Docker images, explicitly built because `compose up` never rebuilds

manifest_set() {
  local path="$1" value="$2" tmp="${RUN_DIR}/manifest.json.tmp"
  jq "${path} = \$v" --arg v "$value" "${RUN_DIR}/manifest.json" > "$tmp" && mv "$tmp" "${RUN_DIR}/manifest.json"
}

# Compose resolves build contexts as ${ILM_SOURCES_BASE_DIR}/<repo>, validated by
# resolve_sources_base_dir to be the workspace. A checkout carrying a local name suffix would
# be silently ignored and the previous image kept, so fail loudly.
verify_compose_build_context() {
  local repo="$1" dir resolved expected_path expected
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

build_maven_projects() {
  local interfaces_dir core_dir
  interfaces_dir=$(repo_dir interfaces) || exit 1
  core_dir=$(repo_dir core) || exit 1

  log "interfaces: mvn clean install (Core compiles against the SNAPSHOT)"
  (cd "$interfaces_dir" && "$MVN_BIN" -B -ntp -DskipTests clean install) \
    > "${RUN_DIR}/build-interfaces.log" 2>&1 \
    || die "interfaces build failed — see ${RUN_DIR}/build-interfaces.log"
  ok "interfaces installed"

  log "core: mvn clean package"
  (cd "$core_dir" && "$MVN_BIN" -B -ntp -DskipTests clean package) \
    > "${RUN_DIR}/build-core.log" 2>&1 \
    || die "core build failed — see ${RUN_DIR}/build-core.log"

  resolve_core_jar "$core_dir"
  manifest_set '.core.jar' "$CORE_JAR"
  ok "core jar: $(basename "$CORE_JAR")"
}

build_images() {
  local repo
  for repo in "${IMAGE_REPOS[@]}"; do verify_compose_build_context "$repo"; done

  log "docker compose build: ${IMAGE_REPOS[*]}"
  compose build "${IMAGE_REPOS[@]}" > "${RUN_DIR}/build-images.log" 2>&1 \
    || die "image build failed — see ${RUN_DIR}/build-images.log"

  local image image_id
  for repo in "${IMAGE_REPOS[@]}"; do
    image="ilm-${repo}"
    image_id=$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || echo "unknown")
    manifest_set ".images[\"${repo}\"]" "$image_id"
    ok "$(printf '%-32s %s' "$image" "${image_id#sha256:}" | cut -c1-58)"
  done
}

phase_build() {
  section "Build"
  build_maven_projects
  build_images
}

# Locates an already-built Core jar when the build phase is skipped.
resolve_existing_core_jar() {
  local core_dir
  core_dir=$(repo_dir core) || exit 1
  [[ -d "${core_dir}/target" ]] || die "No Core target directory — run without --no-build first"
  resolve_core_jar "$core_dir"
}
