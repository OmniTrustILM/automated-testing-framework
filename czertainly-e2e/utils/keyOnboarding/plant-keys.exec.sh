#!/bin/sh
# Plants key pairs on a SoftHSM token from inside its sidecar (kubectl exec, `sh -s`), the cluster twin of plant-keys.sh.
# It runs as the sidecar's own user, who owns the token files, with nothing installed and nothing written outside the
# token: the sidecar's root filesystem is read-only. pkcs11-tool reads the PIN from TOKEN_PIN itself (`--pin env:`).
# It ends with the line `PLANTED` (set -e: only after every pair). The certified pair gets no certificate here: only
# 25-merge, which runs on a local stack, uploads one.
set -eu
tool() {
    pkcs11-tool --module "$PKCS11_MODULE" --token-label "$TOKEN_LABEL" --login --pin env:TOKEN_PIN "$@" </dev/null
}
quiet() { tool "$@" >/dev/null; }
quiet --keypairgen --key-type rsa:2048 --id "$RSA_ID" --label "$RSA_LABEL"
quiet --keypairgen --key-type EC:prime256v1 --id "$EC_ID" --label "$EC_LABEL"
quiet --keypairgen --key-type EC:prime256v1 --label "$NO_ID_EC_LABEL"
quiet --keypairgen --key-type EC:prime256v1 --id "$SHARED_ID" --label "$SHARED_ID_FIRST_LABEL"
quiet --keypairgen --key-type EC:prime256v1 --id "$SHARED_ID" --label "$SHARED_ID_SECOND_LABEL"
quiet --keypairgen --key-type rsa:2048 --id "$ORPHAN_ID" --label "$ORPHAN_LABEL"
quiet --delete-object --type pubkey --label "$ORPHAN_LABEL"
quiet --keypairgen --key-type rsa:2048 --id "$REMOVABLE_ID" --label "$REMOVABLE_LABEL"
quiet --keypairgen --key-type EC:prime256v1 --id "$BULK_REMOVABLE_FIRST_ID" --label "$BULK_REMOVABLE_FIRST_LABEL"
quiet --keypairgen --key-type EC:prime256v1 --id "$BULK_REMOVABLE_SECOND_ID" --label "$BULK_REMOVABLE_SECOND_LABEL"
quiet --keypairgen --key-type EC:prime256v1 --id "$COMPROMISED_ID" --label "$COMPROMISED_LABEL"
quiet --keypairgen --key-type EC:prime256v1 --id "$CERTIFIED_ID" --label "$CERTIFIED_LABEL"
echo PLANTED
