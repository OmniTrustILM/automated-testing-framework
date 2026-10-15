/**
 * inventorySeed — inventory seeds the run owns, with an exact manifest (Phase 3 §7: exact row-set oracles only over the
 * run's own seeds, filtered to them; property oracles may read everything else).
 *
 * B1 builds the 3-certificate SUBSET of the API-GEN-32 null-last sentinel (phase-05 B1.2); SEED-A / B / C (24
 * certificates, groups, custom attributes) arrive in B2 / B3 on the same manifest pattern.
 *
 * The subset (inventory-api rules §2.2 r22: "objects without a value sort last in both directions"; core#2394):
 *   a: owner = the run's seed user, custom attribute value 2
 *   b: owner = the run's seed user, NO custom attribute value
 *   c: NO owner,                    custom attribute value 1
 * so sorting the subset by OWNER puts c last in both directions and sorting it by the custom attribute puts b last in
 * both directions, with a (2) and c (1) ordered by value. The certificates are self-signed RSA uploads (no CA needed),
 * the custom attribute is the run's own, NOT required (Phase 3 §7: a required one would break other users' forms), and
 * the owner is the run's own user, created DISABLED (it cannot sign in). Every object is recorded in the ledger right
 * after its create call, before any assertion (phase-05 §6.1 rule 10), and removed by the run-end teardown; the key the
 * platform links to each uploaded certificate is recorded as derived with a server-clock `createdAfter`.
 *
 * Idempotent per run: the manifest is kept in RunState.inventorySeed.b1Subset and reused while all its objects are
 * still this run's. `planSeedSubset`, `nullRows`, `manifestValue`, `seedFilter` and `manifestProblems` are pure
 * (tests/unit/inventorySeed.spec.ts).
 */
import { Logger } from '../Logger';
import { GuardedApi } from './guardedApi';
import { ownership } from './ownObjects';
import { selfSignedPem } from './pki';
import { apiJson, apiJsonWithDate, createdAfterOf, createUser, recordDerivedKeyOrNamed, requiredCustomAttributes } from './regressionApi';
import { readState, recordCreated, regName, RUN_ID, updateState } from './regressionRun';

const logger = new Logger('InventorySeed');

type Json = Record<string, any>;

export type SeedKey = 'a' | 'b' | 'c';
export type SeedField = 'owner' | 'rank';

export interface SeedCertificatePlan {
    key: SeedKey;
    commonName: string;
    /** Owned by the seed user. */
    owner: boolean;
    /** Value of the seed custom attribute (integer), or null for none. */
    rank: number | null;
}

export interface SeedSubsetPlan {
    kind: 'b1-null-last-subset';
    /** Common-name prefix shared by the subset's certificates and by nothing else (the isolation filter). */
    prefix: string;
    attribute: { name: string; label: string; contentType: 'integer' };
    owner: { username: string };
    certificates: SeedCertificatePlan[];
}

export interface SeedSubsetManifest extends SeedSubsetPlan {
    runId: string;
    attributeUuid: string;
    ownerUuid: string;
    certificates: Array<SeedCertificatePlan & { uuid: string }>;
}

/**
 * The subset's names and values (pure). `stamp` makes the prefix unique per build, so a second build in the same run
 * (state lost) never mixes with the first under the isolation filter.
 */
export function planSeedSubset(name: (suffix: string) => string = regName, stamp: string = Date.now().toString(36)): SeedSubsetPlan {
    const prefix = name(`seed-${stamp}-`);
    return {
        kind: 'b1-null-last-subset',
        prefix,
        attribute: { name: name(`seed-${stamp}-rank`), label: `Seed rank ${stamp}`, contentType: 'integer' },
        owner: { username: name(`seed-${stamp}-owner`) },
        certificates: [
            { key: 'a', commonName: `${prefix}a`, owner: true, rank: 2 },
            { key: 'b', commonName: `${prefix}b`, owner: true, rank: null },
            { key: 'c', commonName: `${prefix}c`, owner: false, rank: 1 },
        ],
    };
}

/** What a manifest says about one of its certificates: the owner's username or the rank, null when it has none. */
export function manifestValue(m: SeedSubsetManifest, uuid: string, field: SeedField): string | number | null | undefined {
    const c = m.certificates.find((x) => x.uuid === uuid);
    if (!c) return undefined;
    return field === 'owner' ? (c.owner ? m.owner.username : null) : c.rank;
}

/** The uuids of the subset's certificates WITHOUT a value for the field (the rows that must sort last). */
export function nullRows(m: SeedSubsetManifest, field: SeedField): string[] {
    return m.certificates.filter((c) => (field === 'owner' ? !c.owner : c.rank === null)).map((c) => c.uuid);
}

/** The isolation filter of the subset: certificates whose common name starts with the subset prefix. */
export function seedFilter(m: Pick<SeedSubsetPlan, 'prefix'>): Json[] {
    return [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: m.prefix }];
}

/** Why a manifest is not a usable subset (empty = usable): 3 distinct certificates under the prefix, one null per field. */
export function manifestProblems(m: SeedSubsetManifest, runId: string = RUN_ID): string[] {
    const problems: string[] = [];
    if (m.kind !== 'b1-null-last-subset') problems.push(`kind ${String(m.kind)}`);
    if (m.runId !== runId) problems.push('the manifest belongs to another run');
    if (!m.prefix.startsWith(`${runId}-`)) problems.push('the prefix does not carry the run prefix');
    if (m.certificates.length !== 3) problems.push(`${m.certificates.length} certificates (3 expected)`);
    if (new Set(m.certificates.map((c) => c.uuid)).size !== m.certificates.length) problems.push('duplicate certificate uuids');
    if (!m.certificates.every((c) => c.commonName.startsWith(m.prefix))) problems.push('a certificate outside the prefix');
    if (nullRows(m, 'owner').length !== 1) problems.push(`${nullRows(m, 'owner').length} certificates without an owner (1 expected)`);
    if (nullRows(m, 'rank').length !== 1) problems.push(`${nullRows(m, 'rank').length} certificates without a rank (1 expected)`);
    const ranks = m.certificates.map((c) => c.rank).filter((r): r is number => r !== null);
    if (new Set(ranks).size !== ranks.length) problems.push('equal ranks (the value order would be a tie)');
    return problems;
}

const stillOwn = (m: SeedSubsetManifest): boolean =>
    [m.attributeUuid, m.ownerUuid, ...m.certificates.map((c) => c.uuid)].every((uuid) => ownership({ uuid }).own);

/**
 * Builds the subset through the guarded API (or returns this run's earlier one): own custom attribute (integer, not
 * required, resource certificates), own disabled user, three self-signed uploads (with the attribute value where the
 * plan has one), then the owner on a and b (`PATCH /v1/certificates/{own}` with `ownerUuid` = the own user: the guard
 * types that field as users). Ledger before assertion for every object.
 */
export async function buildSeedSubset(api: GuardedApi, spec: string, plan: SeedSubsetPlan = planSeedSubset()): Promise<SeedSubsetManifest> {
    const earlier = readState().inventorySeed?.b1Subset as SeedSubsetManifest | undefined;
    if (earlier && earlier.runId === RUN_ID && !manifestProblems(earlier).length && stillOwn(earlier)) return earlier;

    const attr = await apiJson<Json>(api, 'POST', '/api/v1/attributes/custom', {
        name: plan.attribute.name,
        label: plan.attribute.label,
        description: `REG run ${RUN_ID}: API-GEN-32 null-last seed`,
        contentType: plan.attribute.contentType,
        required: false,
        visible: true,
        readOnly: false,
        list: false,
        multiSelect: false,
        resources: ['certificates'],
    });
    recordCreated('customAttributes', { uuid: attr.uuid, name: plan.attribute.name }, spec, 'seed custom attribute (not required)');

    const owner = recordCreated('users', await createUser(api, plan.owner.username, { enabled: false }), spec, 'seed owner (disabled)');

    const required = await requiredCustomAttributes(api, 'certificates', regName('ca'));
    const certificates: SeedSubsetManifest['certificates'] = [];
    for (const c of plan.certificates) {
        const { pem } = selfSignedPem(c.commonName);
        const customAttributes = [
            ...required,
            ...(c.rank === null ? [] : [{ uuid: attr.uuid, name: plan.attribute.name, contentType: plan.attribute.contentType, content: [{ data: c.rank }] }]),
        ];
        const answer = await apiJsonWithDate<Json>(api, 'POST', '/api/v1/certificates/upload', {
            certificate: Buffer.from(pem).toString('base64'),
            customAttributes,
        });
        const { body } = answer;
        recordCreated('certificates', { uuid: body.uuid, name: c.commonName }, spec, `seed ${c.key} (self-signed upload)`);
        certificates.push({ ...c, uuid: body.uuid });
        await recordDerivedKeyOrNamed(api, body.uuid, c.commonName, createdAfterOf(answer, 'seed upload'), spec, `seed ${c.key}`);
    }
    for (const c of certificates.filter((x) => x.owner)) {
        await apiJson(api, 'PATCH', `/api/v1/certificates/${c.uuid}`, { ownerUuid: owner.uuid });
    }

    const manifest: SeedSubsetManifest = { ...plan, runId: RUN_ID, attributeUuid: attr.uuid, ownerUuid: owner.uuid, certificates };
    updateState({ inventorySeed: { ...(readState().inventorySeed ?? {}), b1Subset: manifest } });
    logger.info(`seed subset built: ${certificates.length} certificates under the run prefix`);
    return manifest;
}
