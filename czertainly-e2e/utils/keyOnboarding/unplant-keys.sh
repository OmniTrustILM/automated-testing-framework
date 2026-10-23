#!/bin/sh
# Removes one run's objects from a SoftHSM token, the counterpart of plant-keys.sh. It runs as root inside the sidecar
# image, with the sidecar's token volume mounted. pkcs11-tool runs as the sidecar's user, because that user owns the
# token files, and reads the PIN from TOKEN_PIN itself (`--pin env:`), so the PIN is not on its command line either.
# Every private key, public key and certificate whose label starts with LABEL_PREFIX (a run id and a
# hyphen) is deleted; every other object stays. The prefix is compared as plain text, never as a pattern.
# It prints one line: how many objects it deleted.
set -eu

# Exactly one generated run id and its hyphen (qa-reg-<yyyymmdd>-<hhmmss>-<4 base36>-): a shorter prefix, such as a
# date alone, would match the labels of other runs. Checked by the shell alone, before any tool runs.
d='[0-9]'
b='[0-9a-z]'
case "${LABEL_PREFIX:-}" in
  qa-reg-$d$d$d$d$d$d$d$d-$d$d$d$d$d$d-$b$b$b$b-) ;;
  *) echo "LABEL_PREFIX must be one generated run id followed by '-'" >&2; exit 2 ;;
esac

apk add --no-cache opensc su-exec >/dev/null

tool() {
  su-exec "$TOKEN_OWNER" pkcs11-tool --module /usr/lib/softhsm/libsofthsm2.so \
    --token-label "$TOKEN_LABEL" --login --pin env:TOKEN_PIN "$@" </dev/null
}

work=$(mktemp -d)
chmod 777 "$work"
trap 'rm -rf "$work"' EXIT

# The run's objects, one "<type><TAB><label>" line each, with the type as --delete-object --type takes it. The prefix
# comes from the environment (awk -v would interpret backslashes) and is matched with index(), not a regex.
run_objects() {
  tool --list-objects >"$work/objects"
  awk '
    /^[^ \t]/ { type = "" }
    /^Private Key Object/ { type = "privkey" }
    /^Public Key Object/ { type = "pubkey" }
    /^Certificate Object/ { type = "cert" }
    type != "" && /^[ \t]+label:/ {
      label = $0
      sub(/^[ \t]+label:[ \t]*/, "", label)
      if (index(label, ENVIRON["LABEL_PREFIX"]) == 1) print type "\t" label
    }' "$work/objects" >"$work/run-objects"
  wc -l <"$work/run-objects" | tr -d ' '
}

before=$(run_objects)
tab=$(printf '\t')
# One delete per listed object. Should one call remove every object of a type and label, the later calls for that
# label find nothing and fail; the second listing below decides.
while IFS="$tab" read -r type label; do
  tool --delete-object --type "$type" --label "$label" >/dev/null 2>&1 || true
done <"$work/run-objects"

after=$(run_objects)
if [ "$after" -ne 0 ]; then
  echo "$after object(s) labelled with the run prefix are still on the token" >&2
  exit 1
fi
echo "$((before - after))"
