#!/bin/sh
# Plants key pairs on a SoftHSM token the way a tool outside ILM would. It runs as root inside the sidecar image, with
# the sidecar's token volume mounted. pkcs11-tool runs as the sidecar's user, because that user owns the token files.
# It prints one line: a certificate for the certified pair's public key, base64-encoded DER, from a throwaway issuer.
set -eu

apk add --no-cache opensc openssl su-exec >/dev/null

tool() {
  su-exec "$TOKEN_OWNER" pkcs11-tool --module /usr/lib/softhsm/libsofthsm2.so \
    --token-label "$TOKEN_LABEL" --login --pin "$TOKEN_PIN" "$@" >/dev/null
}

tool --keypairgen --key-type rsa:2048 --id "$RSA_ID" --label "$RSA_LABEL"
tool --keypairgen --key-type EC:prime256v1 --id "$EC_ID" --label "$EC_LABEL"
tool --keypairgen --key-type EC:prime256v1 --label "$NO_ID_EC_LABEL"
tool --keypairgen --key-type EC:prime256v1 --id "$SHARED_ID" --label "$SHARED_ID_FIRST_LABEL"
tool --keypairgen --key-type EC:prime256v1 --id "$SHARED_ID" --label "$SHARED_ID_SECOND_LABEL"
tool --keypairgen --key-type rsa:2048 --id "$ORPHAN_ID" --label "$ORPHAN_LABEL"
tool --delete-object --type pubkey --label "$ORPHAN_LABEL"
tool --keypairgen --key-type rsa:2048 --id "$REMOVABLE_ID" --label "$REMOVABLE_LABEL"
tool --keypairgen --key-type EC:prime256v1 --id "$BULK_REMOVABLE_FIRST_ID" --label "$BULK_REMOVABLE_FIRST_LABEL"
tool --keypairgen --key-type EC:prime256v1 --id "$BULK_REMOVABLE_SECOND_ID" --label "$BULK_REMOVABLE_SECOND_LABEL"
tool --keypairgen --key-type EC:prime256v1 --id "$COMPROMISED_ID" --label "$COMPROMISED_LABEL"
tool --keypairgen --key-type EC:prime256v1 --id "$CERTIFIED_ID" --label "$CERTIFIED_LABEL"

work=$(mktemp -d)
chmod 777 "$work"
tool --read-object --type pubkey --label "$CERTIFIED_LABEL" --output-file "$work/certified.der"
openssl pkey -pubin -inform DER -in "$work/certified.der" -out "$work/certified.pem"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=${CERTIFIED_LABEL} issuer" -days 1 \
  -keyout "$work/issuer.key" -out "$work/issuer.pem"
openssl x509 -new -subj "/CN=${CERTIFIED_LABEL}" -force_pubkey "$work/certified.pem" -CA "$work/issuer.pem" \
  -CAkey "$work/issuer.key" -days 30 -outform DER -out "$work/certificate.der"
base64 -w0 "$work/certificate.der"
echo
rm -rf "$work"
