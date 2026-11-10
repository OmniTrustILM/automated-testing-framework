# Developers' test blocks (`@dev-tests`)

Two blocks, each its own run with its own report: `timestamping` (tests/timestamping) and `key-onboarding`
(tests/key-onboarding). They are written by the developers and ported by QA. Both run create-only on a shared tier too:
`timestamping` rows carry `@needs:timestamping` (only the docker-bound and disruptive ones are `@local`: tests/timestamping/SHARED-TIER.md),
`key-onboarding` rows carry `@needs:key-onboarding` and plant their key pairs with `kubectl exec` into the SoftHSM sidecar
(tests/key-onboarding/README.md). They are not part of the regression or the API config.

## Commands

One config, `playwright.devblock.config.ts`; `DEV_BLOCK` picks the block (unset or unknown stops with an error before
anything is listed).

Shared tier. `timestamping` runs the rows without `@local`, `key-onboarding` all its rows (a tier or runner without the components
skips each with a named reason, exit 0; `key-onboarding` needs KO_TOKEN_PIN, the KO_* connector URLs and kubectl with exec rights;
`timestamping` with an ML-DSA family in `TSA_FAMILIES` needs OpenSSL 3.5 or newer on the runner, the Playwright image ships 3.0):

```
REG_ENV_FILE=<tier env file> DEV_BLOCK=timestamping   npx playwright test -c playwright.devblock.config.ts
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
