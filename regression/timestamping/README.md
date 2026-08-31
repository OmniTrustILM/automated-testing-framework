# Timestamping regression suite

Exercises RFC 3161 timestamping end to end against a locally built Core, so that work in
progress elsewhere in the platform — content signing in particular, which shares the signing
engine, the formatting routing and the signing-record subsystem — cannot break timestamping
unnoticed.

One invocation checks out the dependent repositories — `development-environment` among them —
clean-rebuilds Core and the connector images, recreates the dependency containers, starts Core
on the host, provisions the timestamping objects and runs the API suite against them.

```bash
cp config.env.example config.env    # once: local certificate, EJBCA bundle, ports
./run.sh --clone                    # the full cycle, cloning whatever is missing
./run.sh                            # subsequent runs
```

## The workspace

The suite lives in `automated-testing-framework`, but everything it drives lives in the
sibling checkouts around it. `WORKSPACE_DIR` is that directory — by default the parent of the
automated-testing-framework checkout:

```
<workspace>/
├── automated-testing-framework/    ← this repository, the suite in regression/timestamping/
├── development-environment/        ← Compose files, scripts/timestamping-setup.sh, .env
├── core/  interfaces/
└── timestamp-formatting-connector/  time-quality-monitor/  common-credential-provider/
    ejbca-ng-connector/  software-cryptography-provider/
```

A checkout is found by its repository name, by a `<repo>-<suffix>` name whose `origin` points
at the repository, or through `REPO_DIR_<repo>` in `config.env`. The layout where
automated-testing-framework is cloned *inside* a development-environment working tree is
recognised too — the workspace is then that working tree.

Missing repositories are an error naming the exact `git clone` command; `--clone` fetches
them instead, from `GIT_REMOTE_BASE` (SSH by default).

Compose builds the connector images from `${ILM_SOURCES_BASE_DIR}/<repo>`, so that variable
in `development-environment/.env` must resolve to the workspace. The suite checks this before
anything is built, rather than letting Compose quietly keep a stale image. A
development-environment clone with no `.env` yet gets one generated from `.env.example` with
the variable already set.

## What runs where

| Component | How it runs | Why |
|---|---|---|
| Core | on the host, `java -jar` | the published image trails the schema a locally built Core leaves behind, and Flyway then refuses to start |
| PostgreSQL, RabbitMQ, OPA, auth, scheduler | Docker Compose | unchanged infrastructure |
| credential provider, EJBCA-NG, cryptography provider, timestamp-formatting connector, time-quality monitor | Docker Compose, images rebuilt every run | the connectors under test |

The runner stops only the Core process whose PID and unique JVM token match its state file. If
another process owns `CORE_PORT`, the run fails and identifies it instead of terminating an
unmanaged process.

The database lives in the `data/postgres/pgsqldata` bind mount and survives a run, so
provisioning is reused and no new TSA certificate is issued from the demo EJBCA. `--clean`
wipes it and forces a full re-provisioning.

## Options

`./run.sh --help` is the full list. Worth knowing before the first run: `--clone` (fetch the
repositories that are missing), `--clean` (wipe the database and re-provision), `--tests-only`
(run against an environment that is already up) and `--skip-slow` (drop the `@slow`
time-quality scenarios).

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
| `the policy allow-list is enforced exactly as the profile declares it` | With an empty `allowedPolicyIds`, Core accepts any policy OID and copies it into the token, so the TSA asserts a policy it never defined. RFC 3161 section 2.4.2 calls for `unacceptedPolicy` | [core#2141](https://github.com/OmniTrustILM/core/issues/2141) |

The two allow-list tests read the profile's own `allowedPolicyIds` / `allowedDigestAlgorithms`
and assert against what it declares: enforcement when a list is populated, the documented
accept-anything behaviour when it is empty. They are therefore correct both before and after
[development-environment#40](https://github.com/OmniTrustILM/development-environment/issues/40)
populates those lists — and either way they fail if the validator stops honouring the profile.

Playwright's `test.fail()` was deliberately not used for any of this: it marks the whole test
as expected-to-fail, so an unrelated breakage on the same request — a 401, a malformed
response — would also count as the expected failure and hide a real regression.

## Artifacts

Each run writes `runs/<timestamp>/`:

- `manifest.json` — repository refs and commits, image IDs, the Core jar, the result
- `core.log`, `build-*.log`, `compose-up.log`, `provisioning.log`
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
