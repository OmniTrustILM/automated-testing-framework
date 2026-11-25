#!/usr/bin/env bash
# edge-check.sh <OUT dir> — what the edge does with client certificates, from the host (published port) and from a
# container on the kind docker network (the way estclient will reach it).
set -uo pipefail
D="$1"; U=https://ilm.kind.local:30443
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$D/stranger.key" -out "$D/stranger.crt" \
  -subj "/CN=stranger" -days 1 2>/dev/null
c() { curl -s --resolve ilm.kind.local:30443:127.0.0.1 --cacert "$D/edge-ca.pem" "$@"; }
FAKE=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(open(sys.argv[1]).read()))' "$D/admin.crt")
echo "1 /api/v1/info, no certificate:              $(c -o /dev/null -w '%{http_code}' $U/api/v1/info)"
echo "2 /api/v1/auth/profile, admin certificate:   $(c -w ' -> %{http_code}' --cert "$D/admin.crt" --key "$D/admin.key" $U/api/v1/auth/profile | cut -c1-60) ..."
echo "3 profile, no certificate:                   $(c -o /dev/null -w '%{http_code}' $U/api/v1/auth/profile)"
echo "4 profile, no certificate, forged headers:   $(c -o /dev/null -w '%{http_code}' -H "X-Forwarded-Tls-Client-Cert: $FAKE" -H "ssl-client-cert: $FAKE" $U/api/v1/auth/profile)"
echo "5 /api/v1/info, certificate of unknown CA:   $(c -o /dev/null -w '%{http_code}' --cert "$D/stranger.crt" --key "$D/stranger.key" $U/api/v1/info; echo " (curl exit $?)")"
echo "6 /.well-known/est/cacerts:                  $(c -o "$D/est.out" -w '%{http_code}' $U/.well-known/est/cacerts) $(head -c 80 "$D/est.out")"
NODE=$(docker inspect "${CLUSTER:-atf165}-control-plane" --format '{{(index .NetworkSettings.Networks "kind").IPAddress}}')
echo "7 from the kind network, admin certificate:  $(docker run --rm --network kind -v "$D:/d:ro" curlimages/curl:8.11.1 -s \
  --resolve ilm.kind.local:30443:$NODE --cacert /d/edge-ca.pem --cert /d/admin.crt --key /d/admin.key \
  -o /dev/null -w '%{http_code}' $U/api/v1/auth/profile)"
