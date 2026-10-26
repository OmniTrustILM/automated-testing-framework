# Timestamping block (`@dev-tests`)

## WHAT

The developers' RFC 3161 timestamping suite (automated-testing-framework#41, branch `feat/timestamping-regression`),
ported by QA (#113) as its own block, run by its own config (`playwright.devblock.config.ts`, tests/dev-blocks/README.md): ten specs (`00-environment` … `70-signature-options`,
same numbers and titles as the source, file order kept), every test tagged `@dev-tests @timestamping @needs:timestamping` and
`@issue:automated-testing-framework#41`; the rows that read docker or stop a container (two of `00`, all of `50` and `55`) are also
`@local`, and the stop-a-container ones `@slow @disruptive`. Test bodies, assertions and titles are the developers'; only the plumbing,
the plan-driven titles and a few safety fixes changed. The block runs create-only on a shared tier too: SHARED-TIER.md (design, per object).

## WHY

The source suite provisioned with a bash script (fixed names, reuse and modify, state files) and read admin
credentials from the environment. In the regression framework every object is created per run, named
`<run id>-…`, written to the ledger right after its create and deleted by the run-end teardown; admin calls go through
the guard. The guard now has create-only rules for the timestamping objects (time-quality configurations are per object, not platform-wide),
so the block runs on a shared tier that has the components, and on a proven local stack; the docker-bound rows stay local.

## HOW

- Setup (`timestamping.setup.ts`, another project) preflights, provisions the run's objects and writes
  `<REG_STATE_DIR>/<run id>.timestamping.json`. Specs only READ it, lazily inside tests (`utils/timestamping/provisioning.ts`).
  The summary holds ids and names, no secret: the Basic-credential passwords are derived from `TSA_RUN_SECRET`, a value the config generates per run
  in the process environment only (`utils/timestamping/secrets.ts`), so a published state directory leaks none. The setup also stores a count + hash
  baseline of the signing profiles, TSP profiles and time-quality configurations it did not create; the teardown compares it (`utils/timestamping/inventory.ts`,
  skipped with a reason where the tier cannot list them).
- Titles come from the plan (`TSA_FAMILIES`), because Playwright lists tests before the setup runs. The primary RSA
  family is unprefixed (`non-qualified`), others carry their label (`ML-DSA non-qualified`). A test skips with the
  reason when its family is missing or the summary is `unavailable`.
- Fixtures (`utils/timestamping/fixtures.ts`): `admin` (AdminApi over the guarded `api`), `tsp` (plain context,
  protocol traffic, `TSA_TSP_BASE_URL` or BASE_URL), `ts` (the ready provisioning; the source's `env.<object>`).
- The two disruptive specs call `describeLocalOnly(test)`; the docker rows of `00` skip themselves (`skipUnlessLocalStack`). The block's `api`
  fixture is the framework's strict guarded context on every tier; the local-stack guard serves the setup's one trust request only.
- Artifacts (queries, replies, chains) go to the test's own output dir, never a shared fixed name.

### One tear-up, one tear-down

Four projects in `utils/devBlocks/registry.ts`: `timestamping-proof` (the local-backend proof) → `timestamping-setup` →
`timestamping` (the specs) → `timestamping-teardown` (the setup's teardown project, so it runs after the specs, red or
green). The config's global teardown runs the block's tear-down once more and removes the proof.

- Tear-up (`utils/timestamping/provision/`): a read-only preflight finds the pre-existing parents (connectors, the
  EJBCA authority instance, the vault instance, the profiles and CAs the authority offers) and never changes them; a
  missing piece makes the summary `unavailable` with the reason, and every test skips. Then every object the block needs
  is created for this run (vault profile, token, token profile, time-quality configuration, mapped user, role; per family
  and half: key, RA profile, TSA certificate, TSP profile, signing profile, Basic credential, permissions), named
  `<run id>-…` and written to the ledger right after its create. The one change to a pre-existing object: on a proven local
  stack, a self-signed issuing root that is not trusted yet is marked trusted (logged), through a second guard with `localStack`;
  on a shared tier the root must already be trusted, else the RSA family (and so the setup test) fails with that reason.
- A refusal of OUR request (400 / 422 on a create or update, 401 / 403 anywhere) or a failed RSA family fails the
  setup test: a broken body or login must never turn into a quietly skipped block. An ML-DSA family that fails becomes
  `missingFamilies` (its tests skip). Reasons carry method, path pattern and status only; answer texts go to the log.
- Tear-down (`utils/timestamping/blockTeardown.ts`): the block's ledger lines (spec `timestamping/…`, plus the objects
  the platform derived from them) go through the run-end delete engine, in core's reference order
  (`utils/timestamping/resourceTypes.ts`, every pair cited): Basic credentials → TSP profiles (activation removed, their
  vault secrets awaited) → signing profiles (signing records emptied) → time-quality configurations, then certificates,
  keys, RA profiles, token profile, token, users, roles, vault profile. The run-end teardown retries whatever is left.
- What can stay behind: an issuer CA certificate core pulled into the inventory while the setup read a chain, when its
  history is unreadable (logged); a vault secret core failed to delete (reported as a cleanup failure; the vault profile
  delete then fails with core's refusal); signing-record volume rows core keeps by design. The TSA certificates stay
  issued at the CA (core deletes its own copy only).

### Run

```
# a shared tier (Testkube): the rows without @local; a tier without the components skips every row with a named reason
REG_ENV_FILE=<tier env file> DEV_BLOCK=timestamping npx playwright test -c playwright.devblock.config.ts

# a proven local stack: all rows
REG_ENV_FILE=<local-stack env file> TIER_KIND=local DEV_BLOCK=timestamping \
  npx playwright test -c playwright.devblock.config.ts
```

The regression config holds no `@dev-tests` test. Disruptive tests (`@disruptive`: 50, 55) skip
unless `TSA_ALLOW_DISRUPTION=true`, and skip without a docker daemon (they are `@local`: a shared tier never lists them).

### Environment (utils/timestamping/config.ts)

| Variable | Default |
|---|---|
| TSA_TSP_BASE_URL | unset (BASE_URL); on AUTH_MODE=header behind the dev proxy point it at core itself |
| TSA_CRYPTO_PROVIDER | software-v2 (software-v1, software-v2, pkcs11) |
| TSA_AUTHORITY_NAME | ejbca.3key.company |
| TSA_EJBCA_EE_PROFILE | DemoTSAEndEntityProfile |
| TSA_EJBCA_CERT_PROFILE | DemoTSAEECertificateProfile |
| TSA_EJBCA_CERT_PROFILE_QUALIFIED | DemoTSAQCEECertificateProfile |
| TSA_VAULT_INSTANCE_NAME | vault |
| TSA_NTP_SERVERS | ntp (comma list) |
| TSA_ACCURACY | PT1S |
| TSA_MAX_CLOCK_DRIFT | PT0.8S |
| TSA_POLICY_ID_NON_QUALIFIED | 1.2.3.4.5.6 |
| TSA_POLICY_ID_QUALIFIED | 1.2.3.4.5.7 |
| TSA_SIGNATURE_SCHEME | PKCS1-v1_5 |
| TSA_SIGNATURE_DIGEST | SHA-384 |
| TSA_FAMILIES | rsa,mldsa65 (must include rsa) |
| TSA_EJBCA_CA | DemoRootCA_2307RSA |
| TSA_MLDSA_EJBCA_CA | MLDSA |
| TSA_ALLOW_DISRUPTION | false (`true` enables the tests that stop containers) |
| TSA_CONTAINER_CORE / _NTP / _TIME_QUALITY_MONITOR / _CRYPTOGRAPHY_PROVIDER / _TIMESTAMP_FORMATTING / _RABBITMQ | core / ntp / time-quality-monitor / software-cryptography-provider / timestamp-formatting-connector / rabbitmq |

### Running on a shared tier

Design and per-object verdicts: SHARED-TIER.md. In short: the rows without `@local` (everything but the docker rows of `00`, and `50` /
`55`) carry `@needs:timestamping`, resolved from reads before the row creates anything (OpenSSL 3 on the runner; connected
credential-provider SoftKeyStore, EJBCA, software cryptography v2, timestamp-formatting and vault connectors; the authority and vault instance
the `TSA_*` variables name). A tier without them skips each row with a `deploy gate` reason; the setup preflight then checks the EJBCA
profiles and CAs and writes `unavailable` with the reason. What the tier needs (DevOps): `timestampFormattingConnector`,
`timeQualityMonitor` + NTP (`TSA_NTP_SERVERS` = the tier's own NTP: the monitor polls every configuration's servers), `messaging.timeQuality`
on core, an EJBCA authority with the TSA end-entity / certificate profiles and a CA whose root is already trusted in the inventory, a vault
instance and a software cryptography provider v2. `TSA_CRYPTO_PROVIDER=software-v1` and `pkcs11` are not provisioned on a shared tier.

## Changes against the source

Fixed while porting: 40:106 / 40:152 (run-prefixed user and Basic credential, generated passwords, recorded in the
ledger), 60:77 and 70:113 / 70:136 (run-prefixed profile names, recorded after an unexpected create), 20:49 / 20:112
(artifacts per test), 50 / 55 (real `@slow` / `@disruptive` tags and the opt-in), 10:94 / 10:100 (skipped with the reason
"per-run provisioning: there is no previous summary to compare"). 40:59 still disables the shared-looking primary signing
profile, but it is now the run's own, with the `finally` re-enable.

## Known weak spots kept as in the source (for the authors)

- 40:87 / 40:100: `status < 500` with an optional 200 branch accepts a 401, 404 or 429; the truncated-DER test has no leak check.
- 40:244 / 45:82: `>= 400` plus `granted ?? false` duplicates the test that pins 500 (core#2140); no `issue` annotation or `test.fixme` with the target 415 / 406.
- 10:50 accepts either `defaultSigningProfile` or `signingProfile`; a renamed field passes.
- 20:145 genTime is compared with +-60 s against the runner clock; 20:161 uses 10 parallel requests (flaky on a busy pool, not configurable).
- 20:66 / 20:132 no explicit certReq true / false pair with chain verification.
- 40:265 / 40:291 allow-list tests branch on the environment's configuration and assert openssl message text.
- 45:122 GET / PUT pinned to 400 (HTTP says 405) without an issue link.
- 50:71 `/time/` matches any message containing "time".
- 60:116 the record window by time includes other clients' records on a shared tier.
- 70:87 `^ML-DSA-\d+$` accepts ML-DSA-44 / 87.
- Duplication (INTERNALS regex, signing-record polling, requestTimestamp option triples) and magic numbers (60 s, 180 s, 2 MiB, 10).
- Missing cases: hash length vs algorithm, unknown hash OID, request version, extensions, nonce sizes, malformed or repeated `reqPolicy`, empty / oversize imprint and trailing bytes, disabled TSP profile, deleted mapped user, rejection shape (`failInfo` without token).

The block is outside the spec lint (tests/unit/specGuards.spec.ts) by design: its TSP requests use a plain context with
Basic auth and deliberately odd media types and methods, and openssl / docker run as child processes. Its safety rests on
the strict guarded admin API (create-only rules, ownership = ledger + live run-prefixed name), the ledger, `@local` + the local proof
for the docker rows, and tests/unit/timestampingSpecs.spec.ts, which keeps every docker-bound row local.
