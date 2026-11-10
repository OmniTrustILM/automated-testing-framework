# czertainly-e2e

Playwright / TypeScript suites for the CZERTAINLY (ILM) platform. This page is the map; the safety model and every
run switch are in [tests/regression/README.md](tests/regression/README.md).

## Folders

| Folder | Holds |
|---|---|
| `tests/regression/<NN-area>/` | the regression suite (`REG-*`): the release-checklist flows and the certificate lifecycle tests (main flow, with the API tests of those features, the run infrastructure, the smoke suite and the developers' blocks) and the extension rows of every other area (secondary flow) |
| `tests/api/<NN-area>/` | the API suite (`API-*`), plus the run infrastructure at its root: `tier-snapshot.setup.ts`, `tier-non-interference.api.spec.ts`, `run-objects.setup.ts` |
| `tests/timestamping`, `tests/key-onboarding` | the developers' blocks (`@dev-tests`), each with its own config and report (`tests/dev-blocks/README.md`) |
| `tests/smoke` | the smoke suite for a dedicated deployment; not create-only |
| `tests/unit` | tests of the framework itself; no environment |
| `pages/` | page objects (`pages/ui/` holds the shared UI parts) |
| `fixtures/` | the spec-facing fixtures (`api`, `own`, `live`, `needs`, `signedIn` ...) and the per-area fixtures in `fixtures/areas/` |
| `utils/regression/` | the guard, the ledger, the teardown and the helpers of every area |

## Configs, commands and reports

| What | Command | Report in `test-results/` |
|---|---|---|
| regression | `REG_ENV_FILE=<tier env file> npm run test:regression` | `regression-junit.xml` |
| API | `REG_ENV_FILE=<tier env file> npm run test:api` | `api-junit.xml` |
| one developers' block | `REG_ENV_FILE=<tier env file> DEV_BLOCK=timestamping npx playwright test -c playwright.devblock.config.ts` (or `DEV_BLOCK=key-onboarding`) | `dev-<block>-junit.xml` |
| smoke | `npm run test:smoke` (a dedicated deployment only) | `junit.xml` |
| unit | `npm run test:unit`, `npm run typecheck` | none |

Configs: `playwright.regression.config.ts`, `playwright.api.config.ts`, `playwright.devblock.config.ts`,
`playwright.config.ts` (smoke), `playwright.unit.config.ts`, `playwright.visual.config.ts`. The config and report names are
fixed by the Testkube workflows.

## Safety in short

Create-only on shared tiers: a run creates objects named with its run id and changes or deletes only those. The ledger line
of a create is written before any assertion; every context a spec uses is the deny-by-default guard; the run-end teardown
removes the run's objects and proves each one gone; a before and after snapshot proves that nothing else changed. The spec
lint in `tests/unit/specGuards.spec.ts` keeps specs, page objects and helpers inside that model (the developers' blocks
are outside the scan by agreement). Details and the glossary: [tests/regression/README.md](tests/regression/README.md).
