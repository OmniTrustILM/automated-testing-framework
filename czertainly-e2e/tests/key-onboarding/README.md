# Key onboarding block (`@dev-tests`)

The developers' suite for ilm#409 (list the key pairs on a PKCS#11 token, onboard them, sign with them, remove them from the
inventory), ported from `feat/409-list-and-adopt-keys` at fec5cbe. Four specs: `10-listing`, `20-onboarding`, `25-merge`
(local stack only), `30-removal`. The setup plants 11 key pairs on the SoftHSM token and creates the token, profile and PIN
secret; the teardown deletes them and then removes the run's pairs from the token. If it cannot prove the pairs are gone it
fails and writes the manual removal command to `<REG_STATE_DIR>/<run id>.key-onboarding.removal.sh`.

## Run

Local stack (docker plants into the sidecar container):

```
REG_ENV_FILE=<local-stack env file> TIER_KIND=local DEV_BLOCK=key-onboarding \
  npx playwright test -c playwright.devblock.config.ts
```

Shared tier (kubectl exec plants into the sidecar):

```
REG_ENV_FILE=<tier env file> DEV_BLOCK=key-onboarding KO_TOKEN_PIN=<SoftHSM user PIN> \
  KO_PKCS11_CONNECTOR_URL=<connector URL as core has it> KO_VAULT_CONNECTOR_URL=<vault connector URL> \
  npx playwright test -c playwright.devblock.config.ts --pass-with-no-tests
```

A shared tier needs kubectl, `get`/`list` on pods and `create`/`get` on `pods/exec` in KO_KUBE_NAMESPACE,
exactly one running connector pod, and KO_PKCS11_CONNECTOR_URL naming that Deployment's Service
(`<deployment>.<namespace>.svc…`). Without any of it the rows skip with the reason. A teardown run by hand needs the
planting run's REG_RUN_ID and REG_STATE_DIR.

The onboard request names a pair by its listed `keyPairMeta`; the guard waives only `keys[].keyPairMeta[].uuid` on that route
(the connector's metadata definition, not an object).

## Environment

| Variable | Default |
|---|---|
| KO_TOKEN_PIN | none: the block is unavailable without it |
| KO_PKCS11_CONNECTOR_URL | http://localhost:8290 |
| KO_VAULT_CONNECTOR_URL | http://localhost:8200 |
| KO_PKCS11_PROFILE / KO_PKCS11_TOKEN | softhsm / softhsm |
| KO_SIDECAR_CONTAINER (local) | pkcs11-sidecar-softhsm |
| KO_KUBE_NAMESPACE | ilm |
| KO_KUBE_DEPLOYMENT | pkcs11-cryptography-provider |
| KO_KUBE_CONTAINER | proxy-softhsm |
| KO_PKCS11_MODULE | /usr/lib/softhsm/libsofthsm2.so |
| KO_KUBE_CONTEXT | none (in a pod: its service account; elsewhere required) |
| KO_KUBE_EXEC_TIMEOUT_MS | 180000 |
| REG_KUBECTL_BIN | kubectl |
