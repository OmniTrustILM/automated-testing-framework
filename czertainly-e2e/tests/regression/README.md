# REG-*: main-functionality regression

End-to-end checks of the release checklist's basic installation, configuration and usage tasks. They run
before a release goes to production. There is one spec per checklist item, and a full run chains them:
the configuration specs create objects through the UI, and the usage specs issue certificates through those
objects.

## Safety model: own objects only (decisions Q1 and D1)

The suite **reads everything, creates run-prefixed objects and changes only objects it created** in the same run
(enable, activate, edit, revoke, delete). It **never changes, disables, revokes or deletes anything that existed
before the run**. Existing objects are only read; for example, the CA host and name of an existing MS ADCS authority are
copied at runtime and never stored in this repository.

- **One run, one id.** Every created object is named `<REG_RUN_ID>-<suffix>` (`qa-reg-<yyyymmdd>-<hhmmss>-<4 random
  base36>-…`, `[a-z0-9-]` only, so the names are also valid in ACME URLs). Both configs share it (`API_RUN_ID` is
  forced to `REG_RUN_ID`); the adhoc defaults `qa-reg-adhoc` / `qa-api-adhoc` are refused. A hand-set `REG_RUN_ID` must
  match that format unless `REG_RUN_ID_REUSE=1` admits an earlier run's id, and it keeps its objects at the end unless
  `API_DELETE_OWN=1` is given. `<state dir>/<run id>.lock` refuses a second live run with the same id.
- **The ledger.** Every created object gets a `created` line in `$REG_STATE_DIR/created-objects.jsonl` (default
  `~/.ilm-qa/regression-state/`, always outside the clone) right after the create call and before any assertion: type,
  name, uuid, the spec, a note, the parents a later operation needs, and the tier identity (a hash of BASE_URL's host;
  the host itself is never written).
- **Ownership is the ledger plus the live object.** Every helper that changes or deletes an object takes an `OwnRef`
  (what `recordCreated` returns) and calls `assertOwnLive` first: the object's `created` line of this run on this tier,
  and a live object whose name carries the run prefix (the prefix alone is never enough; the ledger's own name decides,
  never a name passed in; a ledger type that is neither read live nor id-named is refused).
- **Deny by default (the guarded `api` fixture).** Specs take the `api` fixture (`fixtures/testFixtures.ts`): the
  authenticated context wrapped in `utils/regression/guardedApi.ts`. GETs pass; a POST passes on the search /
  attribute-validation / protocol allow-list; a create passes when its body names no foreign object; every other
  mutation reaches the server only when every uuid it names is own: in the path (scope parents excepted; since fix pass 6
  a path target or a bulk-route uuid counts only with a ledger line of the type of the resource the route acts on, so an
  id-named line such as `approvals` cannot stand in for an RA profile, and a target of a resource the suite has no
  ledger type for is refused unless it is a probe), in the body (since fix pass 6b a uuid under a typed field such as
  `groupUuids`, `ownerUuid` or `triggers` needs a ledger line of that field's type: `BODY_FIELD_TYPES`; since fix pass 7
  `objectUuid` is typed by its sibling `resource`, the uuid list bodies of `PATCH /v1/roles/{id}/users` and
  `PATCH /v1/users/{id}/roles` by `LIST_BODY_TYPES` — a uuid list on any other targeted route is refused — and a uuid in
  a `text/plain` or non-JSON body may not rest on an id-named ledger line)
  (every uuid-valued field outside attribute payloads, recognised in the forms the server parses; a few reference
  fields such as `connectorUuid` / `raProfileUuid` may name pre-existing objects on an own create / update) and in the
  query string / `params`. String and Buffer bodies must be JSON, `form` / `multipart` are refused, every request (GET
  and HEAD included) goes to BASE_URL's origin only, platform endpoints (settings, scheduler, connector approval,
  trusted certificates, audit-log purge, CBOM, OIDs, discovery schedules, …) are refused outside a proven local stack;
  derived objects are left to the teardown; ownership is checked before the dry run. The guard judges what is SENT
  (B0 fix pass 4): a URL with a control character, space or non-ASCII character is refused (the URL parser would strip
  or re-encode it), the path as written must be the path Playwright sends (no dot segments, backslashes, encodings,
  relative paths or trailing slashes; segments `[A-Za-z0-9._~-]` only), a uuid in any other than the canonical form
  (padded, lenient groups, base64, `urn:uuid:`) is refused rather than canonicalised, bodies are judged as serialised
  (`toJSON`), and a bulk mutation names its objects in a non-empty top-level list. Since fix pass 5 the guard SENDS
  what it judged: every input is read once (options, headers, params, body, a Request object) and only that snapshot
  goes to Playwright — options `data`, `params`, `headers`, `timeout`, `failOnStatusCode`, `ignoreHTTPSErrors`,
  `maxRedirects`, `maxRetries` (`method` on `fetch`), anything else (`url`, `request`, `encodedParams`, …) refused;
  headers `content-type: application/json`, `accept`, `if-*` (identity headers only with `identityOverride: true`);
  for a 415 negative `content-type: text/plain` (optionally `; charset=utf-8`) with a string / Buffer body on a non-GET
  request and no identity header: the body is sent as written and judged as raw text (every canonical uuid in it own or
  a probe, no other uuid-like token; refused on bulk routes, whose DTO is JSON);
  the URL written as `/…` or `<scheme>://…`; mutations never follow a redirect, GETs only same-origin ones. A string
  body that is not JSON travels (under `application/json`) as the JSON string Playwright makes of it (send a Buffer for a malformed-JSON case);
  duplicate JSON keys are refused. A mutation without a uuid in its path must be an allow-listed create or one of the
  bulk routes of `utils/regression/apiRoutes.ts` (derived from the `interfaces` controllers) with exactly its DTO body;
  a path segment that names an object by name (`/v1/operations/{raProfileName}/…`) is refused; the padded 24-character
  base64 form (`…==`) counts as a uuid everywhere, the unpadded 22-character one only under a uuid-typed key (`*uuid*`,
  `id`, `ids` and the `UUID` / `List<UUID>` request DTO fields of `interfaces`, e.g. `triggers`, `internalRules`,
  `groups`: `UUID_TYPED_FIELDS`); GETs that persist something (certificate validation / chain, token detail,
  approvals, …: `SIDE_EFFECT_GETS`, matched case-sensitively) run on own objects of the route's type only; every GET /
  HEAD path, followed redirect hop and raw `apiJson` GET obeys the same structural rule as a mutation path (no `//`,
  `.` / `..` segment, `;`, `%2f` / `%5c` / `%2e`, backslash or `/API` spelling; the query string is free); a
  connector's health check is a plain read (REG-DEP-01 reads it for the pre-existing connectors). Ledger ids are canonical uuids (or
  `<namespace>/<name>.<kind>` for `k8s:*`, the kind in the id so a Certificate and a Secret of one name are two objects). **TRACE**
  (the refused-method sentinel API-GEN-32[method]) is sent through `fetch` as a bodyless READ held to the GET rules: same origin,
  the structural path rule, no body, no identity header (`identityOverride` refused too), no `text/plain`, never a redirect
  follow, and refused outright on a side-effect-GET path; any other method stays refused. API-GEN-32[method] judges only core's
  answer (`judgeRefusedMethod`): a 405, a proxy `Server` header or a non-JSON body skips it with "refused by the ingress before core"; the
  body of a TRACE answer is never printed. The connector attribute CALLBACK
  POSTs stay mutations for the guard (core stores the attribute definitions a group / NG callback answers). The mutating helpers of `utils/regression` take a `GuardedApi`, and `apiJson`
  refuses a raw context for anything but a GET or a read-only / protocol POST. `tests/unit/specGuards.spec.ts` lints
  tests/regression, tests/api, utils/regression and utils/api: no `getAuthenticatedApiContext`, no raw `request`
  fixture / `page.request` / `fetch` for non-GET, no alias, element access, dynamic method, cast or `apiJson*` variant
  around the guard, util imports only from the allow-list (`create*`, `find*`, `get*`, `list*`, `wait*`, `generate*`,
  `upload*`, `ensure*`), and in the specs: no `child_process`, `test` only from the fixtures (or `utils/api/apiCase`), no
  `.extend(`, no `route.continue` / `route.fulfill` with a method, no http / https / undici / Kubernetes client imports;
  imports by allow-list (relative inside the suite, `@playwright/test` for types only, the node built-ins assert,
  buffer, crypto, fs, os, path, string_decoder, timers, url, util, zlib), no `process.env` writes, no fs writes /
  removals, no `createRequire` (fix pass 4); `globalThis.process` / `global.process` count as `process`, no `eval`,
  `Function`, `.constructor(…)` or string timers, no `process.env` handed to a non-suite function, no request option the
  guard does not forward, no `test.use` of a context fixture (fix pass 5).
  Exempt, with the reason in the spec: the guard proof (`_run-setup.setup.ts`, three rules), `utils/api/apiCase.ts`
  (raw-context only) and `guardedApi.ts`, `teardownHandlers.ts`, `runTeardown.ts`, `nonInterference.ts`. Objects the platform made for the run
  (`certKey_<CN>` keys, certificates a discovery onboarded as new) are `derived` lines with `createdAfter` from the
  server's clock; they are deleted only when made after it and not adopted (owner, group, location, RA profile,
  request), otherwise kept and reported (`$REG_STATE_DIR/<run id>.kept.json`; `REG_KEPT_STRICT=1` fails the run on
  it); a derived object whose creation time cannot be read fails the teardown. An RA profile named by
  `REG_RA_PROFILE_NAME` (local stack only) is an issue-only parent (`IssueOnlyRef`): nothing on it is changed.
- **Creates under a pre-existing parent (accepted deviation, round-6 R6-4).** A create under a pre-existing parent (an
  RA profile under an authority, a key in a token, a location in an entity, a secret in a vault profile, a v2 issue under
  an RA profile) is create-only (decision Q1): the child is own, recorded and deleted at the end of the run; the parent
  is not mutated.
- **Cleanup is part of the test result.** The run-end teardown (`utils/regression/runTeardown.ts`, the globalTeardown
  of both configs) deletes the run's own objects in dependency order (issued certificates are revoked, then deleted;
  users leave their roles first), each with a fresh login, and proves every delete by a GET that answers 404 (a 404
  counts only after a 200 in the same step: a wrong route is never mistaken for a deleted object). A 5xx is never
  proof; for roles and users only (known bug core#2511: their detail answers 500 for a deleted uuid) a 5xx is
  confirmed through the full `GET /v1/roles` / `GET /v1/users` list, and the workaround is listed under `knownBugs` in
  `$REG_STATE_DIR/<run id>.kept.json`. It appends a
  `deleted` line for each and fails the run on anything it could not remove. `API_DELETE_OWN=0` keeps the objects
  (debugging one spec); `API_TEARDOWN_DRY_RUN=1` prints the plan and deletes nothing, on every path. Switches accept
  `1 / true / yes / on` and `0 / false / no / off`; anything else stops the run.
- **Kubernetes objects** (`k8s:<kind>` ledger lines, REG-USE-06): the teardown never deletes them. `utils/regression/
  k8s.ts` records each run-prefixed object before its `kubectl apply`, and the spec's `afterAll` calls `removeOwnK8s`
  (ledger check, delete, absence proof, `recordDeleted('k8s:<kind>', …)`); a `k8s:` line without its `deleted` line is
  reported as a leftover and fails the run.
- **Non-interference (API-GEN-33).** On a shared tier the `snapshot` project first proves the guard live (guard proof,
  behind a spy that refuses every mutating request instead of forwarding it) and then records the pre-existing objects;
  the `non-interference` project and the teardown (after its deletes) prove that none of them changed (name,
  description, state marker) or vanished and that every total changed exactly by what the ledger explains
  (`REG_NET_TOLERANCE`, default 0). A required resource that cannot be read, or a missing snapshot, fails the run;
  reports name resource types and uuids only. A violation fails the run; a person rules out concurrent activity on the
  tier.
- **`@local` rows** (docker control, platform settings, schedules) run only with `TIER_KIND=local`, which the configs
  accept only with positive proof of a local stack: a loopback (or private, RFC 1918 / link-local `TIER_LOCAL_HOSTS`)
  `BASE_URL` and `REG_LOCAL_CORE_URL`, the core's `/api/v1/info` build marker, a running docker container publishing
  the core port (`REG_LOCAL_COMPOSE_PROJECT` narrows it to a compose project; no docker CLI, no local mode) on the
  core's own machine on a bind address that serves the core URL (a private core host must be an address of this
  machine or `DOCKER_HOST` — or the current docker context — must point at it; a loopback TCP / SSH docker endpoint
  only when its daemon ID equals the local socket's), and in
  the setup BASE_URL's `/api/v1/info` read with the run's authentication naming the same build (version plus commit or
  build time; unreadable: refused) and a run-prefixed role created through BASE_URL read back through
  `REG_LOCAL_CORE_URL` with `AUTH_CLIENT_CERT` (the same instance, not only the same build) and, last, from inside the
  container that publishes the port, through its own port (`docker exec`). Only then the run's
  local-backend proof is written; it expires after 6 h and is removed when the next run starts and at the end of the
  teardown. With `TIER_KIND` unset the configs exclude `@local` rows; the spec skips them a second time
  (`describeLocal`), also without this run's proof, and the guard's `localStack` option needs the proof too.
  `AUTH_MODE=header` is accepted only for a local `BASE_URL`; `*.localhost` names count only when they resolve to
  loopback addresses.
- **Env files.** `REG_ENV_FILE` (or, for the REG / API configs only, `API_ENV_FILE`) replaces the `.env` of the working
  directory entirely, and a named file that does not exist stops the run; `TIER_KIND`, `AUTH_MODE` and
  `REG_RA_PROFILE_NAME` are frozen when the config loads, so no later file can change them. A run without `BASE_URL`
  fails (never green and empty).

## Specs

| Spec | Checklist item | Status on the QA dev tier (2026-10-08) |
|---|---|---|
| `REG-DEP-01-post-install` | Deployment 1: new deployment (QA-side post-install check: versions, required connectors); B1: `.a` / `.b` anonymous health bodies, `.c` the `/info` contract, `.d[<connector>]` required connectors ALIVE (live health by version + one read-only attribute call; `REG_BLOCKED_CONNECTORS=name:reason` skips one with the named blocker); `.a` budgets 5 s per probe from the runner (a remote tier adds DNS / TLS / ingress; the time is annotated) | pass (before B1); `.d[MS-ADCS-NG-Connector]` expected red while its health answers 503 |
| — | Deployment 2: upgrade | not automated (needs an upgrade event) |
| `REG-CFG-01-credential` | Configuration 1: basic credential (+ duplicate name refused) | pass |
| `REG-CFG-02-authority-adcs` | Configuration 2: MS ADCS CA (NG connector, manual CA host and name); skips with the named blocker when the connector's LIVE health fails (B1) | pass |
| `REG-CFG-03-ra-profile` | Configuration 3: RA profile on MS ADCS (created disabled, then enabled); same live-health skip (B1) | pass |
| `REG-CFG-04-acme-profile` | Configuration 4: ACME profile with a pre-authorized DNS identifier | pass |
| `REG-CFG-05-acme-on-ra-profile` | Configuration 5: ACME profile activated on an own RA profile (`RaProfilePage`); B1 `.2`: an RA profile name with a space is refused at activation | pass |
| `REG-CFG-06-group` | Configuration 6: certificate group (+ duplicate name refused) | pass |
| `REG-CFG-07-role` | Configuration 7: role (`RolePage`); B1 `.a` duplicate name (`test.fail`, core#2297), `.b` edit (name locked), `.c` delete in the UI | pass |
| `REG-CFG-08-role-permissions` | Configuration 8: role permissions | pass; the object-scope test is a **known failure, W-11 = fe-administrator#2283** |
| `REG-CFG-09-user-role` | Configuration 9: user with the role (`UserPage`); B1 `.b` edit (username locked), `.c` delete in the UI | pass; login as the user is skipped without an IdP account |
| `REG-USE-01-dashboard` | Usage 1: dashboard tiles, charts, legend drill-down | pass (the Type legend opens unfiltered by design, fe-administrator#1136, so it is not checked) |
| `REG-USE-02-inventory-filter` | Usage 2: inventory, Common Name filter, detail, clear filter | pass |
| `REG-USE-03-import` | Usage 3: import PEM, "Already in inventory", PKCS#12 password flow, CSR refused | pass |
| `REG-USE-04-issue-ui-external-csr` | Usage 4: Web UI issue with an external CSR (+ garbage CSR refused); B1 `.1`: DNS + IP SANs on the issued certificate, Details and History | pass |
| `REG-USE-05-issue-acme` | Usage 5: ACME (RFC 8555 client in `utils/regression/acmeClient.ts`); B1 `.1[rsa-2048 / ec-p256]` order expiry, Retry-After, chain, SAN, key; `.2` second finalize → `orderNotReady` | pass |
| `REG-USE-06-issue-cert-manager` | Usage 6: cert-manager issuer — B1 `.1`: driven by `raProfileUuid` (the CRD's required field; `raProfileName` is never read) | skipped without a cluster (env vars, then `requireTool('kubectl')` and the NAMESPACED preflight: both kinds listable in the namespace, `auth can-i` create / delete on them and get / delete on secrets) |
| `REG-USE-07-issue-api` | Usage 7: v2 operations API issue, poll, detail, history, download; B1 `.1`: the exact response contract, SANs, history text, garbage CSR → 400 `{message}`, no token → 401 | pass |
| `REG-AUTH-01-session` | ilm#426 (auth-rbac area): `REG-AUTH-01[session]` sign-in as the test user + `session-id` cookie, `REG-AUTH-02` the session holds across navigation, reloads and a second tab (skips in header mode: no session), `REG-AUTH-07` disabled user's live session (second identity, `test.fixme` until the guard accepts the dedicated user); under `describeLocal`: `REG-AUTH-01[header]`, `REG-AUTH-05` core restart (`@needs:keycloak-local`), `REG-AUTH-07[delete]` | not run yet |
| `REG-AUTH-08-rbac-ui` | ilm#427: a refused page renders the lock widget (`REG-AUTH-08[F0|F1]`) and a group-scoped user sees only its certificates (`REG-AUTH-10`); both need the second identity and `test.fixme` until the guard accepts the dedicated user | not run yet |
| `REG-AUTH-99-logout` | ilm#426: `REG-AUTH-03` sign-out ends the browser and identity-provider sessions (runs last: it ends the shared admin's single-sign-on session) | not run yet |

**Known failures** are marked with `test.fail()`. They pass the run while the bug exists, and they turn red
("expected to fail, but passed") once it is fixed. Remove the marker then.

- **W-11 = fe-administrator#2283** (confirmed on 2026-10-09 by two more models): in the role permissions editor, actions ticked on one object (for example one RA profile) are
  also granted at resource level, so they apply to every object. The cause is that a new object's `allow`
  list aliases the resource `actions` array, and `structuredClone` keeps the aliasing.

## Running

```bash
cd czertainly-e2e
# all specs against the tier in .env (or another tier's env file)
REG_ENV_FILE=/path/to/tier.env npx playwright test -c playwright.regression.config.ts
# one flow
npx playwright test -c playwright.regression.config.ts REG-USE-05
# reuse an earlier run's objects instead of creating a new chain (useful while debugging one spec): use that run's id
# (printed at the start of the run, e.g. qa-reg-20261013-142501-k3x9); a hand-set id keeps its objects at the end
REG_RUN_ID=qa-reg-20261013-142501-k3x9 npx playwright test -c playwright.regression.config.ts REG-USE-04
# an id of an older shape (minute-granular runs) needs REG_RUN_ID_REUSE=1
REG_RUN_ID=qa-reg-20261008-1200 REG_RUN_ID_REUSE=1 npx playwright test -c playwright.regression.config.ts REG-USE-04
# what the run-end teardown would delete for a run id, without deleting anything (no login, no request)
REG_RUN_ID=qa-reg-20261013-142501-k3x9 API_TEARDOWN_DRY_RUN=1 npx playwright test -c playwright.regression.config.ts --grep @no-such-tag --pass-with-no-tests
# delete what a kept run left behind (dry run first, as above); the snapshot project gives the post-delete check its
# before snapshot, so the run can prove it touched nothing else
REG_RUN_ID=qa-reg-20261013-142501-k3x9 API_DELETE_OWN=1 npx playwright test -c playwright.regression.config.ts --project=snapshot
# report with a screenshot per test
npx playwright show-report playwright-report/regression
```

The config has no `globalSetup`, because the smoke setup registers EJBCA objects that this suite does not need.
It runs on one worker in file order (CFG → DEP → USE; `--workers` above 1 is refused), after the `snapshot` project
(`tests/api/_run-setup.setup.ts`: guard proof, then API-GEN-33 before) and before the `non-interference` project. A
spec run alone finds no run state and creates its prerequisites through the API instead. A run with `--no-deps` skips
the snapshot, so on a shared tier its teardown ends red: without a before snapshot there is no proof.

**Running live: keep the evidence first.** Playwright empties `test-results/<config>/` at the start of the next run, and a unit run
or another config can clear it too (live run 2 lost every screenshot, trace and error context that way, so its triage worked from the log
alone). After EVERY live run, before anything else runs (a second config, `npm run test:unit`, a re-run), copy
`test-results/<config>/` (and `playwright-report/<config>` when a report was made) to the workflow evidence folder of the run, for example
`cp -R test-results/regression <evidence>/live-run-N/test-results-regression`. Cleanup reports and the run summary now carry the full error text of a failed removal, which can include URLs and response text of the tier: they must pass `leakscan.py` before anything from them goes to GitHub. Evidence stays outside the repository (screenshots and traces
may show tier data; nothing from them goes to GitHub without the public-safety check).

Environment variables are listed at the end of `.env.example` (`REG_*`). The usual ones are:

- `REG_ENV_FILE`
- `REG_RUN_ID` / `REG_RUN_ID_REUSE`
- `TIER_KIND` (`local` for a disposable stack, with `REG_LOCAL_CORE_URL`; unset = shared tier)
- `API_DELETE_OWN` / `API_TEARDOWN_DRY_RUN`
- `REG_NET_TOLERANCE` (non-interference accounting; default 0)
- `REG_ADCS_SOURCE_AUTHORITY`
- `REG_CA_CONNECTORS` (B1: the CA order of the run RA profile, default MS ADCS NG, EJBCA-NG, PyADCS) and
  `REG_EXACT_SAN_CONNECTORS` (CAs whose issued SAN set must equal the CSR's; default EJBCA-NG)
- `REG_REQUIRED_CONNECTORS` / `REG_BLOCKED_CONNECTORS` (`name:reason;…`) for REG-DEP-01.d, `REG_GATE_CONNECTOR` for
  API-GEN-32[connector]
- `REG_EXPECTED_CORE_VERSION` / `REG_EXPECTED_FE_VERSION` for a release tier
- `REG_RESTRICTED_USERNAME` / `REG_RESTRICTED_PASSWORD` (the dedicated second identity, DevOps request 2; the AUTH rows that need it skip without them), `REG_CORE_REPLICAS` (default 1: the "next request" rows need one core replica), and for `REG-AUTH-05` on a local stack `REG_LOCAL_COMPOSE_PROJECT`, `REG_LOCAL_COMPOSE_FILE`, `REG_LOCAL_SERVICE_CORE` (default `core`)

## Layout

- `playwright.regression.config.ts`: config (`prepareRun`, tier rules, projects snapshot → regression →
  non-interference, run-end teardown, one worker). `playwright.api.config.ts` is the API-* config with the same rules.
- `utils/regression/runEnv.ts`: `prepareRun` (env file, frozen variables, run id, tier guards, one worker, run lock);
  `runId.ts`: run id, state directory, run lock; `flags.ts`: the switch parser and the dry-run check; `tier.ts`:
  `TIER_KIND`, the local-backend proof, the tier identity, `describeLocal`; `projectFilters.ts`: the tier rules ANDed into
  every project; `tags.ts`: `meta()`, the tag builders and the source checks (TypeScript AST).
- `utils/regression/regressionRun.ts`: names, run state, ledger (`recordCreated`, `recordDerived`, `recordDeleted`).
- `utils/regression/ownObjects.ts`: `isOwn` / `assertOwn` / `assertOwnLive`; `guardedApi.ts`: the guarded API context
  (the `api` fixture); `apiRoutes.ts`: the bulk routes, API words and side-effect GETs the guard allow-lists; `guardProof.ts`: the blocking spy of the guard proof; `k8s.ts`: kubectl under the k8s contract;
  `runTeardown.ts` + `teardownHandlers.ts`: the run-end deletion; `nonInterference.ts`: the API-GEN-33 snapshot and
  comparison.
- `utils/regression/invariants.ts`: filter, sort and paging oracles; `build.ts`: build marker (`/v1/info`);
  `tools.ts`: runner tool preflight (`requireTool`).
- `utils/regression/regressionApi.ts`: reads and own-object API helpers; `ensure*` returns the run object or
  creates it through the API. B1: the run RA profile is CA-agnostic (`ensureRaProfile`: the first CA in
  `REG_CA_CONNECTORS` whose connector answers its LIVE health and has an enabled RA profile; the run creates its OWN RA
  profile under that authority with the connector attributes copied read-only, `createRaProfileLike`; no CA → the
  specs skip with the named deploy gate, `ensureRaProfileOrSkip`); `ensureOwnRaProfile` clones an issue-only parent
  (REG_RA_PROFILE_NAME) before anything is activated on it; `createOwnRole` / `createOwnUser` / `setOwnUserRoles`;
  `recordCertificatesNamed` / `recordAcmeAccount` / `recordDerivedKeyOf` record what a protocol or the platform made.
- `utils/regression/connectorApi.ts` (B1): live connector health by version (v1 `ok`, v2 `UP`), read-only attribute
  probes, the anonymous probe reader; `errorContract.ts`: the 422 array / `{message}` body shapes;
  `inventorySeed.ts`: the run's own inventory seeds with an exact manifest (B1: the API-GEN-32 null-last subset).
- `utils/regression/pki.ts`: CSR with DNS / IP SAN (RSA, node-forge; EC P-256 through @peculiar/x509), certificate SANs
  and SPKI, the leaf-first chain check, PKCS#12, fingerprints.
- `utils/regression/acmeClient.ts`: a minimal ACME client (ES256, node:crypto). It does not answer
  challenges, because the regression ACME profile pre-authorizes its identifier.
- `pages/RegressionUi.ts`: custom Select, toolbar icons, `widget` / `iconButton` (a button scoped by its widget title),
  toasts (`assertToast`, `assertAnnounced`), required custom attributes, inventory filter. B1 page objects:
  `RaProfilePage` (protocol activation by row), `RolePage`, `UserPage`; `CertificatePage` gained the SAN widget and the
  issued-details assertions, `LoginPage` the session helpers of the API-GEN-32 session sentinel.

## Events and discovery rows (ilm#424 Phase 7)

Workflows (REG-WFL-*, API-WFL-*), notification instances / profiles and network discovery (REG-DISC-*, API-DISC-*).

- **Own objects only.** Conditions, rules, executions, actions, triggers, notification instances / profiles, discoveries and the
  groups / RA profiles / certificates the rows use are created by the run (ledger before assertion, `workflowApi.ts`,
  `notificationApi.ts`, `discoveryApi.ts`, `eventsDrivers.ts`). An event association is recorded as an `eventAssociations` ledger
  line (id-named; the (event, resource, object) in `note`) BEFORE it is sent, and the teardown clears it with the same replace-all
  (empty list) on an own scope, ahead of the triggers (`utils/workflowUtils.ts`). Nothing is associated at platform level on a
  shared tier: the platform-level rows (`Certificate uploaded` triggers, schedules, delivery) are `@local` only.
- **Discovery targets.** Only the run's own TLS target (`utils/regression/tlsTarget.ts`, listeners on `REG_SCAN_BIND`, named
  `REG_SCAN_HOST`, `@needs:scan-target`) or RFC 5737 documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24).
  Never the "select all" cleanup of SMK-003: the certificates a run onboards are recorded as `derived` ledger lines
  (`recordOnboarded`, server-clock `createdAfter`) and deleted by uuid. A generation that is not registered is a named deploy gate
  (`@needs:v1-discovery` / `@needs:v2-discovery`), never a pass.
- **Notifications.** Delivery is asserted only in the local notification overlay (`@local:notif`; `REG_SMTP_CATCHER_URL`,
  `REG_WEBHOOK_HOST` / `REG_WEBHOOK_BIND`, runner-hosted `WebhookReceiver`); on a shared tier the rows use internal-only profiles or
  assert the stored state. Sender / URL values use the reserved `.test` names.
- **Shared-tier hygiene of the firing rows.** A row that asserts an exact firing, a history row or "nothing happened" reads the platform event
  settings first (`getPlatformTriggerGate`, read only) and skips with a named reason when a platform-level trigger already listens on its
  events, as the `@local` rows do for an occupied platform list. An absence over a clock window ("no second run", "nothing delivered") keeps
  its window but reads API state through it and asserts on every read (`assertHeldFor`).
- **UI builds.** REG-WFL-01 / 03 / 23 build their objects through the UI forms (`pages/WorkflowPage.ts`, `ConditionFilterWidget.ts`,
  `EventsAssociationWidget.ts`, `EventHistoryWidget.ts`, `NotificationPage.ts`, `DiscoveryRunPage.ts`); the other rows build through the
  API and use the UI only to read.
- **Needs tags.** `@needs:scan-target`, `@needs:v1-discovery`, `@needs:v2-discovery`, `@needs:smtp-catcher`, `@needs:webhook-receiver`,
  `@needs:email-provider`, `@needs:webhook-provider`: a missing one skips the row with the named deploy gate.

