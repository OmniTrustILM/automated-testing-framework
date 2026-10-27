# Regression and API suites

This folder holds the main-functionality regression suite (`REG-*`); `tests/api` holds the API suite (`API-*`). Both
run against a live ILM installation before a release and share one safety model: **they may create objects, but never
change or delete anything they did not create.** This page explains that model and how to run every suite of the
repository.

> **The smoke suite is outside this safety model.** It provisions its own connectors and PKI chain, and some of its tests
> delete objects they did not create (one uses the UI's bulk delete on the first page of a list). Run it only against a
> dedicated or local deployment that nobody else uses — never against a shared tier.

| Suite | Folder | Config | What it checks |
|---|---|---|---|
| smoke | `tests/smoke` | `playwright.config.ts` | a short health check of a dedicated deployment; **not create-only** (see below) |
| regression | `tests/regression` | `playwright.regression.config.ts` | the release checklist's installation, configuration and usage flows, plus the extension rows per area |
| API | `tests/api` | `playwright.api.config.ts` | positive and negative API cases per area, and the migration gate |
| unit | `tests/unit` | `playwright.unit.config.ts` | the framework itself (guard, ledger, teardown, configs, page objects); no environment |
| visual | `tests/visual` | `playwright.visual.config.ts` | screenshot baselines of a locally running frontend |

## Concepts

### Tier

A **tier** is one ILM installation the suites run against, named by `BASE_URL` in an env file. There are two kinds:

- **Shared tier** (`TIER_KIND` unset): a development or test environment that people and other tools use at the same
  time. Everything that existed before the run belongs to someone else. This is the default, and the strict rules below
  are written for it.
- **Local tier** (`TIER_KIND=local`): a disposable stack on this machine. The configs accept it only with positive
  proof: a loopback (or listed private) `BASE_URL` and `REG_LOCAL_CORE_URL`, the core's build marker, a running
  container that publishes the core port, and, in the setup, a run-prefixed role created through `BASE_URL` and read
  back through the local core URL. Only then are the `@local` rows (docker control, platform settings, schedules,
  delivery) allowed to run. Without that proof they are excluded by the configs and skipped a second time by
  `describeLocalOnly` in the spec.

Each run records the **tier identity** (a hash of `BASE_URL`'s host; the host itself is never written). A ledger line of
another tier is never acted on.

### The run id

Every run has one id, `qa-reg-<yyyymmdd>-<hhmmss>-<4 random characters>`, shared by both configs and every worker. Every
object the run creates is named `<run id>-<suffix>`. The id is set once when the config loads (`prepareRun`); the
adhoc defaults `qa-reg-adhoc` / `qa-api-adhoc` are refused. A hand-set `REG_RUN_ID` must have the same format (or
`REG_RUN_ID_REUSE=1` for an older one), and a hand-set run keeps its objects at the end unless `API_DELETE_OWN=1`. A
lock file in the state directory refuses a second live run with the same id.

### Create-only and the run ledger

1. **Read anything, create run-prefixed objects, change only own objects.** Enable, edit, revoke and delete are done
   only on objects this run created. A pre-existing object is only read (for example, the CA host of an existing
   authority is copied at runtime and never stored in the repository).
2. **Ledger before assertion.** Every create is recorded in the run ledger (`created-objects.jsonl` in the state
   directory, `REG_STATE_DIR`, always outside the clone) right after the create call and before any assertion: type,
   name, uuid, the spec or test id, the parents a later step needs, and the tier identity. A create made in the UI is
   recorded from the form's answer, not from the page it redirects to: the page object's `submit…` method returns
   `{ status, uuid, text, … }` as soon as the request is answered, the spec calls `recordUiCreate` (or `recordIfCreated`
   for a probe that expects a refusal), and only then waits for the detail route. Page objects never write ledger lines.
3. **Ownership is the ledger plus the live object.** A helper that changes an object takes the `OwnRef` that
   `recordCreated` returned and calls `assertOwnLive` first: the object needs a `created` line of this run on this tier
   AND a live name that carries the run prefix. The prefix alone is never enough.
4. **Objects the platform makes for the run** (the key of an issued certificate, certificates a discovery onboarded)
   are `derived` lines with a creation time from the server's clock. They are deleted only when they were made after
   that time and nobody adopted them (owner, group, location, RA profile); otherwise they are kept and reported.
5. **Children under a pre-existing parent** (an RA profile under an existing authority, a key in an existing token) are
   own objects; the parent is never changed.
6. **Kubernetes objects** (`k8s:<kind>` lines) are recorded before `kubectl apply` and removed by the spec itself; a
   line without its `deleted` line fails the run.

### The guard

Specs get an API context through the `api` fixture (`fixtures/testFixtures.ts`), which wraps Playwright's context in
the guard (`utils/regression/guard/createGuard.ts`, rules in `utils/regression/guard/`). It is **deny by default**:

1. A GET passes. A POST passes when its path is an allow-listed search, attribute validation, protocol endpoint or
   create, and a create body names no foreign object.
2. Every other request reaches the server only when every uuid it names is own: in the path, in the body (typed by the
   field it sits in), in the query string. A uuid must have a ledger line of the type of the resource the route acts on.
3. The guard judges what is **sent**: the URL as Playwright will send it (printable ASCII, same origin as `BASE_URL`,
   no dot segments, encodings or backslashes), every input read once and only that snapshot forwarded, uuids only in
   their canonical form, bodies as serialised, a bulk mutation naming its objects in a non-empty list.
4. Platform endpoints (settings, scheduler, connector approval, trusted certificates, audit-log purge and similar) are
   refused outside a proven local tier. GETs that persist something (certificate validation, token detail) run on own
   objects only.
5. Mutations never follow a redirect; reads follow same-origin redirects only. A request option the guard does not
   understand is refused. The TRACE method of the migration gate is sent as a bodyless read under the GET rules.
6. A lint in the unit suite (`tests/unit/specGuards.spec.ts`, rules in `utils/regression/specLint/rawMutations.ts`) keeps raw contexts
   out of the specs and the regression helpers: no unguarded non-GET request, no `process.env` or file-system writes,
   imports by allow-list. The one exception is the guard proof in `tests/api/tier-snapshot.setup.ts`.
7. **Guard proof.** Before any spec runs, the `snapshot` project proves the guard on the target tier: it accepts a role
   this run created, refuses a run-prefixed uuid without a ledger line and refuses a pre-existing role, all behind a
   spy that forwards reads only, so a guard regression cannot change a real object.

### Teardown

The run-end teardown (`utils/regression/teardown/runTeardown.ts`, the `globalTeardown` of both configs) is part of the test
result:

1. It deletes the run's own objects in dependency order (issued certificates are revoked first, users leave their roles
   first), each with a fresh login and through the same ownership check as a spec.
2. Every delete is proven by a read that answers 404, and a 404 counts only after a 200 in the same step, so a wrong
   route is never mistaken for a deleted object. A 5xx is never proof. For roles and users only, whose detail answers
   500 for a deleted uuid (core#2511), the full list is read instead and the workaround is reported.
3. It appends a `deleted` line per object, lists what it kept in `<run id>.kept.json`, and fails the run on anything it
   could not remove (`REG_KEPT_STRICT=1` also fails on kept objects).
4. `API_DELETE_OWN=0` keeps the objects (debugging one spec). `API_TEARDOWN_DRY_RUN=1` prints the plan and deletes
   nothing, on every delete path. Switches accept `1 / true / yes / on` and `0 / false / no / off`; anything else stops
   the run.

### Non-interference

On a shared tier the run proves that it changed nothing it did not create:

1. The `snapshot` project (`tests/api/tier-snapshot.setup.ts`) records every pre-existing object of the required
   resources (name, description, a marker of its state) and the totals, after the guard proof.
2. The `non-interference` project (`tests/api/tier-non-interference.api.spec.ts`) runs after every other project, even
   failed ones, and the teardown repeats the check after its deletes: every pre-existing object still exists and is
   unchanged, and every total changed exactly by what the ledger explains (`REG_NET_TOLERANCE`, default 0).
3. A required resource that cannot be read, or a missing snapshot, fails the run: no snapshot, no proof. Reports name
   resource types and uuids only. A violation is a finding; a person rules out concurrent activity on the tier before
   calling it a defect.

## Folder layout

```
tests/regression/<NN-area>/<NN-behaviour>.spec.ts   release checklist and extension rows (REG-*)
tests/api/<NN-area>/<behaviour>.api.spec.ts         API cases per area (API-*)
tests/api/tier-snapshot.setup.ts                    run infrastructure, not an area: the guard proof and the before snapshot
tests/api/tier-non-interference.api.spec.ts         run infrastructure, not an area: the after comparison
tests/api/run-objects.setup.ts                      run infrastructure: the objects the regression specs build on
tests/timestamping, tests/key-onboarding            the developers' blocks (@dev-tests), their own config
tests/smoke                                         the smoke suite, unchanged
tests/unit                                          the framework's own tests
```

Areas are numbered (`01-sign-in-and-access`, `02-certificates`, `03-configuration` ... `13-workflows-and-notifications`)
and so are the specs inside them; the numbers keep the run order, because Playwright runs the files of a project in path
order.

**Main flow and secondary flow.** The main flow is what a release must pass first. It holds the eighteen release-checklist
flows (Deployment `07-deployment/01` to `02`, Configuration `03-configuration/01` to `09`, Usage `12-main-usage/01` to
`07`), the certificate lifecycle UI tests (`02-certificates/07`, `10`, `12`, `16`), the API tests of those features (the
files of `tests/api` that cover them), the run infrastructure (snapshot, run-setup, non-interference), the smoke suite
(default config) and the two developers' blocks (devblock config). The secondary flow is everything else on top: the
extension rows of the other areas (certificate filters, sorting and paging, discovery, protocols, keys and tokens,
workflows, compliance, secrets, sign-in) and the remaining API areas. Both live in this folder and run in the same
configs, in area order; a branch that carries only the main flow simply has no spec in the other areas (the sign-out
project then selects nothing).

## Configs, commands and reports

| Suite | Config | Command | Report written to `test-results/` |
|---|---|---|---|
| regression | `playwright.regression.config.ts` | `REG_ENV_FILE=<tier env file> npm run test:regression` | `regression-junit.xml` (HTML in `playwright-report/regression`) |
| API | `playwright.api.config.ts` | `REG_ENV_FILE=<tier env file> npm run test:api` | `api-junit.xml` (HTML in `playwright-report/api`) |
| developers' block | `playwright.devblock.config.ts` | `REG_ENV_FILE=<tier env file> DEV_BLOCK=timestamping \| key-onboarding npx playwright test -c playwright.devblock.config.ts` | `dev-<block>-junit.xml` (HTML in `playwright-report/dev-<block>`) |
| smoke | `playwright.config.ts` | `npm run test:smoke` | `junit.xml` |
| unit | `playwright.unit.config.ts` | `npm run test:unit` | none (line output) |

The file names above are the contract with the Testkube workflows: do not rename a config, a report or a folder. A block
(`DEV_BLOCK`) is `@local` only: on a shared tier it selects nothing and exits 0 with an empty report (add
`--pass-with-no-tests`); see `tests/dev-blocks/README.md`.

## The safety model in short

The suites create, they do not change what they did not create. Five parts hold that, each proven by unit tests:

1. **Create-only.** Read anything; create run-prefixed objects; change or delete only an object the live own-object check
   passed (ledger line of this run plus a live name that carries the run prefix).
2. **Ledger before assertion.** Every create is recorded from the answer of the call, before any assertion or other wait.
3. **Guard.** Every context a spec uses is the deny-by-default guard; a request that names an object that is not this run's
   never leaves the machine.
4. **Teardown.** The run-end deletion of the run's own objects, each proven gone by a read-back.
5. **Non-interference.** A before and after snapshot proves that no pre-existing object changed.

**Where the spec lint applies.** `tests/unit/specGuards.spec.ts` lints every file under `tests/regression` and `tests/api`
(spec rules), under `fixtures/areas` (spec rules) and under `utils/regression` and `utils/api` (helper rules; the rule table is
`utils/regression/specLint/rules.ts`, the rule list in `rawMutations.ts`). It refuses raw contexts (also a page object's
`page.request` used for anything but a GET), unguarded mutations, credential-carrying response state (`allHeaders()`,
`storageState()`, a header map read outside a header assertion), env and file-system writes, imports outside the allow-list,
sleeps and titles that break the title rules. A source file cited with a line number is refused in the specs, `pages`,
`fixtures` and the helpers. The developers' blocks
(`tests/timestamping`, `tests/key-onboarding`, `utils/timestamping`, `utils/keyOnboarding`, `utils/devBlocks`) are not
scanned, by agreement: their own README says why, and they keep their own references.

## Running the suites locally

Install once with `npm ci`. None of the scripts names a tier: the smoke suite reads `.env` in the repository folder, and
the regression and API suites read the env file named by `REG_ENV_FILE` (or that `.env` when it is not set; a named file
that does not exist stops the run). `.env.example` lists the variables.

| Command | Runs |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:unit` | the unit tests; no environment, no network beyond loopback |
| `npm run test:unit:quick` | the unit tests without the `@integration` ones (those start a child Playwright run or a throw-away core) |
| `npm run test:smoke` | the smoke suite against `.env` — a dedicated or local deployment only, never a shared tier |
| `REG_ENV_FILE=<tier env file> npm run test:regression` | the regression suite |
| `REG_ENV_FILE=<tier env file> npm run test:api` | the API suite (gate, P1, the rest) |
| `npm run visual:baseline` / `npm run visual:compare` | the visual baselines against `VISUAL_BASE_URL` |

Useful variations (`-c playwright.regression.config.ts` or `-c playwright.api.config.ts`):

```bash
# one checklist item and its sub-rows (--grep is a regular expression, so @REG-USE-05 also selects @REG-USE-05.1)
npx playwright test -c playwright.regression.config.ts --grep @REG-USE-05
# exactly one id, without its sub-ids
npx playwright test -c playwright.regression.config.ts --grep "@REG-USE-05(?![\w.-])"
# one file
npx playwright test -c playwright.regression.config.ts 12-main-usage/05-issue-with-an-acme-client
# the migration gate first, as a pipeline does (stop on a non-zero exit)
npx playwright test -c playwright.api.config.ts --project=gate
# reuse an earlier run's objects while debugging one spec (a hand-set id keeps its objects at the end)
REG_RUN_ID=<earlier run id> npx playwright test -c playwright.regression.config.ts --grep @REG-USE-04
# what the teardown would delete for a run id, without deleting or sending anything
REG_RUN_ID=<run id> API_TEARDOWN_DRY_RUN=1 npx playwright test -c playwright.regression.config.ts --grep @no-such-tag --pass-with-no-tests
# delete what a kept run left behind (dry run first); the snapshot project gives the check its before snapshot
REG_RUN_ID=<run id> API_DELETE_OWN=1 npx playwright test -c playwright.regression.config.ts --project=snapshot
# the HTML report (a screenshot per test)
npx playwright show-report playwright-report/regression
```

Notes:

- Both suites run on **one worker** in file order (`--workers` above 1 is refused): runs chain objects through the run
  state, and the ledger and the snapshot assume one writer. A spec run alone creates its prerequisites through the API.
- `--no-deps` skips the snapshot, so on a shared tier the teardown ends red: without a before snapshot there is no proof.
- **Keep the evidence first.** Playwright empties `test-results/<config>/` at the start of the next run of that config.
  Copy it (and `playwright-report/<config>`) somewhere outside the repository before you start another run. Evidence
  can show tier data (names, URLs, response text): check it before you share any of it.
- The usual variables: `REG_ENV_FILE`, `REG_RUN_ID` / `REG_RUN_ID_REUSE`, `TIER_KIND` (with `REG_LOCAL_CORE_URL`),
  `API_DELETE_OWN` / `API_TEARDOWN_DRY_RUN`, `REG_NET_TOLERANCE`, `REG_CA_CONNECTORS` (the CA order of the run RA
  profile), `REG_REQUIRED_CONNECTORS` / `REG_BLOCKED_CONNECTORS`, `REG_GATE_CONNECTOR`, `REG_EXPECTED_CORE_VERSION` /
  `REG_EXPECTED_FE_VERSION`, and `REG_RESTRICTED_USERNAME` / `REG_RESTRICTED_PASSWORD` for the dedicated second test
  account (the rows that need it skip without it).

## How a run is ordered

Projects of the regression config (`utils/regression/regressionProjects.ts`):

1. `snapshot`: the guard proof, then the before snapshot;
2. `run-setup`: the run objects the later specs build on (the MS ADCS authority, the RA profile on the first healthy CA, the ACME
   profile, the role and the token chain), made once through the API (`tests/api/run-objects.setup.ts`, `utils/regression/run/runObjects.ts`).
   A tier that cannot offer one skips its row with the named reason and never fails (Playwright does not start `regression` when a test of
   its dependency failed). It is infrastructure: `REG_PHASE=B` keeps it. A run with `--no-deps`, or a `--grep` that leaves it out, still gets
   each object when the spec that needs it calls its `ensure…` helper;
3. `regression`: every REG spec except the sign-out spec and the setup file;
4. `logout`: `01-sign-in-and-access/99-sign-out.spec.ts`, the teardown project of `regression` (it ends the shared admin's sign-in, so it
   runs after every other row, failed or not);
5. `non-interference`: the teardown project of `snapshot`;
6. the run-end teardown.

The developers' blocks (`@dev-tests`: timestamping, key onboarding) are not part of this config: each has its own run and report
(`playwright.devblock.config.ts`, `tests/dev-blocks/README.md`).

The UI specs of the configuration area (`03-configuration`) create and keep objects of their own; none of them becomes a run object.

The API config uses the same frame: `snapshot` → `gate` (API-GEN-32, `@gate`) → `api-p1` (`@p1`, runs even when the
gate is red, to explain it) and `api-rest` (`@p2` / `@p3`, skipped when the gate fails) → `non-interference` → teardown.
The API config does not depend on `run-setup`: its `api-p1` rows must run when the gate is red, so they keep the lazy `ensure…` calls, which read
the same run-state file. A Playwright dependency cannot cross two configs, so a pipeline runs the gate first and stops on a non-zero exit.

## Specs

Every test carries `testMeta({ id, prio, issue, rule })` (`utils/regression/tags.ts`): its id (also a tag, `@REG-USE-05`), a
priority tag (`@p1`, `@p2`, `@p3`), the issues it covers and the rule it asserts. The release checklist items:

| Spec | Checklist item |
|---|---|
| `07-deployment/01-post-install-check.spec.ts` | Deployment 1: versions, anonymous health bodies, the `/info` contract, required connectors alive (`REG_BLOCKED_CONNECTORS=name:reason` skips one with the named blocker) |
| `07-deployment/02-upgrade-keeps-objects-and-connectors.spec.ts` | Deployment 2: upgrade on a local tier; objects and connectors survive it |
| `03-configuration/01-credential.spec.ts` | Configuration 1: basic credential, duplicate name refused |
| `03-configuration/02-microsoft-adcs-authority.spec.ts` | Configuration 2: MS ADCS authority (skips with the named blocker when the connector's live health fails) |
| `03-configuration/03-ra-profile.spec.ts` | Configuration 3: RA profile on MS ADCS, created disabled, then enabled |
| `03-configuration/04-acme-profile.spec.ts` | Configuration 4: ACME profile with a pre-authorised DNS identifier |
| `03-configuration/05-acme-on-ra-profile.spec.ts` | Configuration 5: ACME activated on an own RA profile |
| `03-configuration/06-group.spec.ts` | Configuration 6: certificate group, duplicate name refused |
| `03-configuration/07-role.spec.ts` | Configuration 7: role: duplicate name, edit, delete |
| `03-configuration/08-role-permissions.spec.ts` | Configuration 8: role permissions |
| `03-configuration/09-user-with-role.spec.ts` | Configuration 9: user with the role: edit, delete |
| `12-main-usage/01-dashboard.spec.ts` | Usage 1: dashboard tiles, charts, legend drill-down |
| `12-main-usage/02-filter-inventory-by-common-name.spec.ts` | Usage 2: inventory filter, detail, clear filter |
| `12-main-usage/03-import-certificate.spec.ts` | Usage 3: import PEM, "already in inventory", PKCS#12 password, CSR refused |
| `12-main-usage/04-issue-in-the-ui-with-an-external-csr.spec.ts` | Usage 4: issue in the UI with an external CSR; SANs, details, history |
| `12-main-usage/05-issue-with-an-acme-client.spec.ts` | Usage 5: ACME (the RFC 8555 client in `utils/regression/protocols/acmeClient.ts`) |
| `12-main-usage/06-issue-with-cert-manager.spec.ts` | Usage 6: cert-manager issuer (skips without a cluster and the namespaced permissions) |
| `12-main-usage/07-issue-through-the-api.spec.ts` | Usage 7: issue through the v2 operations API; response contract, history, download |

Spec files sit in numbered area folders: `tests/regression/<NN-area>/<NN-behaviour>.spec.ts` for the regression suite and
`tests/api/<NN-area>/<behaviour>.api.spec.ts` for the API suite. The numbers keep the run order (Playwright runs the
files of a project in path order). The ids stay inside the files; the id families are `AUTH` (sign-in, sessions, restricted user, sign-out), `CERT`
(certificate lifecycle and the certificate list), `COMP`, `CONN`, `CORE`, `KEY`, `PROT` (ACME, SCEP, CMP), `SEC`,
`DISC` (discovery), `WFL` (workflows and notifications), `RUN` (the run-setup project). Rows that need something a tier may not have declare it
in `testMeta({ needs })` (one value of the `Needs` catalogue in `utils/regression/tags.ts`, written as the tag `@needs:<x>`) and skip with the named
deploy gate, never pass.

### Fixtures of a spec

`fixtures/regressionFixtures.ts` extends the smoke-sized `fixtures/testFixtures.ts` (`api`, `anonymousApi`, `adminToken`, `restrictedToken`,
`ownRaProfile`) with the fixtures a spec needs for the safety steps. A spec that takes none of them is unchanged.

| Fixture | What it gives | Example |
|---|---|---|
| `needs` | resolves what the test needs from reads and skips with the named reason of the first unmet need; the needs declared in `testMeta({ needs })` are resolved before any `own` or page call | `await needs.require('ca', 'second-identity')`, or `await needs.ca()` |
| `own` | creators and ledger steps bound to the test's ledger id (`createOwn<Thing>` helpers); `record` writes the ledger line of a UI create from the form's answer, `recordNamed` the by-name line, `deleted` the deleted line | `const ref = own.record('groups', await groupsPage.submitCreate(), { note: 'created in the dialog' })` |
| `live` | runs the live own-object check and returns the `LiveOwn` handle that page actions on own objects take (nothing else builds one; `as LiveOwn` is refused by the lint) | `const role = await live('roles', ref)` |
| `signedIn` | the admin page after the sign-in (the sign-in and sign-out specs keep their explicit logins) | `await signedIn.goto('administrator/#/roles')` |
| `regressionEnv` | the typed reader of the `REG_*` / `API_*` settings | `regressionEnv.caConnectors` |
| `localApi` | the guarded API of a `@local` row on a proven local stack (the guard's `localStack` option); it throws for any other test | `await localApi.post('/api/v1/…', …)` inside `describeLocalOnly` |

The `needs` fixture (and the needs declared in `testMeta`) is resolved when the test's fixtures are set up, before the test and its `beforeEach` hooks but not before `beforeAll`: a create made in `beforeAll` happens before any need is checked, so creates belong in the test or in a fixture.

Every fixture name is registered in the spec lint (`utils/regression/specLint/rules.ts`, `bindings.ts`), so `test.use({ … })` cannot replace
one and a mutation through `localApi` is judged like one through `api`.

**Known failures** are marked with `test.fail()` and `testMeta({ bug })` right before the failing step. They pass while the
bug exists and turn red ("expected to fail, but passed") once it is fixed; remove the marker then.

## Events and discovery rows

- Conditions, rules, actions, triggers, notification instances / profiles and discoveries are own objects like any other.
  An event association is recorded before it is sent and cleared by the teardown on an own scope. Nothing is associated at
  platform level on a shared tier: those rows are `@local`.
- Discovery targets are only the run's own TLS target or the documentation ranges of RFC 5737; the certificates a run
  onboards are `derived` lines and deleted by uuid.
- Delivery is asserted only in a local notification setup; on a shared tier the rows use internal-only profiles or
  check the stored state.
- A row that asserts an exact firing reads the platform event settings first and skips with a named reason when a
  platform-level trigger already listens on its events.

## Glossary

- **Tier**: one ILM installation the suites run against (`BASE_URL`); shared by default, local only with proof (see Tier).
- **Own object**: an object this run created and recorded in the ledger; the only kind a test may change or delete.
- **Ledger**: the append-only file of `created` / `deleted` lines per run (`ledger/ledger.ts`); ownership is read from it.
- **Guard**: the request context every REG / API test uses (`guard/createGuard.ts`); it refuses a change to an object
  that is not this run's before the request leaves.
- **Teardown**: the run-end deletion of the run's own objects, newest first, each proven gone (`teardown/runTeardown.ts`).
- **Non-interference**: the before / after comparison of objects that are not this run's; they must be unchanged.
- **Module layout without re-exports**: every helper is imported from the file that defines it; there are no index or
  re-export files (barrels), with the one exception named under Layout.
- **`testMeta()`**: the details of one test (ledger id, priority, issue, optional table row and rules); it adds the tags.
- **`…Wire` unit files** (`lifecycleWire`, `platformWire`, `rbacWire` …): helpers sent through the real guard to a fake
  core on loopback (127.0.0.1), so the requests on the wire are checked without an environment.
- **`…StandIn` unit files** and the page-object units: page objects run against stand-in documents loaded with
  `page.setContent` (or served on loopback), shaped like the admin UI.
- **`pkiBuilders`**: the one module that builds keys, CSRs and certificates and their encodings for every flow.
- **`seedMinimal`** / **`seedFull`**: the three-certificate seed of the migration checks, and the 24-certificate seed of the
  inventory filter, sort and paging rows.
- **`uiWidget`**: the unit file of `pages/ui/widget.ts` (an admin UI `<section>` with a title and its icon buttons).
- **`lifecycle/rawAnswers`**: one guarded request whose answer is read without throwing, and the readers of its error body.
- **`FormDialog`**: a create / edit dialog of the admin UI (text inputs, submit, cancel), used by the role and user pages.
- **`platform.spec` / `protocols.spec`**: the unit files of the pure parts of the `platform/` and `protocols/` helpers
  (no server, no browser); their wire halves are `platformWire` and `protocolsWire`.

## Layout

- `playwright.regression.config.ts`, `playwright.api.config.ts`: `prepareRun`, the projects, the run-end teardown;
  shared blocks in `utils/regression/configBase.ts`, project tables in `utils/regression/regressionProjects.ts`, tier
  rules in `utils/regression/projectFilters.ts`.
- `utils/regression/run/`: `prepareRun.ts` (`prepareRun`: env file, frozen variables, run id, tier checks, one worker,
  run lock), `runId.ts` (run id, state directory, run lock), `flags.ts` (the switch parser and the dry-run check).
- `utils/regression/tier/`: `kind.ts` (TIER_KIND, the frozen variables, the tier identity), `dns.ts` (which hosts count
  as local), `docker.ts` (the container and daemon readers), `localProof.ts` (the local-backend proof, `describeLocalOnly`).
- `utils/regression/ledger/`: `ledger.ts` (ledger lines and the references they hand out), `uiCreates.ts` (the ledger line of a UI create, from its answer), `runState.ts` (`runId()`,
  `runName`, the run state file), `ownership.ts` (`checkOwnership`, `assertOwn`, `assertOwnLive`).
- `utils/regression/guard/`: the guard. `createGuard.ts` (read the request once, check it, send exactly what was
  checked), `types.ts` (`GuardedApi`, `assertGuarded`), `uuids.ts`, `urls.ts`, `allowLists.ts`, `targets.ts`,
  `bodies.ts`, `headers.ts`, `rawPost.ts` (`allowedRawPost`) and `routes.ts` (the route tables the guard reads);
  `utils/regression/guardProofSpy.ts` is the spy of the guard proof.
- `utils/regression/teardown/`: `runTeardown.ts` and `teardownHandlers.ts` (the run-end deletion), `nonInterference.ts`
  (the snapshot and the comparison).
- `utils/regression/tags.ts` (`testMeta()`, the tag builders), `specLint/` (`parseSpec.ts`: test blocks and tag rules;
  `rawMutations.ts`: the deny-by-default lint), `publicText.ts`, `coreBuild.ts` (the core build marker),
  `requireTool.ts` (external tools, the one docker binary reader), `needs.ts` (the resolver of each `Needs` value), `ownObjects.ts` (what the `own` fixture
  offers), `ledger/liveOwn.ts` (the `LiveOwn` handle), `run/runObjects.ts` (the objects of the `run-setup` project).
- The area helpers (`lifecycle/`, `platform/`, `protocols/`, `events/`, `discovery/`, `rbac/`, `inventory/`,
  `config/`) and the page objects in `pages/` (shared UI parts in `pages/ui/`: select, toolbar, toast, widget, form,
  list, table). Every module is imported from the file that defines it (the one re-export, `utils/regression/tier.ts`, serves the
  smoke suite's `utils/env.ts`, which never changes).
