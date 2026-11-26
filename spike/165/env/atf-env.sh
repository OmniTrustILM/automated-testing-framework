#!/usr/bin/env bash
# atf-env.sh <OUT dir> — writes <OUT>/atf.env, the ATF env file for this environment (REG_ENV_FILE), from the cluster's
# own secrets. Mode 600, never printed. The tests reach the edge at https://ilm.kind.local:30443: map the name to
# 127.0.0.1 (/etc/hosts on a runner; a Node preload on a laptop).
set -euo pipefail
OUT="$1"; export KUBECONFIG="${KUBECONFIG:-$OUT/kubeconfig}"
s() { kubectl -n ilm get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }
umask 077
{
  echo "BASE_URL=https://ilm.kind.local:30443"
  echo "AUTH_MODE=local"; echo "AUTH_CLIENT_ID=ilm"; echo "AUTH_REALM=ilm"; echo "LOCAL_AUTH_PROVIDER_NAME=Internal"
  echo "SMOKE_CLIENT_SECRET=$(s ilm-oidc-client clientSecret)"
  echo "SMOKE_USERNAME=admin"; echo "SMOKE_PASSWORD=$(s ilm-admin-password password)"
  echo "REG_STATE_DIR=$OUT/state"
  echo "KUBECONFIG_PATH=$KUBECONFIG" # tests/ephemeral reach the cluster through it
  echo "TSA_AUTHORITY_NAME=ejbca.kind"; echo "TSA_VAULT_INSTANCE_NAME=vault"; echo "TSA_FAMILIES=rsa"
  echo "# the smoke variables the config validates for every block; discovery is not deployed here (placeholders)"
  echo "DISCOVERY_PROVIDER_NAME=not-deployed"; echo "DISCOVERY_PROVIDER_URL=http://not-deployed.invalid:8080"; echo "DISCOVERY_TARGET=192.0.2.1"
  echo "EJBCA_CONNECTOR_NAME=ejbca-ng-connector"; echo "EJBCA_CONNECTOR_URL=http://ejbca-ng-connector.ilm.svc.cluster.local:8080"
  echo "CREDENTIAL_CONNECTOR_NAME=common-credential-provider-v1"; echo "CREDENTIAL_CONNECTOR_URL=http://common-credential-provider.ilm.svc.cluster.local:8080"
  echo "EJBCA_WS_URL=https://ejbca.ejbca.svc.cluster.local:8443/ejbca/ejbcaws/ejbcaws?wsdl"
  echo "EJBCA_P12_BASE64=$(base64 < "$OUT/ilm-ra.p12" | tr -d '\n')"; echo "EJBCA_P12_PASSWORD=$(cat "$OUT/ra-p12-password")"
  echo "EJBCA_CA_NAME=DemoRootCA_2307RSA"; echo "EJBCA_END_ENTITY_PROFILE=DemoTSAEndEntityProfile"; echo "EJBCA_CERTIFICATE_PROFILE=DemoTSAEECertificateProfile"
  echo "SMOKE_TESTS_NAMESPACE=atf-smoke"
} > "$OUT/atf.env"
echo "wrote $OUT/atf.env"
