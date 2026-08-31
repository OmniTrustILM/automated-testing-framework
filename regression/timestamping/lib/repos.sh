#!/usr/bin/env bash
# Phase: bring every dependent repository to the requested ref.
# Dirty checkouts are never touched — the run continues against the working tree and the
# manifest records it, so a red result stays attributable.

# Records one repository entry in the run manifest.
manifest_add_repo() {
  local repo="$1" dir="$2" ref="$3" sha="$4" dirty="$5" pulled="$6" cloned="$7"
  local tmp="${RUN_DIR}/manifest.json.tmp"
  jq --arg repo "$repo" --arg dir "$dir" --arg ref "$ref" --arg sha "$sha" \
     --argjson dirty "$dirty" --argjson pulled "$pulled" --argjson cloned "$cloned" \
     '.repos[$repo] = {directory: $dir, ref: $ref, sha: $sha, dirty: $dirty, pulled: $pulled, cloned: $cloned}' \
     "${RUN_DIR}/manifest.json" > "$tmp" && mv "$tmp" "${RUN_DIR}/manifest.json"
}

update_repo() {
  local repo="$1" dir ref sha dirty="false" pulled="false" cloned="false" branch
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
  manifest_add_repo "$repo" "$dir" "$ref" "$sha" "$dirty" "$pulled" "$cloned"

  local suffix=""
  [[ "$cloned" == "true" ]] && suffix=" ${C_BLUE}(cloned)${C_RESET}"
  [[ "$dirty" == "true" ]] && suffix=" ${C_YELLOW}(dirty)${C_RESET}"
  ok "$(printf '%-32s %s @ %s%s' "$repo" "$ref" "${sha:0:8}" "$suffix")"
}

phase_repos() {
  section "Repositories in ${WORKSPACE_DIR} (default ref: ${DEFAULT_REF})"
  local repo
  for repo in "${ALL_REPOS[@]}"; do
    update_repo "$repo"
  done
}
