/**
 * seedMinimal — the three-certificate seed of the sort check: two with a custom attribute value, so a sort puts the empty one last in
 * both directions; own objects only, ledger first, manifest reused within a run.
 */
import { Logger } from '../../Logger';
import { GuardedApi } from '../guard/types';
import { checkOwnership } from '../ledger/ownership';
import { selfSignedPem } from '../pkiBuilders';
import { uploadOwnCertificate } from '../ownCertificates';
import { requiredCustomAttributes, createOwnCustomAttribute } from '../customAttributes';
import { readRunState, runName, runId, updateRunState } from '../ledger/runState';
import { uniqueSuffix } from '../text';
import type { JsonObject } from '../json';

const logger = new Logger('InventorySeed');

type SeedKey = 'a' | 'b' | 'c';

interface SeedCertificatePlan {
    key: SeedKey;
    commonName: string;
    rank: number | null;
}

export interface SeedSubsetPlan {
    kind: 'b1-null-last-subset';
    prefix: string;
    attribute: { name: string; label: string; contentType: 'integer' };
    certificates: SeedCertificatePlan[];
}

export interface SeedSubsetManifest extends SeedSubsetPlan {
    runId: string;
    attributeUuid: string;
    certificates: Array<SeedCertificatePlan & { uuid: string }>;
}

/** The subset's names and values (pure); `stamp` makes the prefix unique per build. */
export function planSeedSubset(name: (suffix: string) => string = runName, stamp: string = uniqueSuffix()): SeedSubsetPlan {
    const prefix = name(`seed-${stamp}-`);
    return {
        kind: 'b1-null-last-subset',
        prefix,
        attribute: { name: name(`seed-${stamp}-rank`), label: `Seed rank ${stamp}`, contentType: 'integer' },
        certificates: [
            { key: 'a', commonName: `${prefix}a`, rank: 2 },
            { key: 'b', commonName: `${prefix}b`, rank: null },
            { key: 'c', commonName: `${prefix}c`, rank: 1 },
        ],
    };
}

export function manifestValue(m: SeedSubsetManifest, uuid: string): number | null | undefined {
    return m.certificates.find((x) => x.uuid === uuid)?.rank;
}

export function nullRows(m: SeedSubsetManifest): string[] {
    return m.certificates.filter((c) => c.rank === null).map((c) => c.uuid);
}

export function seedFilter(m: Pick<SeedSubsetPlan, 'prefix'>): JsonObject[] {
    return [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: m.prefix }];
}

export function manifestProblems(m: SeedSubsetManifest, ofRun: string = runId()): string[] {
    const problems: string[] = [];
    if (m.kind !== 'b1-null-last-subset') problems.push(`kind ${String(m.kind)}`);
    if (m.runId !== ofRun) problems.push('the manifest belongs to another run');
    if (!m.prefix.startsWith(`${ofRun}-`)) problems.push('the prefix does not carry the run prefix');
    if (m.certificates.length !== 3) problems.push(`${m.certificates.length} certificates (3 expected)`);
    if (new Set(m.certificates.map((c) => c.uuid)).size !== m.certificates.length) problems.push('duplicate certificate uuids');
    if (!m.certificates.every((c) => c.commonName.startsWith(m.prefix))) problems.push('a certificate outside the prefix');
    if (nullRows(m).length !== 1) problems.push(`${nullRows(m).length} certificates without a rank (1 expected)`);
    const ranks = m.certificates.map((c) => c.rank).filter((r): r is number => r !== null);
    if (new Set(ranks).size !== ranks.length) problems.push('equal ranks (the value order would be a tie)');
    return problems;
}

const stillOwn = (m: SeedSubsetManifest): boolean =>
    [m.attributeUuid, ...m.certificates.map((c) => c.uuid)].every((uuid) => checkOwnership({ uuid }).own);

/**
 * Builds the subset through the guarded API (or returns this run's earlier one): own custom attribute and three self-signed uploads;
 * ledger first for every object.
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

    const manifest: SeedSubsetManifest = { ...plan, runId: runId(), attributeUuid: attr.uuid, certificates };
    updateRunState({ inventorySeed: { ...(readRunState().inventorySeed ?? {}), b1Subset: manifest } });
    logger.info(`seed subset built: ${certificates.length} certificates under the run prefix`);
    return manifest;
}
