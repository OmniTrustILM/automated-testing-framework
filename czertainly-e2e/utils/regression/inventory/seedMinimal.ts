/**
 * seedMinimal — the three-certificate seed of the migration checks.
 *
 * Two certificates with the run's owner and one without, two with a custom attribute value and one without, so a sort
 * by owner or by the attribute puts the empty one last in both directions. Own objects only, recorded in the ledger
 * before any assertion; the manifest is reused within a run.
 */
import { Logger } from '../../Logger';
import { GuardedApi } from '../guard/types';
import { checkOwnership } from '../ledger/ownership';
import { selfSignedPem } from '../pkiBuilders';
import { uploadOwnCertificate } from '../ownCertificates';
import { createOwnUser } from '../ownUsers';
import { apiJson } from '../apiReads';
import { requiredCustomAttributes, createOwnCustomAttribute } from '../customAttributes';
import { readRunState, runName, runId, updateRunState } from '../ledger/runState';
import { uniqueSuffix } from '../text';
import type { JsonObject } from '../json';

const logger = new Logger('InventorySeed');

type SeedKey = 'a' | 'b' | 'c';
export type SeedField = 'owner' | 'rank';

interface SeedCertificatePlan {
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
export function planSeedSubset(name: (suffix: string) => string = runName, stamp: string = uniqueSuffix()): SeedSubsetPlan {
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
export function seedFilter(m: Pick<SeedSubsetPlan, 'prefix'>): JsonObject[] {
    return [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: m.prefix }];
}

/** Why a manifest is not a usable subset (empty = usable): 3 distinct certificates under the prefix, one null per field. */
export function manifestProblems(m: SeedSubsetManifest, ofRun: string = runId()): string[] {
    const problems: string[] = [];
    if (m.kind !== 'b1-null-last-subset') problems.push(`kind ${String(m.kind)}`);
    if (m.runId !== ofRun) problems.push('the manifest belongs to another run');
    if (!m.prefix.startsWith(`${ofRun}-`)) problems.push('the prefix does not carry the run prefix');
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
    [m.attributeUuid, m.ownerUuid, ...m.certificates.map((c) => c.uuid)].every((uuid) => checkOwnership({ uuid }).own);

/**
 * Builds the subset through the guarded API (or returns this run's earlier one): own custom attribute (integer, not
 * required, resource certificates), own disabled user, three self-signed uploads (with the attribute value where the
 * plan has one), then the owner on a and b (`PATCH /v1/certificates/{own}` with `ownerUuid` = the own user: the guard
 * types that field as users). Ledger before assertion for every object.
 */
export async function buildSeedSubset(api: GuardedApi, spec: string, plan: SeedSubsetPlan = planSeedSubset()): Promise<SeedSubsetManifest> {
    const earlier = readRunState().inventorySeed?.b1Subset as SeedSubsetManifest | undefined;
    if (earlier && earlier.runId === runId() && !manifestProblems(earlier).length && stillOwn(earlier)) return earlier;

    const attr = await createOwnCustomAttribute(api, spec, 'seed', {
        name: plan.attribute.name,
        label: plan.attribute.label,
        description: `REG run ${runId()}: API-GEN-32 null-last seed`,
        contentType: plan.attribute.contentType,
        note: 'seed custom attribute (not required)',
    });

    const owner = await createOwnUser(api, spec, 'seed-owner', { name: plan.owner.username, enabled: false, note: 'seed owner (disabled)' });

    const required = await requiredCustomAttributes(api, 'certificates', runName('ca'));
    const certificates: SeedSubsetManifest['certificates'] = [];
    for (const c of plan.certificates) {
        const { pem } = selfSignedPem(c.commonName);
        const customAttributes = [
            ...required,
            ...(c.rank === null ? [] : [{ uuid: attr.uuid, name: plan.attribute.name, contentType: plan.attribute.contentType, content: [{ data: c.rank }] }]),
        ];
        const uploaded = await uploadOwnCertificate(api, pem, c.commonName, spec, `seed ${c.key} (self-signed upload)`, customAttributes);
        certificates.push({ ...c, uuid: uploaded.uuid });
    }
    for (const c of certificates.filter((x) => x.owner)) {
        await apiJson(api, 'PATCH', `/api/v1/certificates/${c.uuid}`, { ownerUuid: owner.uuid });
    }

    const manifest: SeedSubsetManifest = { ...plan, runId: runId(), attributeUuid: attr.uuid, ownerUuid: owner.uuid, certificates };
    updateRunState({ inventorySeed: { ...(readRunState().inventorySeed ?? {}), b1Subset: manifest } });
    logger.info(`seed subset built: ${certificates.length} certificates under the run prefix`);
    return manifest;
}
