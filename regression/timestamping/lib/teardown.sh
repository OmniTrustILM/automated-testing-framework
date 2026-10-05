#!/usr/bin/env bash
# Teardown: delete the objects of the TSA sets a provisioning summary lists.
#
# Each half of a set goes in the order Core's references allow, and stops at the first object
# Core keeps, since everything after it still refers to that object. A 404 counts as gone, so a
# teardown can be retried. The objects sets share with each other stay: the connectors,
# authority, credential, vault, user, role, time quality configuration, token and token profile.

# What the last teardown_summary left in Core, one line per object with the reason.
TEARDOWN_LEFT=()

# teardown_summary SUMMARY -> non-zero when an object stays behind, listed in TEARDOWN_LEFT.
teardown_summary() {
  local summary="$1" authority half
  TEARDOWN_LEFT=()
  authority=$(jq -r .authority.uuid "$summary")
  while IFS= read -r half; do
    teardown_half "$half" "$authority" || true
  done < <(jq -c '.sets[] | .nonQualified, .qualified' "$summary")
  [[ ${#TEARDOWN_LEFT[@]} -eq 0 ]]
}

teardown_half() {
  local half="$1" authority="$2" name signing_profile
  name=$(jq -r .signingProfile.name <<< "$half")
  signing_profile=$(jq -r .signingProfile.uuid <<< "$half")
  teardown_delete "$name" "TSP activation" PATCH "/v1/signingProfiles/${signing_profile}/protocols/tsp/deactivate" \
    && teardown_delete "$name" "TSP profile" DELETE "/v1/tspProfiles/$(jq -r .tspProfile.uuid <<< "$half")" \
    && teardown_signing_records "$name" "$signing_profile" \
    && teardown_delete "$name" "signing profile" DELETE "/v1/signingProfiles/${signing_profile}" \
    && teardown_delete "$name" certificate DELETE "/v1/certificates/$(jq -r .certificate.uuid <<< "$half")" \
    && teardown_delete "$name" "RA profile" DELETE \
      "/v1/authorities/${authority}/raProfiles/$(jq -r .raProfile.uuid <<< "$half")" \
    && teardown_key "$name" "$(jq -r .key.uuid <<< "$half")"
}

# teardown_delete NAME KIND METHOD PATH [curl args...]
teardown_delete() {
  local name="$1" kind="$2"; shift 2
  ilm_request "$@"
  case "$ILM_STATUS" in
    2??|404) return 0 ;;
    *) teardown_left "$name" "$kind" ;;
  esac
}

teardown_left() {
  TEARDOWN_LEFT+=("${1}: the ${2} answered HTTP ${ILM_STATUS}: ${ILM_BODY:0:200}")
  return 1
}

# A profile collects one signing record per timestamp, so they go a page at a time. The round
# limit ends a loop in which Core reports every delete done but keeps the records.
teardown_signing_records() {
  local name="$1" signing_profile="$2" uuids round
  for (( round = 0; round < 100; round++ )); do
    ilm_request POST "/v1/signingProfiles/${signing_profile}/signingRecords" \
      -d '{"itemsPerPage": 1000, "pageNumber": 1, "filters": []}'
    [[ "$ILM_STATUS" == 404 ]] && return 0
    [[ "$ILM_STATUS" == 2?? ]] || { teardown_left "$name" "signing record listing"; return 1; }
    uuids=$(jq -c '[.items[]?.uuid]' <<< "$ILM_BODY")
    [[ "$uuids" == "[]" ]] && return 0

    # The bulk delete answers with one message per record it could not delete.
    ilm_request DELETE /v1/signingRecords -d "$uuids"
    if [[ "$ILM_STATUS" != 2?? ]] || ! jq -e 'length == 0' <<< "${ILM_BODY:-[]}" >/dev/null 2>&1; then
      teardown_left "$name" "signing record deletion"
      return 1
    fi
  done
  ILM_BODY="records remain after ${round} rounds of deletion"
  teardown_left "$name" "signing record deletion"
}

# An empty body destroys the whole key on its token. Core also answers 404 for a key its token
# has lost while it keeps the key itself (OmniTrustILM/core#2455), so a 404 is checked.
teardown_key() {
  local name="$1" key="$2"
  ilm_request DELETE "/v1/keys/${key}" -d '[]'
  case "$ILM_STATUS" in
    2??) return 0 ;;
    404)
      ilm_request GET "/v1/keys/${key}"
      [[ "$ILM_STATUS" == 404 ]] && return 0
      TEARDOWN_LEFT+=("${name}: Core keeps the key ${key}, which its token has lost (OmniTrustILM/core#2455)")
      return 1
      ;;
    *) teardown_left "$name" key ;;
  esac
}
