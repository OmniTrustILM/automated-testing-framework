# Timestamping regression suite

Exercises RFC 3161 timestamping end to end, so that work in progress elsewhere in the
platform — content signing in particular, which shares the signing engine, the formatting
routing and the signing-record subsystem — cannot break timestamping unnoticed.

Every component is taken from the registry by default. One invocation pulls the published
images, recreates the dependency containers, provisions the timestamping objects and runs the
API suite against them. Nothing but `development-environment` needs to be checked out, and
nothing is built.

```bash
cp config.env.example config.env    # once: local certificate, EJBCA bundle, ports
./run.sh --clone                    # the full cycle against the latest published builds
./run.sh                            # subsequent runs
```

## Component sources

A component is either `published` — pulled from `hub.omnitrustregistry.com`, the default — or
`local`, built from a checkout in the workspace. `--local` names the exceptions:

```bash
./run.sh                                                 # QA: everything published
./run.sh --local interfaces,core                         # dev: Maven side local
./run.sh --local timestamp-formatting-connector          # dev: one image local
./run.sh --local all                                     # build everything from sources
```

`all` covers `interfaces`, `core` and the five connectors. The platform services — `auth`,
`scheduler`, `opa-bundle-server` — are managed the same way but stay out of `all`; name them
if you really want to build them. Set `LOCAL_COMPONENTS` in `config.env` for a standing
default and use `--published <list>` to relax it for a single run.

Core's pom resolves the `interfaces` SNAPSHOT from Maven Central, so `--local core` on its own
is a valid and much faster way to test a Core change.

`--published-ref` picks which published build to use: `develop` (default, the head of `main`,
tagged `develop-latest`), `release` (the newest tag, `latest`), or a literal tag such as
`develop-<sha>`. `--<component>-tag` pins one component. Because `develop-latest` moves, the
manifest records the resolved digest of every image a run actually used.

`--<repo>-ref` implies `--local <repo>`: asking for a ref is asking for a source build.

### Registry access

Published images come from two registries, and a pull that is denied fails the run naming the
one to authenticate against:

| Images | Registry | Anonymous |
|---|---|---|
| `ilm/core`, `ilm/auth`, `ilm/scheduler`, `ilm/common-credential-provider`, `ilm/ejbca-ng-connector`, `ilm/software-cryptography-provider` | `hub.omnitrustregistry.com` | yes |
| `ilm-private/timestamp-formatting-connector`, `ilm-private/time-quality-monitor` | `hub.omnitrustregistry.com` | no — `docker login hub.omnitrustregistry.com` |
| `czertainly/czertainly-auth-opa-policies` | `harbor.3key.company` | no — `docker login harbor.3key.company` |

`auth-opa-policies` never got an ILM registry publish, so `opa-bundle-server` is the one
component still served by the legacy 3Key Harbor under its pre-rebranding name. Repoint it
with `PUBLISHED_IMAGE_opa_bundle_server` once it is published alongside the rest, or run it
from a checkout with `--local opa-bundle-server`.

## The workspace

The suite lives in `automated-testing-framework`, but the checkouts it builds live in the
sibling directories around it. `WORKSPACE_DIR` is that directory — by default the parent of
the automated-testing-framework checkout:

```
<workspace>/
├── automated-testing-framework/    ← this repository, the suite in regression/timestamping/
├── development-environment/        ← Compose files, scripts/timestamping-setup.sh, .env
├── core/  interfaces/
└── timestamp-formatting-connector/  time-quality-monitor/  common-credential-provider/
    ejbca-ng-connector/  software-cryptography-provider/
```

Only `development-environment` is always required; the rest are needed only for the components
listed as local.

A checkout is found by its repository name, by a `<repo>-<suffix>` name whose `origin` points
at the repository, or through `REPO_DIR_<repo>` in `config.env`. The layout where
automated-testing-framework is cloned *inside* a development-environment working tree is
recognised too — the workspace is then that working tree.

Missing repositories are an error naming the exact `git clone` command; `--clone` fetches
them instead, from `GIT_REMOTE_BASE` (SSH by default).

Compose builds local images from `${ILM_SOURCES_BASE_DIR}/<repo>`, so that variable in
`development-environment/.env` must resolve to the workspace whenever anything is local. The
suite checks this before anything is built, rather than letting Compose quietly keep a stale
image. A development-environment clone with no `.env` yet gets one generated from
`.env.example` with the variable already set.

## What runs where

| Component | How it runs | Why |
|---|---|---|
| Core, published | Docker Compose, on `CORE_CONTAINER_PORT` (8280) | nothing to build, and the image's schema matches its own migrations |
| Core, `--local core` | on the host, `java -jar`, on `CORE_PORT` (8080) | building an image per run is slow, and the host matches the connector defaults |
| PostgreSQL, RabbitMQ, OPA, ntp | Docker Compose | unchanged infrastructure |
| auth, scheduler, opa-bundle-server | Docker Compose, published images | platform services, previously built implicitly from unmanaged checkouts |
| credential provider, EJBCA-NG, cryptography provider, timestamp-formatting connector, time-quality monitor | Docker Compose | the connectors under test |

`ILM_HOST` follows from how Core runs, and so does the connector host handed to provisioning:
a host Core shares the connectors' published ports on `localhost`, a containerised one reaches
the same ports through `host.docker.internal`.

Published images are pinned through `.state/compose-published.yml`, a generated Compose
overlay copied into each run directory. `ilm-compose.yml` is never edited, so
development-environment stays free to evolve. The overlay also supplies the two things Core's
Compose service lacks for a regression run: `MESSAGING_TIME_QUALITY_ENABLED`, without which
every qualified timestamp fails with "time quality is not sufficient", and the host-gateway
route back to the connectors.

When a locally built Core is used, the runner stops only the process whose PID and unique JVM
token match its state file. If another process owns `CORE_PORT`, the run fails and identifies
it instead of terminating an unmanaged process.

The database lives in the `data/postgres/pgsqldata` bind mount and survives a run, so
provisioning is reused and no new TSA certificate is issued from the demo EJBCA. `--clean`
wipes it and forces a full re-provisioning. A published Core and a locally built one leave
different Flyway state behind, so switching between them is refused until the database is
wiped — otherwise the mismatch surfaces much later as "Detected applied migration not resolved
locally".

## Options

`./run.sh --help` is the full list. Worth knowing before the first run: `--local` (build a
component from sources instead of pulling it), `--clone` (fetch the repositories that are
missing), `--clean` (wipe the database and re-provision), `--tests-only` (run against an
environment that is already up) and `--skip-slow` (drop the `@slow` time-quality scenarios).

A dirty checkout is never touched: the run continues against the working tree and says so,
and the run manifest records `dirty: true` next to the commit that was actually built.

## What is asserted

| Spec | Scope |
|---|---|
| `00-environment` | Core health, container health, connector status and health, Core's subscription to the time-quality exchange |
| `10-provisioning` | signing and TSP profiles enabled and mutually linked, certificates validating against a complete trusted chain, time-quality wiring, mapped user, object-scoped `timestamp` grants |
| `20-tsp-happy-path` | both profiles over both routes, SHA-256/384/512, exact nonce echo and certReq variants, signature verification with separated trust anchors and intermediates, signer identity, genTime, concurrent issuance with unique serials |
| `30-token-structure` | qualified vs non-qualified differences — `qcStatements`, accuracy equal to the time-quality configuration, policy OID — including a guard that the two profiles must not produce identical tokens |
| `40-tsp-errors` | authentication failures, unknown and disabled profiles, malformed requests, an unprivileged user, digest and policy handling, and the invariants that errors never become 5xx and never leak internals |
| `50-time-quality` | `@slow`: losing NTP must stop qualified timestamps while plain ones keep working, and both must recover |
| `60-content-signing-canary` | timestamps land in the signing-record subsystem with the token serial number, record policy stays coherent, the timestamping, content-signing and raw-signing workflow types stay published, and the capability gate still refuses a content-signing profile built on the timestamping connector without disturbing timestamping |

## Known deviations

Behaviour that looks wrong but is what the platform does today. Filed upstream; the suite
asserts the current outcome exactly, so a test fails the moment any of it changes.

| Test | Deviation | Issue |
|---|---|---|
| `a JSON content type is currently answered with HTTP 500` | `HttpMediaTypeNotSupportedException` reaches the generic handler in Core's `ExceptionHandlingAdvice` and is rendered as HTTP 500 instead of 415 | [core#2140](https://github.com/OmniTrustILM/core/issues/2140) |

Playwright's `test.fail()` was deliberately not used for any of this: it marks the whole test
as expected-to-fail, so an unrelated breakage on the same request — a 401, a malformed
response — would also count as the expected failure and hide a real regression.

## Allow-list handling

An empty `allowedPolicyIds` or `allowedDigestAlgorithms` means "accept anything" — a
deliberate, documented default, confirmed when
[core#2141](https://github.com/OmniTrustILM/core/issues/2141) was closed as works-as-designed.
It is not a deviation. Two consequences of it are still undocumented and tracked in
[documentation#397](https://github.com/OmniTrustILM/documentation/issues/397): the accepted OID
is copied verbatim into `TSTInfo.policy`, and a non-empty allow-list does not implicitly
contain `defaultPolicyId`.

The two allow-list tests read the profile's own `allowedPolicyIds` / `allowedDigestAlgorithms`
and assert against what it declares: enforcement when a list is populated, accept-anything when
it is empty. Since
[development-environment#40](https://github.com/OmniTrustILM/development-environment/issues/40),
provisioning populates both lists, so runs against this environment exercise the enforcing
branch and an unknown policy OID is rejected with `unacceptedPolicy`. The empty-list branch is
kept for environments provisioned by other means — either way the tests fail if the validator
stops honouring the profile.

## Artifacts

Each run writes `runs/<timestamp>/`:

- `manifest.json` — the resolved source of every component (published tag and digest, or ref,
  commit and dirty flag), the Core jar, the result
- `compose-published.yml` — the image pins this run handed to Compose
- `core.log`, `build-*.log`, `pull-images.log`, `compose-up.log`, `provisioning.log`
- `provisioning.json` — names and UUIDs of everything provisioned (input to the suite)
- `artifacts/<case>/` — the `.tsq` and `.tsr` bytes of every request the suite made
- `junit.xml`, `playwright-report/index.html`

`runs/latest` points at the newest run. A failure is therefore attributable to a specific
commit of a specific repository, with the exact request and response bytes on disk.

## Provisioning

Provisioning is delegated to `scripts/timestamping-setup.sh` in the development-environment
checkout, the maintained source of truth, invoked with `--json-summary` so the suite reads
what exists instead of guessing. Objects the script does not create — the unprivileged user
used by the authorization test — are provisioned by the suite itself.

The certificate DN and key name are pinned in `.state/provisioning.env` while the database
lives: the script reuses named objects but always issues a fresh certificate for a set it has
to create, and EJBCA rejects a second end entity bound to an already-used key.

If provisioning fails because the issuing CA is missing from the platform
(`issuerCertificateUuid is still empty`, later surfacing as `not eligible for signing workflow
type TIMESTAMPING`), the runner fetches the CA from the leaf's AIA extension, uploads it,
marks it trusted, revalidates and retries once with fresh names.
