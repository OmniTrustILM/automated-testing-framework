#!/bin/sh
# Removes one run's objects from a SoftHSM token from inside its sidecar (kubectl exec, `sh -s`), the cluster twin of
# unplant-keys.sh: the same prefix rule, no temporary files (the sidecar's root filesystem is read-only). It runs as the
# sidecar's own user and reads the PIN from TOKEN_PIN (`--pin env:`). Every private key, public key, certificate, secret
# key and data object whose label starts with LABEL_PREFIX (a run id and a hyphen) is deleted and counted, and the re-list
# proves none is left; every other object stays. The prefix
# is compared as plain text, never as a pattern. It prints one line: how many objects it deleted.
set -eu

d='[0-9]'
b='[0-9a-z]'
case "${LABEL_PREFIX:-}" in
  qa-reg-$d$d$d$d$d$d$d$d-$d$d$d$d$d$d-$b$b$b$b-) ;;
  *) echo "LABEL_PREFIX must be one generated run id followed by '-'" >&2; exit 2 ;;
esac

tool() {
  pkcs11-tool --module "$PKCS11_MODULE" --token-label "$TOKEN_LABEL" --login --pin env:TOKEN_PIN "$@" </dev/null
}

# The run's objects of a listing, one "<type><TAB><label>" line each (see unplant-keys.sh): the prefix comes from the
# environment and is matched with index(), not a regex; POSIX classes, as busybox awk reads them. Each listing is a plain
# assignment, so a failing pkcs11-tool stops the script (set -e) instead of looking like an empty token.
run_objects() {
  printf '%s\n' "$1" | awk '
    /^[^[:space:]]/ { type = "" }
    /^Private Key Object/ { type = "privkey" }
    /^Public Key Object/ { type = "pubkey" }
    /^Certificate Object/ { type = "cert" }
    /^Secret Key Object/ { type = "secrkey" }
    /^Data object/ { type = "data" }
    type != "" && /^[[:space:]]+label:/ {
      label = $0
      sub(/^[[:space:]]+label:[[:space:]]*/, "", label)
      # pkcs11-tool quotes the label of a data object (39: the quote character, not spelled inside this program)
      q = sprintf("%c", 39)
      if (type == "data" && length(label) >= 2 && substr(label, 1, 1) == q && substr(label, length(label), 1) == q) label = substr(label, 2, length(label) - 2)
      if (index(label, ENVIRON["LABEL_PREFIX"]) == 1) print type "\t" label
    }'
}

listing=$(tool --list-objects)
objects=$(run_objects "$listing")
before=$(printf '%s\n' "$objects" | grep -c . || true)
tab=$(printf '\t')
printf '%s\n' "$objects" | while IFS="$tab" read -r type label; do
  [ -n "$type" ] || continue
  tool --delete-object --type "$type" --label "$label" >/dev/null 2>&1 || true
done

listing=$(tool --list-objects)
left=$(run_objects "$listing")
after=$(printf '%s\n' "$left" | grep -c . || true)
if [ "$after" -ne 0 ]; then
  echo "$after object(s) labelled with the run prefix are still on the token" >&2
  exit 1
fi
echo "$((before - after))"
