# Tiny ILM API client for the spike: admin client certificate in the ssl-client-cert header, through Kong.
import json, os, sys, urllib.parse, urllib.request
W = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("ILM", "http://localhost:18000/api")
CERT = urllib.parse.quote(open(os.path.join(W, "admin.crt")).read())
def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
        headers={"ssl-client-cert": CERT, "content-type": "application/json", "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            t = r.read().decode(); return r.status, (json.loads(t) if t.strip() else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, json.loads(t)
        except Exception: return e.code, t
if __name__ == "__main__":
    m, p = sys.argv[1], sys.argv[2]
    b = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
    s, r = call(m, p, b); print(s); print(json.dumps(r, indent=1)[:4000])
