# Tiny ILM API client for the spike: the admin client certificate over mTLS through the edge (Traefik), with the
# edge's host name as SNI, so the edge asks for the certificate exactly as it does for any client.
import http.client, json, os, socket, ssl, sys
W = os.environ.get("OUT") or os.path.dirname(os.path.abspath(__file__))
HOST, PORT = os.environ.get("ILM_HOST", "ilm.kind.local"), int(os.environ.get("ILM_PORT", "30443"))
ADDR = os.environ.get("ILM_ADDR", "127.0.0.1")
ctx = ssl.create_default_context(cafile=os.path.join(W, "edge-ca.pem"))
ctx.load_cert_chain(os.path.join(W, "admin.crt"), os.path.join(W, "admin.key"))
class Edge(http.client.HTTPSConnection):
    def connect(self):
        self.sock = ctx.wrap_socket(socket.create_connection((ADDR, PORT), timeout=120), server_hostname=HOST)
def call(method, path, body=None):
    c = Edge(HOST, PORT, context=ctx)
    c.request(method, "/api" + path, body=None if body is None else json.dumps(body),
              headers={"content-type": "application/json", "accept": "application/json", "host": HOST})
    r = c.getresponse(); t = r.read().decode()
    try: return r.status, (json.loads(t) if t.strip() else None)
    except ValueError: return r.status, t
if __name__ == "__main__":
    s, r = call(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]) if len(sys.argv) > 3 else None)
    print(s); print(json.dumps(r, indent=1)[:4000])
