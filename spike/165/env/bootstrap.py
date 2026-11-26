# bootstrap.py — the ILM objects the test blocks expect to find and never create themselves (timestamping preflight,
# utils/timestamping/provision/preflight.ts): connectors approved and registered as v1 too, a SoftKeyStore credential
# with the EJBCA RA certificate, the EJBCA authority, a vault instance on the credential provider's `secret` interface,
# and the EJBCA roots in the inventory, trusted. Every object is found by name and reused, so a second run changes
# nothing. At the end it checks, with the preflight's own calls, the parents the preflight reads after the
# timestamp-formatting connector (which needs a private image), and prints the TSA_* values for the test run.
# Needs OUT (up.sh's output dir: admin.crt/key, edge-ca.pem, ilm-ra.p12, ra-p12-password, <CA>.pem).
import base64, hashlib, http.client, json, os, socket, ssl, subprocess, sys, time, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ilm import call, ctx, ADDR, HOST, PORT  # noqa: E402

OUT = os.environ["OUT"]
AUTHORITY, VAULT, CREDENTIAL = "ejbca.kind", "vault", "ejbca-ra"
EJBCA_WS = "https://ejbca.ejbca.svc.cluster.local:8443/ejbca/ejbcaws/ejbcaws?wsdl"
EE, CP, CPQ = "DemoTSAEndEntityProfile", "DemoTSAEECertificateProfile", "DemoTSAQCEECertificateProfile"
CAS = ["DemoRootCA_2307RSA", "MLDSA"]
V1 = {"common-credential-provider-v1": "http://common-credential-provider.ilm.svc.cluster.local:8080",
      "ejbca-ng-connector": "http://ejbca-ng-connector.ilm.svc.cluster.local:8080"}
problems = []


def ok(s, r, what):
    if s >= 300:
        sys.exit(f"{what}: {s} {str(r)[:500]}")
    return r


def v2():
    return call("POST", "/v2/connectors/list", {"itemsPerPage": 100, "pageNumber": 1, "filters": []})[1]["items"]


def v1():
    return call("GET", "/v1/connectors")[1]


def named(items, name):
    return next((i for i in items if i.get("name") == name), None)


def uuid_of(defs, name):
    return next(d["uuid"] for d in defs if d["name"] == name)


# 1. connectors: the operator registers v2 and leaves it waiting for approval; the blocks also need v1 registrations
for _ in range(60):
    if len(v2()) >= 3:  # credential provider, software cryptography, timestamp formatting
        break
    time.sleep(5)
for name, url in V1.items():
    if not named(v1(), name):
        ok(*call("POST", "/v2/connectors", {"name": name, "url": url, "authType": "none", "customAttributes": [], "version": "v1"}), f"register {name}")
for c in v2():
    if c["status"] == "waitingForApproval":
        ok(*call("PATCH", f"/v2/connectors/{c['uuid']}/approve"), f"approve {c['name']}")
time.sleep(3)
cred_conn = named(v1(), "common-credential-provider-v1")["uuid"]
ejbca_conn = named(v1(), "ejbca-ng-connector")["uuid"]
vault_conn = next(c for c in v2() if any(i["code"] == "secret" for i in c.get("interfaces", [])))

# 2. credential with the RA certificate the EJBCA connector authenticates with
cred = named(call("GET", "/v1/credentials")[1], CREDENTIAL)
if not cred:
    defs = call("GET", f"/v1/connectors/{cred_conn}/attributes/credentialProvider/SoftKeyStore")[1]
    p12 = base64.b64encode(open(os.path.join(OUT, "ilm-ra.p12"), "rb").read()).decode()
    pw = open(os.path.join(OUT, "ra-p12-password")).read().strip()
    cred = ok(*call("POST", "/v1/credentials", {"name": CREDENTIAL, "connectorUuid": cred_conn, "kind": "SoftKeyStore", "customAttributes": [], "attributes": [
        {"name": "keyStoreType", "content": [{"data": "PKCS12", "reference": "PKCS12"}], "contentType": "string", "uuid": uuid_of(defs, "keyStoreType"), "version": "v2"},
        {"name": "keyStorePassword", "content": [{"data": {"secret": pw}}], "contentType": "secret", "uuid": uuid_of(defs, "keyStorePassword"), "version": "v2"},
        {"name": "keyStore", "content": [{"data": {"content": p12, "fileName": "ilm-ra.p12", "mimeType": "application/x-pkcs12"}}], "contentType": "file", "uuid": uuid_of(defs, "keyStore"), "version": "v2"}]}), "credential")

# 3. the EJBCA authority, by the name TSA_AUTHORITY_NAME will give
auth = named(call("GET", "/v1/authorities")[1], AUTHORITY)
if not auth:
    defs = call("GET", f"/v1/connectors/{ejbca_conn}/attributes/authorityProvider/EJBCA")[1]
    auth = ok(*call("POST", "/v1/authorities", {"name": AUTHORITY, "connectorUuid": ejbca_conn, "kind": "EJBCA", "customAttributes": [], "attributes": [
        {"name": "url", "content": [{"data": EJBCA_WS}], "contentType": "string", "uuid": uuid_of(defs, "url"), "version": "v2"},
        {"name": "credential", "content": [{"data": {"uuid": cred["uuid"], "name": CREDENTIAL}, "reference": CREDENTIAL}], "contentType": "credential", "uuid": uuid_of(defs, "credential"), "version": "v2"}]}), "authority")

# 4. the vault instance, on the credential provider's v2 `secret` interface (no separate Vault server)
vaults = call("POST", "/v1/vaults/list", {"itemsPerPage": 100, "pageNumber": 1, "filters": []})[1]
vaults = vaults.get("items", vaults) if isinstance(vaults, dict) else vaults
vault = named(vaults or [], VAULT)
if not vault:
    iface = next(i["uuid"] for i in vault_conn["interfaces"] if i["code"] == "secret")
    vault = ok(*call("POST", "/v1/vaults", {"connectorUuid": vault_conn["uuid"], "interfaceUuid": iface, "name": VAULT,
                                           "attributes": [], "customAttributes": []}), "vault instance")

# 5. the EJBCA roots in the inventory, trusted (on a shared tier the setup must find them trusted already)
def der_of(pem_file):  # EJBCA's getcacert writes Subject/Issuer lines before the PEM block
    text = open(pem_file).read()
    return ssl.PEM_cert_to_DER_cert(text[text.index("-----BEGIN CERTIFICATE-----"):])


for ca in CAS:
    der = der_of(os.path.join(OUT, f"{ca}.pem"))
    fp = hashlib.sha256(der).hexdigest()
    found = call("POST", "/v1/certificates", {"itemsPerPage": 1, "pageNumber": 1, "includeArchived": True, "filters": [
        {"fieldSource": "property", "fieldIdentifier": "FINGERPRINT", "condition": "EQUALS", "value": fp}]})[1].get("certificates") or []
    cert = found[0] if found else ok(*call("POST", "/v1/certificates/upload", {"certificate": base64.b64encode(der).decode(), "customAttributes": []}), f"upload {ca}")
    ok(*call("PATCH", f"/v1/certificates/{cert['uuid']}", {"trustedCa": True}), f"trust {ca}")

# 6. Keycloak: ATF logs in by the password grant of client `ilm`. The operator's realm gives that client no `basic`
#    scope, so the token has no `sub` and Core answers 401 to every Bearer call (operator#74, open). Workaround, as on
#    the shared environment: add `basic` as a default scope of `ilm`. Remove when operator#74 is fixed.
def kubectl_secret(name, key):
    return base64.b64decode(subprocess.check_output(["kubectl", "-n", "ilm", "get", "secret", name, "-o", f"jsonpath={{.data.{key}}}"])).decode()


def kc(method, path, body=None, token=None, form=None):
    c = http.client.HTTPSConnection(HOST, PORT, context=ctx)
    c.sock = ctx.wrap_socket(socket.create_connection((ADDR, PORT), timeout=60), server_hostname=HOST)
    headers = {"host": HOST, **({"authorization": "Bearer " + token} if token else {})}
    if form is not None:
        data, headers["content-type"] = urllib.parse.urlencode(form), "application/x-www-form-urlencoded"
    else:
        data, headers["content-type"] = (None if body is None else json.dumps(body)), "application/json"
    c.request(method, path, data, headers)
    r = c.getresponse(); t = r.read()
    return r.status, (json.loads(t) if t.strip() else None)


s_, t = kc("POST", "/kc/realms/master/protocol/openid-connect/token", form={"grant_type": "password", "client_id": "admin-cli",
            "username": kubectl_secret("ilm-keycloak-initial-admin", "username"), "password": kubectl_secret("ilm-keycloak-initial-admin", "password")})
admin_token = ok(s_, t, "Keycloak master admin login")["access_token"]
client = kc("GET", "/kc/admin/realms/ilm/clients?clientId=ilm", token=admin_token)[1][0]
basic = next(sc for sc in kc("GET", "/kc/admin/realms/ilm/client-scopes", token=admin_token)[1] if sc["name"] == "basic")
if not any(sc["name"] == "basic" for sc in kc("GET", f"/kc/admin/realms/ilm/clients/{client['id']}/default-client-scopes", token=admin_token)[1]):
    ok(*kc("PUT", f"/kc/admin/realms/ilm/clients/{client['id']}/default-client-scopes/{basic['id']}", token=admin_token), "add basic scope")
s_, t = kc("POST", "/kc/realms/ilm/protocol/openid-connect/token", form={"grant_type": "password", "client_id": "ilm",
            "client_secret": kubectl_secret("ilm-oidc-client", "clientSecret"), "username": "admin", "password": kubectl_secret("ilm-admin-password", "password")})
bearer = ok(s_, t, "password grant of admin")["access_token"]
s_, _ = kc("GET", "/api/v1/auth/profile", token=bearer)
if s_ != 200:
    problems.append(f"a password-grant token gets {s_} from Core")

# 7. what the preflight reads after the formatting connector: authority options through its own callbacks
ra = call("GET", f"/v1/authorities/{auth['uuid']}/attributes/raProfile")[1]
attr = {d["name"]: d for d in ra}
auth_id = next(m["value"] for m in attr["certificationAuthority"]["attributeCallback"]["mappings"] if m["to"] == "authorityId" and "value" in m)
ee = next((c["data"] for c in attr["endEntityProfile"]["content"] if c["data"]["name"] == EE), None)
if not ee:
    problems.append(f"end-entity profile {EE} not offered")
else:
    def options(name):
        return [c["data"]["name"] for c in call("POST", f"/v1/raProfiles/{auth['uuid']}/callback", {"uuid": attr[name]["uuid"], "name": name,
                "pathVariable": {"endEntityProfileId": ee["id"], "authorityId": auth_id}, "requestParameter": {}, "body": {}, "filter": {}})[1]]
    cps, cas = options("certificateProfile"), options("certificationAuthority")
    problems += [f"certificate profile {p} not offered" for p in (CP, CPQ) if p not in cps]
    problems += [f"CA {c} not offered" for c in CAS if c not in cas]
connected = {c["name"]: c["status"] for c in v1()} | {c["name"]: c["status"] for c in v2()}
problems += [f"connector {n} is {s}" for n, s in connected.items() if s != "connected"]

print("connectors:", ", ".join(f"{n} {s}" for n, s in sorted(connected.items())))
print(f"credential {CREDENTIAL}, authority {AUTHORITY}, vault instance {VAULT} (on {vault_conn['name']}), roots trusted: {', '.join(CAS)}")
print("ATF login (password grant of client ilm, Bearer call to Core):", "works" if s_ == 200 else f"fails ({s_})")
print("preflight parents after the formatting connector:", "all found" if not problems else "; ".join(problems))
print(f"TSA_AUTHORITY_NAME={AUTHORITY} TSA_VAULT_INSTANCE_NAME={VAULT} TSA_EJBCA_CA={CAS[0]} TSA_MLDSA_EJBCA_CA={CAS[1]}")
sys.exit(1 if problems else 0)
