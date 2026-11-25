# Rewrites every develop-latest digest in image-refs.yaml to the registry's current one (anonymous pull scope;
# a repository that refuses anonymous pulls keeps its digest and is reported).
import json, re, sys, urllib.request
R = "https://hub.omnitrustregistry.com"
ACC = ("application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,"
       "application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json")
path = sys.argv[1]; text = open(path).read()
def current(repo, tag):
    tok = json.load(urllib.request.urlopen(f"{R}/service/token?service=harbor-registry&scope=repository:{repo}:pull")).get("token", "")
    req = urllib.request.Request(f"{R}/v2/{repo}/manifests/{tag}", method="HEAD", headers={"Authorization": "Bearer " + tok, "Accept": ACC})
    try: return urllib.request.urlopen(req).headers["Docker-Content-Digest"]
    except urllib.error.HTTPError as e: return None
def sub(m):
    repo, tag, old = m.group(1), m.group(2), m.group(3)
    new = current(repo, tag)
    print(f"{repo}:{tag} {'unchanged' if new == old else ('NO ACCESS, kept' if new is None else 'updated')}")
    return f"hub.omnitrustregistry.com/{repo}:{tag}@{new or old}"
text = re.sub(r"hub\.omnitrustregistry\.com/([\w./-]+):([\w.-]+)@(sha256:[0-9a-f]{64})", sub, text)
open(path, "w").write(text)
