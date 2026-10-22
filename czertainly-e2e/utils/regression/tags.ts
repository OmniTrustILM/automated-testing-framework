/**
 * tags — the one place where the regression and API tags are spelled.
 *
 * A test's details are one call: `test('<expected behaviour>', testMeta({ id: 'API-GEN-33', prio: 'P1', issue: 'ilm#428' }), …)`.
 * The suite tag (`@regression` / `@api`) goes on the describe, by folder. Rules the builders enforce:
 * - every test carries `@issue:ilm#448` (the registered QA task) plus the #424 sub-issue of its area;
 * - every test carries one priority tag `@p1` / `@p2` / `@p3` (the nightly selects `@p1`, the `api-rest` project
 *   `@p2|@p3`); a characterisation pin (`@pin:<question>`) is never P1;
 * - `@gate` is API-GEN-32 only;
 * - `@local` also needs `describeLocalOnly(test)` in the spec;
 * - `@needs:<x>` names one thing a row cannot run without (`Needs`, the one catalogue below). A spec that takes the
 *   `needs` fixture of fixtures/regressionFixtures.ts gets every declared need resolved from READS before it creates
 *   anything; an unmet need skips the test with the named reason;
 * - `testMeta()` also tags the test with its id (`@REG-USE-05`) and may name a table row (`row`, an annotation).
 *   `--grep` is a regular expression, so `--grep @REG-USE-05` selects the id AND its sub-ids (`@REG-USE-05.1`): use it
 *   for a whole checklist item; `--grep "@REG-USE-05(?![\w.-])"` selects exactly that id;
 * - `@bug:<repo>#<n>` only on a test that calls `test.fail()` (the rule is asserted, and the test turns red once the
 *   bug is fixed). `bugTagsWithoutFail()` (specLint/parseSpec.ts) finds violations in a spec's source; specGuards runs it
 *   over every spec.
 */

export type Prio = 'P1' | 'P2' | 'P3';

/**
 * What a row may need from the tier or the runner, the one catalogue of the `@needs:<x>` tags (`needs` in `testMeta`).
 * Runner tools: `openssl`, `sscep`, `docker`, `cluster` (kubectl and a reachable cluster). Local-stack services: `keycloak-local`,
 * `smtp-catcher`, `webhook-receiver`. Connectors and identities the tier must offer: `ca` (a healthy certificate authority
 * with an enabled RA profile to copy), `ejbca-ng`, `pkcs11`, `v1-discovery`, `v2-discovery`, `email-provider`,
 * `webhook-provider`, `second-identity`, `crypto-v2` (a connected software cryptography connector of interface v2). A runner-hosted
 * TLS listener: `scan-target`. A connector that must be online: `connector-online`. Tier settings and data the rows read first:
 * `platform-triggers-free` (no platform-level trigger on the events the row watches), `metadata-field` (the certificate filter
 * catalogue offers a metadata field), `registration-settings` (the platform settings can hold a challenge-protected registration),
 * `required-attributes-fillable` (every required custom attribute the suite creates objects with is one it can fill), `scep-https`
 * (the SCEP URL is not https: classic sscep speaks plain HTTP), `bearer-token` (the admin identity signs in with a bearer token:
 * not a header-mode stack) and `openapi-document` (REG_OPENAPI_FILE names a readable OpenAPI document).
 */
export const NEEDS = [
    'ca', 'ejbca-ng', 'pkcs11', 'second-identity', 'keycloak-local', 'v1-discovery', 'v2-discovery', 'email-provider', 'webhook-provider',
    'smtp-catcher', 'webhook-receiver', 'scan-target', 'connector-online', 'openssl', 'sscep', 'docker', 'cluster',
    'crypto-v2', 'platform-triggers-free', 'metadata-field', 'scep-https', 'registration-settings', 'required-attributes-fillable',
    'bearer-token', 'openapi-document', 'utils-service',
] as const;

/** One need of a row (a value of `NEEDS`). */
export type Needs = (typeof NEEDS)[number];

const isNeed = (what: string): what is Needs => (NEEDS as readonly string[]).includes(what);

/** The QA task every ilm#424 regression row is registered under. */
export const REGISTERED_ISSUE = 'ilm#448';

const ISSUE_REF = /^[a-z][a-z0-9-]*#\d+$/;
const TEST_ID = /^(REG|API)-[A-Z]+-\d{2}(\.[0-9a-z]+)?$/;

function checkRef(kind: string, ref: string): string {
    if (!ISSUE_REF.test(ref)) throw new Error(`tags.${kind}: "${ref}" is not <repo>#<number> (e.g. core#2502)`);
    return ref;
}

export const tags = {
    regression: '@regression',
    api: '@api',
    gate: '@gate',
    phaseB: '@phaseB',
    local: '@local',
    /** A row that takes minutes by design (a discovery over a real target, a long poll). */
    slow: '@slow',
    issue: (ref: string): string => `@issue:${checkRef('issue', ref)}`,
    prio: (prio: Prio): string => {
        if (!/^P[123]$/.test(prio)) throw new Error(`tags.prio: "${prio}" is not P1, P2 or P3`);
        return `@p${prio.slice(1)}`;
    },
    pin: (question: string): string => {
        if (!/^[A-Za-z0-9._-]+$/.test(question)) throw new Error(`tags.pin: "${question}" is not a question id`);
        return `@pin:${question}`;
    },
    needs: (what: Needs): string => {
        if (!isNeed(what)) throw new Error(`tags.needs: "${what}" is not one of ${NEEDS.join(', ')}`);
        return `@needs:${what}`;
    },
    bug: (ref: string): string => `@bug:${checkRef('bug', ref)}`,
};

export interface Meta {
    /** Ledger id, e.g. API-GEN-33 or REG-CFG-07.a (the title starts with it). */
    id: string;
    prio: Prio;
    /** The #424 sub-issue(s) of the area, e.g. 'ilm#428'; ilm#448 is always added. */
    issue: string | string[];
    pin?: string;
    /** Known product bug(s): the test must also call test.fail(). */
    bug?: string | string[];
    /** What the row cannot run without (see `Needs`); the `needs` fixture skips the test with a named reason when one is unmet. */
    needs?: Needs | Needs[];
    local?: boolean;
    gate?: boolean;
    phaseB?: boolean;
    /** The row takes minutes by design (`@slow`). */
    slow?: boolean;
    /**
     * The business rule(s) the oracle comes from (the ticket / rules reference, e.g. `RaProfileServiceImpl
     * unreserved-name check, core#743`): one `rule` annotation each, so a report shows why the
     * test expects what it expects (assertions come from the AC of the ticket that built the feature).
     */
    rule?: string | string[];
    /**
     * The row key of a test that covers one row of a table (`REG-CERT-41` row `T-3`, a key family, a variant): one
     * `row` annotation, so the title can spell the variant in words and the census still keys the test by (id, row).
     */
    row?: string;
}

/** The tag `testMeta()` adds for its id (`@REG-USE-05`); `--grep` finds a test by it once titles lose the id (exact form: header). */
export const idTag = (id: string): string => `@${id}`;

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Playwright test details `{ tag, annotation }` for one ledger row. */
export function testMeta(m: Meta): { tag: string[]; annotation: Array<{ type: string; description: string }> } {
    if (!TEST_ID.test(m.id)) throw new Error(`testMeta: "${m.id}" is not a ledger id (REG-<MOD>-NN[.x] or API-<MOD>-NN[.x])`);
    if (m.pin && m.prio === 'P1') throw new Error(`testMeta(${m.id}): a characterisation pin is never P1`);
    if (m.gate && m.id !== 'API-GEN-32') throw new Error(`testMeta(${m.id}): @gate belongs to API-GEN-32 only`);
    const issues = [...new Set([REGISTERED_ISSUE, ...list(m.issue)])];
    if (issues.length < 2) throw new Error(`testMeta(${m.id}): name the #424 sub-issue of the area next to ${REGISTERED_ISSUE}`);
    const tag = [
        ...issues.map(tags.issue),
        tags.prio(m.prio),
        ...(m.gate ? [tags.gate] : []),
        ...(m.phaseB ? [tags.phaseB] : []),
        ...(m.local ? [tags.local] : []),
        ...(m.slow ? [tags.slow] : []),
        ...(m.pin ? [tags.pin(m.pin)] : []),
        ...list(m.needs).map(tags.needs),
        ...list(m.bug).map(tags.bug),
        idTag(m.id),
    ];
    if (m.row !== undefined && !/^\S(.*\S)?$/.test(m.row)) throw new Error(`testMeta(${m.id}): row "${m.row}" is empty or has outer spaces`);
    return {
        tag,
        annotation: [
            { type: 'ledger-id', description: m.id },
            ...(m.row !== undefined ? [{ type: 'row', description: m.row }] : []),
            ...list(m.rule).map((description) => ({ type: 'rule', description })),
        ],
    };
}
