/**
 * tags — the one place where the regression and API tags are spelled; a test's details are one `testMeta({ id, prio, issue })` call.
 * Builders enforce: `@issue:ilm#448` plus the sub-issue of the area, one `@p1|2|3`, `@gate` for API-GEN-32 only, `@local` with
 * `describeLocalOnly`, `@bug` only with `test.fail()`.
 */

export type Prio = 'P1' | 'P2' | 'P3';

/**
 * What a row may need from the tier or the runner (`@needs:<x>`); an unmet need skips the test with the named reason.
 * Groups: runner tools, local-stack services, connectors and identities, a runner TLS
 * listener, tier settings and data, and `timestamping` (utils/timestamping/need.ts).
 */
export const NEEDS = [
    'ca', 'ejbca-ng', 'pkcs11', 'second-identity', 'keycloak-local', 'v1-discovery', 'v2-discovery', 'email-provider', 'webhook-provider',
    'smtp-catcher', 'webhook-receiver', 'scan-target', 'connector-online', 'openssl', 'sscep', 'docker', 'cluster',
    'crypto-v2', 'platform-triggers-free', 'metadata-field', 'scep-https', 'registration-settings', 'required-attributes-fillable',
    'bearer-token', 'openapi-document', 'utils-service', 'crypto-v1', 'vault-connector', 'ejbca-connector', 'adcs-connector', 'timestamping',
] as const;

export type Needs = (typeof NEEDS)[number];

const isNeed = (what: string): what is Needs => (NEEDS as readonly string[]).includes(what);

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
    id: string;
    prio: Prio;
    issue: string | string[];
    pin?: string;
    bug?: string | string[];
    needs?: Needs | Needs[];
    local?: boolean;
    gate?: boolean;
    phaseB?: boolean;
    slow?: boolean;
    /** The business rule(s) the oracle comes from: one `rule` annotation each. */
    rule?: string | string[];
    /** The row key of a test covering one row of a table: one `row` annotation. */
    row?: string;
    /** Why a `test.fixme` row is parked: one `fixme` annotation. */
    parked?: string;
}

/** The tag `testMeta()` adds for its id; `--grep @REG-USE-05(?![\w.-])` selects exactly that id. */
export const idTag = (id: string): string => `@${id}`;

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

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
            ...(m.parked !== undefined ? [{ type: 'fixme', description: m.parked }] : []),
        ],
    };
}
