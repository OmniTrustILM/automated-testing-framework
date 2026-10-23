# Developers' test blocks (`@dev-tests`)

Two blocks, each its own run with its own report: `timestamping` (tests/timestamping) and `key-onboarding`
(tests/key-onboarding). They are written by the developers and ported by QA; every test is `@local`, so on a shared tier
a block selects nothing. They are not part of the regression or the API config.

## Commands

One config, `playwright.devblock.config.ts`; `DEV_BLOCK` picks the block (unset or unknown stops with an error before
anything is listed).

Shared tier (selects nothing, exits 0, still writes the empty report):

```
REG_ENV_FILE=<tier env file> DEV_BLOCK=timestamping   npx playwright test -c playwright.devblock.config.ts --pass-with-no-tests
REG_ENV_FILE=<tier env file> DEV_BLOCK=key-onboarding npx playwright test -c playwright.devblock.config.ts --pass-with-no-tests
```

Local stack (the same proof variables as the regression config: BASE_URL, REG_LOCAL_CORE_URL, AUTH_CLIENT_CERT, ...):

```
REG_ENV_FILE=<local-stack env file> TIER_KIND=local DEV_BLOCK=timestamping   npx playwright test -c playwright.devblock.config.ts
REG_ENV_FILE=<local-stack env file> TIER_KIND=local DEV_BLOCK=key-onboarding npx playwright test -c playwright.devblock.config.ts
```

## Projects

`<block>-proof` (the local-backend proof, `tests/dev-blocks/local-proof.setup.ts`) → `<block>-setup` → `<block>` →
`<block>-teardown` (the setup's teardown project). There is no snapshot, no run-setup and no non-interference check. The
config's global teardown runs the block's own tear-down once more (only this run's ledger lines of the block; it follows
`API_TEARDOWN_DRY_RUN` and `API_DELETE_OWN`) and removes the run's local proof. Each block keeps its own setup and teardown.

## Reports

The four files the Teams card reads (in `test-results/`):

| Block | File |
| --- | --- |
| E2E regression (no `@dev-tests`) | `regression-junit.xml` |
| API | `api-junit.xml` |
| timestamping | `dev-timestamping-junit.xml` |
| key onboarding | `dev-key-onboarding-junit.xml` |

The HTML report of a block is in `playwright-report/dev-<block>`, its artifacts in `test-results/dev-<block>`.
