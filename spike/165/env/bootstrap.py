# bootstrap.py — the ILM objects the test blocks expect to find (they never create these parents themselves):
# approves the operator's v2 registrations and adds the v1 registrations of the same connectors.
import sys, time, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from ilm import call
V1 = {"common-credential-provider-v1": "http://common-credential-provider.ilm.svc.cluster.local:8080",
      "ejbca-ng-connector": "http://ejbca-ng-connector.ilm.svc.cluster.local:8080"}
def v2(): return call("POST", "/v2/connectors/list", {"itemsPerPage": 100, "pageNumber": 1, "filters": []})[1]["items"]
for _ in range(60):  # the operator registers after the connector is ready
    if len(v2()) >= 2: break
    time.sleep(5)
have = {c["name"] for c in call("GET", "/v1/connectors")[1]}
for name, url in V1.items():
    if name not in have:
        s, r = call("POST", "/v2/connectors", {"name": name, "url": url, "authType": "none", "customAttributes": [], "version": "v1"})
        print("register v1", name, s)
for c in v2():
    if c["status"] == "waitingForApproval": print("approve", c["name"], call("PATCH", f"/v2/connectors/{c['uuid']}/approve")[0])
time.sleep(3)
for c in v2(): print(" ", c["name"], c["version"], c["status"])
