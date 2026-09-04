#!/usr/bin/env bash
# Phase: bring the checkouts this run needs to the requested ref.
#
# Only locally sourced components are checked out; published ones come from the registry and
# need no sources at all. development-environment is always in the list — it carries the
# Compose files, the shared .env and the provisioning script.
#
# Dirty checkouts are never touched: the run continues against the working tree and the
# manifest records it, so a red result stays attributable.

# Records one checkout in the run manifest, under the component it provides. The key is the
# component name so the summary can list published and local entries side by side.
manifest_add_checkout() {
  local name="$1" dir="$2" ref="$3" sha="$4" dirty="$5" pulled="$6" cloned="$7"
  manifest_component "$name" "$(jq -n --arg dir "$dir" --arg ref "$ref" --arg sha "$sha" \
    --argjson dirty "$dirty" --argjson pulled "$pulled" --argjson cloned "$cloned" \
    '{source: "local", directory: $dir, ref: $ref, sha: $sha, dirty: $dirty, pulled: $pulled, cloned: $cloned}')"
}

update_repo() {
  local repo="$1" name="${2:-$1}"
  local dir ref sha dirty="false" pulled="false" cloned="false" branch
  note_missing_repo "$repo"
  dir=$(ensure_repo "$repo") || exit 1
  repo_was_cloned "$repo" && cloned="true"
  ref=$(repo_ref "$repo")

  if [[ -n "$(git -C "$dir" status --porcelain)" ]]; then
    dirty="true"
    warn "${repo}: working tree is dirty — skipping fetch/checkout, building what is on disk"
  elif [[ "$SKIP_PULL" == "true" && "$cloned" == "false" ]]; then
    log "${repo}: --no-pull, using the current checkout"
  else
    git -C "$dir" fetch --quiet --prune origin || die "${repo}: git fetch failed"
    branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD)
    if [[ "$branch" != "$ref" ]]; then
      git -C "$dir" checkout --quiet "$ref" || die "${repo}: cannot check out '${ref}'"
    fi
    # Only branches can be fast-forwarded; tags and detached SHAs are already at their target.
    if git -C "$dir" show-ref --verify --quiet "refs/heads/${ref}"; then
      git -C "$dir" merge --ff-only --quiet "origin/${ref}" \
        || die "${repo}: cannot fast-forward '${ref}' onto origin/${ref} (diverged local commits?)"
    fi
    pulled="true"
  fi

  sha=$(git -C "$dir" rev-parse HEAD)
  manifest_add_checkout "$name" "$dir" "$ref" "$sha" "$dirty" "$pulled" "$cloned"

  local suffix=""
  [[ "$cloned" == "true" ]] && suffix=" ${C_BLUE}(cloned)${C_RESET}"
  [[ "$dirty" == "true" ]] && suffix=" ${C_YELLOW}(dirty)${C_RESET}"
  ok "$(printf '%-32s %s @ %s%s' "$repo" "$ref" "${sha:0:8}" "$suffix")"
}

phase_repos() {
  section "Repositories in ${WORKSPACE_DIR} (default ref: ${DEFAULT_REF})"
  update_repo development-environment

  local component
  for component in "${ALL_COMPONENTS[@]}"; do
    component_is_local "$component" || continue
    update_repo "$(component_repo "$component")" "$component"
  done

  any_component_is_local \
    || log "every component is published — no other checkout is needed"
}
