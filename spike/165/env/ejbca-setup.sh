#!/usr/bin/env bash
# ejbca-setup.sh — sets up the throw-away EJBCA CE of ATF#165 in a kind cluster:
#   the TSA CAs (RSA, ML-DSA-65), the DemoTSA certificate / end-entity profiles the timestamping block expects,
#   and the RA client PKCS12 the ejbca-ng-connector authenticates with.
# Usage: ejbca-setup.sh <out-dir>   (writes ilm-ra.p12, ra-p12-password, ManagementCA.pem, <CA>.pem)
# Needs KUBECONFIG pointing at the kind cluster; EJBCA runs as deploy/ejbca in namespace ejbca.
set -euo pipefail
OUT="${1:?out dir}"; HERE="$(cd "$(dirname "$0")" && pwd)"
NS=ejbca
# The live pod only: a pod still terminating after a rollout would take the whole set-up with it.
live_pod() { kubectl -n "$NS" get pod -l app=ejbca -o go-template='{{range .items}}{{if not .metadata.deletionTimestamp}}{{.metadata.name}}{{"\n"}}{{end}}{{end}}' | head -1; }
for _ in $(seq 1 60); do POD=$(live_pod); [[ -n "$POD" ]] && break; sleep 5; done
[[ -n "${POD:-}" ]] || { echo "no EJBCA pod" >&2; exit 1; }
cli() { { kubectl -n "$NS" exec "$POD" -- /opt/keyfactor/bin/ejbca.sh "$@" 2>&1 || true; } | sed -E 's/^.*\(main\) //'; }
has_ca() { cli ca listcas | grep -q "CA Name: $1\$"; }

kubectl -n "$NS" wait --for=condition=Ready pod/"$POD" --timeout=10m >/dev/null

for spec in "DemoRootCA_2307RSA RSA 3072 SHA384WithRSA" "MLDSA ML-DSA-65 ML-DSA-65 ML-DSA-65"; do
  read -r name type keyspec sigalg <<<"$spec"
  has_ca "$name" || cli ca init --caname "$name" --dn "CN=$name,O=ILM QA kind" --tokenType soft --tokenPass null \
    --keyspec "$keyspec" --keytype "$type" -v 3650 --policy null -s "$sigalg" | tail -1
  cli ca getcacert --caname "$name" -f "/tmp/$name.pem" >/dev/null
  kubectl -n "$NS" exec "$POD" -- cat "/tmp/$name.pem" > "$OUT/$name.pem"
done
cli ca getcacert --caname ManagementCA -f /tmp/ManagementCA.pem >/dev/null
kubectl -n "$NS" exec "$POD" -- cat /tmp/ManagementCA.pem > "$OUT/ManagementCA.pem"

# TLS_SETUP_ENABLED=simple leaves the https trust store empty, so every client certificate is refused at the handshake
# (curl: TLS 1.2 exit 35, TLS 1.3 exit 56). The connector always presents one: trust ManagementCA, then re-init the trust manager.
kubectl -n "$NS" exec "$POD" -- sh -c 'J=$(ls -d /opt/keyfactor/wildfly-*)/bin/jboss-cli.sh
  /opt/keyfactor/bin/ejbca.sh ca getcacert --caname ManagementCA -f /tmp/mgmt.pem >/dev/null 2>&1
  $J --connect --commands="/subsystem=elytron/key-store=httpsTS:read-aliases" | grep -q managementca ||
  $J --connect --commands="/subsystem=elytron/key-store=httpsTS:import-certificate(alias=managementca,path=/tmp/mgmt.pem,trust-cacerts=true,validate=false),/subsystem=elytron/key-store=httpsTS:store(),/subsystem=elytron/trust-manager=httpsTM:init()" >/dev/null'

# Profiles: serialized by EJBCA's own classes (MkProf.java), then imported; an existing profile is kept.
kubectl cp "$HERE/MkProf.java" "$NS/$POD:/tmp/MkProf.java"
kubectl -n "$NS" exec "$POD" -- sh -c 'rm -rf /tmp/imp && mkdir -p /tmp/imp && D=/opt/keyfactor/wildfly-*/standalone/deployments/ejbca.ear && java -cp "$(echo $D)/lib/*:$(echo $D)/*" /tmp/MkProf.java /tmp/imp 2>&1 | grep -v "^WARNING" || true'
cli ca importprofiles -d /tmp/imp | { grep -E "Added|ERROR|exist" || true; }

# RA client. The initial TRANSPORT_CONFIDENTIAL member of TLS_SETUP_ENABLED=simple does not cover web-service calls made with a
# client certificate ("Authorization denied on EJBCA"), so ilm-ra joins the Super Administrator Role by its CN under ManagementCA.
# A fresh PKCS12 every run: the user is (re)set to NEW with a new password and the batch re-issues it.
( umask 077; openssl rand -hex 12 > "$OUT/ra-p12-password" )
P=$(cat "$OUT/ra-p12-password")
cli ra addendentity --username ilm-ra --dn "CN=ilm-ra,O=ILM QA kind" --caname ManagementCA --type 1 --token P12 \
  --password "$P" --certprofile ENDUSER --eeprofile EMPTY >/dev/null || true
cli ra setendentitystatus --username ilm-ra -S 10 >/dev/null
cli ra setclearpwd ilm-ra "$P" >/dev/null
kubectl -n "$NS" exec "$POD" -- rm -rf /tmp/p12
cli batch ilm-ra -dir /tmp/p12 | tail -1
kubectl -n "$NS" exec "$POD" -- cat /tmp/p12/ilm-ra.p12 > "$OUT/ilm-ra.p12"
cli roles listadmins --role "Super Administrator Role" | grep -q '"ilm-ra"' ||
  cli roles addrolemember --role "Super Administrator Role" --caname ManagementCA \
    --with CertificateAuthenticationToken:WITH_COMMONNAME --value ilm-ra | tail -1
echo "EJBCA ready: CAs $(cli ca listcas | grep -c 'CA Name'), RA bundle $OUT/ilm-ra.p12"
