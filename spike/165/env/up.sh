#!/usr/bin/env bash
# up.sh — ATF#165 spike: one throw-away ILM on kind, as the operator's e2e-managed `full` block does it, with the
# develop-latest images, the connectors the timestamping block needs and an own EJBCA. Prints timings and memory.
#   OUT=<dir> CLUSTER=<name> OPERATOR_REF=<commit> ./up.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="${OUT:?OUT dir}"; CLUSTER="${CLUSTER:-atf165}"
OPERATOR_REF="${OPERATOR_REF:-12b28cb271b51a981d6eecf9a4c573186bf129e2}"
mkdir -p "$OUT"; export KUBECONFIG="$OUT/kubeconfig"
T0=$(date +%s); mark() { echo "$(( $(date +%s) - T0 ))s $1" | tee -a "$OUT/times.log"; }

kind create cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG" --config "$HERE/kind-config.yaml" --wait 3m; mark kind
curl -fsSL "https://raw.githubusercontent.com/OmniTrustILM/operator/${OPERATOR_REF}/hack/install-upstream-operators.sh" | bash >/dev/null
mark upstream-operators
helm install ilm-operator oci://hub.omnitrustregistry.com/ilm-helm/ilm-operator --version 0.0.0 -n ilm-system --create-namespace \
  --set image.tag=develop-latest --wait --timeout 5m >/dev/null; mark ilm-operator

kubectl apply -f "$HERE/ejbca.yaml" >/dev/null   # EJBCA starts while ILM comes up
python3 -I "$HERE/resolve-digests.py" "$HERE/k/image-refs.yaml"
kubectl create ns ilm >/dev/null
# Edge first: its CA issues the edge certificate and the admin certificate, and is what the edge and Core trust.
kubectl apply -f "$HERE/edge/edge-tls.yaml" >/dev/null
kubectl -n ilm wait certificate/edge-ca certificate/ilm-edge-tls --for=condition=Ready --timeout=3m >/dev/null
kubectl -n ilm get secret edge-ca -o jsonpath='{.data.ca\.crt}' | base64 -d > "$OUT/edge-ca.pem"
kubectl -n ilm create secret generic ilm-trusted-ca --from-file=ca.crt="$OUT/edge-ca.pem" >/dev/null
helm install traefik traefik --repo https://traefik.github.io/charts --version 42.4.3 -n kube-system \
  -f "$HERE/edge/traefik-values.yaml" --wait --timeout 5m >/dev/null
kubectl apply -f "$HERE/edge/edge-route.yaml" >/dev/null; mark edge
( umask 077; openssl rand -base64 18 | tr -d '/+=' > "$OUT/admin-password" )
kubectl -n ilm create secret generic ilm-admin-password --from-file=password="$OUT/admin-password" >/dev/null
for c in common-credential-provider software-cryptography-provider; do
  kubectl -n ilm create secret generic "$c-encryption" --from-literal=key="$(openssl rand -hex 16)" >/dev/null; done
bash "$HERE/ejbca-setup.sh" "$OUT"; mark ejbca
kubectl -n ilm create configmap ejbca-management-ca --from-file=ca.pem="$OUT/ManagementCA.pem" >/dev/null
kubectl apply --server-side -k "$HERE/k" >/dev/null
kubectl -n ilm wait platform/ilm --for=condition=Available --timeout=20m; mark platform-available
for c in common-credential-provider ejbca-ng-connector software-cryptography-provider; do
  kubectl -n ilm rollout status "deploy/$c" --timeout=10m >/dev/null; done; mark connectors-ready

( umask 077
  kubectl -n ilm get secret admin-certificate-secret -o jsonpath='{.data.tls\.crt}' | base64 -d > "$OUT/admin.crt"
  kubectl -n ilm get secret admin-certificate-secret -o jsonpath='{.data.tls\.key}' | base64 -d > "$OUT/admin.key" )
OUT="$OUT" python3 -I "$HERE/bootstrap.py"; mark bootstrap

docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' "$CLUSTER-control-plane" | tee -a "$OUT/times.log"
