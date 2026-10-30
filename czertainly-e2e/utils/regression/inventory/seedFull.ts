/**
 * seedFull — the full certificate seed of the inventory specs.
 *
 * 24 own certificates with chosen dates, keys and issuers, 2 own groups, 5 own custom attribute definitions and an own owner,
 * uploaded in a fixed order so the default list order is known. Every object is in the ledger before any assertion.
 *
 *   - notBefore is `clock - 30 d - <index> h`, so a sort by NOT_BEFORE has the single C21 / C22 tie the row tables expect
 *   - the `day` attribute values use the clock year + 4, so fixed literal dates cannot rot
 *   - the clock is read ONCE per seed
 */
import { Logger } from '../../Logger';
import { assertOwn } from '../ledger/ownership';
import { buildCertificate, BuiltCertificate, generateKeys, IssuerHandle, KeyBits, SignatureHash } from './seedCertificates';
import { patchOwnCertificateOk, readCertificate, uploadBuilt, AttributeValue } from './seedOwnedObjects';
import { createOwnGroup } from '../ownGroups';
import { Filter, isolation } from './searchApi';
import { createOwnUser } from '../ownUsers';
import { OwnRef } from '../ledger/ledger';
import { readRunState, runName, runId, updateRunState } from '../ledger/runState';
import type { GuardedApi } from '../guard/types';
import { uniqueSuffix } from '../text';
import { createOwnCustomAttribute } from '../customAttributes';

const logger = new Logger('InventorySeedFull');

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

export type CertId = `C${string}`;
type GroupKey = 'a' | 'b';
type AttributeKey = 'txt' | 'num' | 'day' | 'flag' | 'pick';

export interface CertificateSeedRow {
    id: CertId;
    /** Common-name token after the seed prefix. */
    token: string;
    /** Days from the clock; the exact notBefore is `clock - 30 d - notBeforeHours h` unless `notBeforeDays` is given. */
    notBeforeDays?: number;
    notBeforeHours: number;
    notAfterDays: number;
    keyBits: KeyBits;
    hash: SignatureHash;
    /** Issued by this seed certificate (the CA), else self-signed. */
    issuedBy?: CertId;
    ca?: boolean;
    /** Same notAfter and notBefore as this certificate (the tie of the uuid tie-break). */
    sameInstantAs?: CertId;
    groups: GroupKey[];
    owner: boolean;
    txt?: string;
    num?: number;
    /** Offset into the day table `DAY_VALUES`. */
    day?: 0 | 1 | 2 | 3 | 4;
    flag?: boolean;
    pick?: string[];
}

/** The certificates of the certificate seed; notBefore hours make the instants distinct. */
export const CERTIFICATE_SEED_ROWS: readonly CertificateSeedRow[] = [
    { id: 'C01', token: 'alpha-web', notBeforeHours: 1, notAfterDays: 5, keyBits: 2048, hash: 'SHA-256', groups: ['a'], owner: true, txt: 'red', num: 10, day: 0, flag: true, pick: ['a'] },
    { id: 'C02', token: 'alpha-api', notBeforeHours: 2, notAfterDays: 15, keyBits: 2048, hash: 'SHA-256', groups: ['a'], owner: true, txt: 'red', num: 20, day: 1, flag: true, pick: ['a', 'b'] },
    { id: 'C03', token: 'beta-web', notBeforeHours: 3, notAfterDays: 25, keyBits: 2048, hash: 'SHA-256', groups: ['a', 'b'], owner: false, txt: 'Red', num: 30, day: 2, flag: false, pick: ['b'] },
    { id: 'C04', token: 'beta-api', notBeforeHours: 4, notAfterDays: 45, keyBits: 2048, hash: 'SHA-256', groups: ['a', 'b'], owner: false, txt: 'green', num: 40, day: 3, flag: false, pick: ['c'] },
    { id: 'C05', token: 'gamma-db', notBeforeHours: 5, notAfterDays: 75, keyBits: 3072, hash: 'SHA-256', groups: ['a'], owner: false, txt: 'blue', num: 50, day: 4, flag: true, pick: ['a', 'b', 'c'] },
    { id: 'C06', token: 'gamma-web', notBeforeHours: 6, notAfterDays: 120, keyBits: 3072, hash: 'SHA-256', groups: ['a'], owner: false, txt: 'red-blue', num: 60 },
    { id: 'C07', token: 'Delta-web', notBeforeDays: -400, notBeforeHours: 0, notAfterDays: -1, keyBits: 2048, hash: 'SHA-256', groups: ['b'], owner: false, num: -5 },
    { id: 'C08', token: 'delta-mail', notBeforeHours: 8, notAfterDays: 200, keyBits: 4096, hash: 'SHA-256', groups: ['b'], owner: false, num: 0 },
    { id: 'C09', token: 'eps_01', notBeforeHours: 9, notAfterDays: 201, keyBits: 2048, hash: 'SHA-384', groups: [], owner: false, txt: 'annulled', num: 100 },
    { id: 'C10', token: 'zeta-10', notBeforeHours: 10, notAfterDays: 202, keyBits: 2048, hash: 'SHA-512', groups: [], owner: false, num: 1000 },
    { id: 'C11', token: 'eta-11', notBeforeHours: 11, notAfterDays: 203, keyBits: 2048, hash: 'SHA-256', issuedBy: 'C24', groups: [], owner: false },
    { id: 'C12', token: 'theta-12', notBeforeHours: 12, notAfterDays: 204, keyBits: 2048, hash: 'SHA-256', issuedBy: 'C24', groups: [], owner: false },
    { id: 'C13', token: 'iota-13', notBeforeHours: 13, notAfterDays: 205, keyBits: 2048, hash: 'SHA-256', issuedBy: 'C24', groups: [], owner: false },
    { id: 'C14', token: 'kappa-14', notBeforeHours: 14, notAfterDays: 206, keyBits: 2048, hash: 'SHA-256', groups: [], owner: false },
    { id: 'C15', token: 'lambda-15', notBeforeHours: 15, notAfterDays: 207, keyBits: 2048, hash: 'SHA-256', groups: [], owner: false },
    { id: 'C16', token: 'mu-16', notBeforeHours: 16, notAfterDays: 208, keyBits: 2048, hash: 'SHA-256', groups: [], owner: false },
    { id: 'C17', token: 'nu-17', notBeforeHours: 17, notAfterDays: 209, keyBits: 2048, hash: 'SHA-256', groups: [], owner: false },
    { id: 'C18', token: 'xi-18', notBeforeHours: 18, notAfterDays: 210, keyBits: 2048, hash: 'SHA-256', groups: [], owner: false },
    { id: 'C19', token: 'omicron-19', notBeforeHours: 19, notAfterDays: 211, keyBits: 2048, hash: 'SHA-256', groups: [], owner: false },
    { id: 'C20', token: 'pi-20', notBeforeDays: 10, notBeforeHours: 0, notAfterDays: 212, keyBits: 2048, hash: 'SHA-256', groups: [], owner: false },
    { id: 'C21', token: 'rho-21', notBeforeHours: 21, notAfterDays: 300, keyBits: 2048, hash: 'SHA-256', groups: [], owner: false },
    { id: 'C22', token: 'sigma-22', notBeforeHours: 21, notAfterDays: 300, keyBits: 2048, hash: 'SHA-256', sameInstantAs: 'C21', groups: [], owner: false },
    { id: 'C23', token: 'tau-23', notBeforeHours: 23, notAfterDays: 213, keyBits: 2048, hash: 'SHA-256', groups: [], owner: false },
    { id: 'C24', token: 'ca-root', notBeforeHours: 24, notAfterDays: 400, keyBits: 2048, hash: 'SHA-256', ca: true, groups: [], owner: false },
];

/** Upload order: the CA first, then C01…C23 (so created descending reads C23 … C01, C24). */
export const CERTIFICATE_SEED_UPLOAD_ORDER: readonly CertId[] = ['C24', ...CERTIFICATE_SEED_ROWS.filter((r) => r.id !== 'C24').map((r) => r.id)];

/** Default listing order of the 24 seeds (created descending): C23 … C01, C24. */
export const SEED_A_DEFAULT_ORDER: readonly CertId[] = [...CERTIFICATE_SEED_UPLOAD_ORDER].reverse();

/** The `day` attribute values for a clock year: Y-01-10, Y-02-20, Y-03-30, Y-03-30, (Y+1)-01-01. */
export function dayValues(clock: Date): string[] {
    const y = clock.getUTCFullYear() + 4;
    return [`${y}-01-10`, `${y}-02-20`, `${y}-03-30`, `${y}-03-30`, `${y + 1}-01-01`];
}

export const PICK_OPTIONS = ['a', 'b', 'c'] as const;

interface AttributePlan {
    name: string;
    label: string;
    contentType: 'string' | 'integer' | 'date' | 'boolean';
    options?: string[];
    /** `<name>|<CONTENT_TYPE>`: how the catalogue publishes the field. */
    identifier: string;
}

export interface CertificateSeedEntry {
    id: CertId;
    token: string;
    commonName: string;
    keyBits: KeyBits;
    hash: SignatureHash;
    issuedBy?: CertId;
    ca: boolean;
    groups: GroupKey[];
    owner: boolean;
    /** The attribute values the certificate holds (null = none). */
    txt: string | null;
    num: number | null;
    day: string | null;
    flag: boolean | null;
    pick: string[] | null;
    /** Planned instants (ISO); after the build the manifest holds the API read-back in `notBefore` / `notAfter`. */
    notBefore: string;
    notAfter: string;
}

export interface CertificateSeedPlan {
    kind: 'certificate-seed';
    stamp: string;
    /** `<run>-flt-<stamp>-`: the isolation prefix of every seed certificate, group and attribute. */
    prefix: string;
    /** The clock every relative date was computed from (ISO), read once. */
    clock: string;
    groups: Record<GroupKey, { name: string }>;
    attributes: Record<AttributeKey, AttributePlan>;
    owner: { username: string };
    certificates: CertificateSeedEntry[];
}

export interface SeedAManifest extends CertificateSeedPlan {
    runId: string;
    groupUuids: Record<GroupKey, string>;
    attributeUuids: Record<AttributeKey, string>;
    ownerUuid: string;
    certificates: Array<CertificateSeedEntry & { uuid: string; fingerprint: string; serialHex: string }>;
}

/** The pure description of the certificate seed: names, instants, values. `name` and `stamp` are injectable for the unit tests. */
export function planCertificateSeed(clock: Date = new Date(), name: (suffix: string) => string = runName, stamp: string = uniqueSuffix()): CertificateSeedPlan {
    const prefix = name(`flt-${stamp}-`);
    const days = dayValues(clock);
    const at = (row: CertificateSeedRow, kind: 'before' | 'after'): string => {
        const base = row.sameInstantAs ? CERTIFICATE_SEED_ROWS.find((r) => r.id === row.sameInstantAs)! : row;
        const ms = kind === 'after'
            ? clock.getTime() + base.notAfterDays * DAY
            : clock.getTime() + (base.notBeforeDays ?? -30) * DAY - base.notBeforeHours * HOUR;
        return new Date(Math.floor(ms / 1000) * 1000).toISOString();
    };
    const attr = (key: AttributeKey, label: string, contentType: AttributePlan['contentType'], options?: string[]): AttributePlan => ({
        name: `${prefix}${key}`,
        label: `Seed ${label} ${stamp}`,
        contentType,
        ...(options ? { options } : {}),
        identifier: `${prefix}${key}|${contentType.toUpperCase()}`,
    });
    return {
        kind: 'certificate-seed',
        stamp,
        prefix,
        clock: clock.toISOString(),
        groups: { a: { name: `${prefix}grp-a` }, b: { name: `${prefix}grp-b` } },
        attributes: {
            txt: attr('txt', 'text', 'string'),
            num: attr('num', 'number', 'integer'),
            day: attr('day', 'day', 'date'),
            flag: attr('flag', 'flag', 'boolean'),
            pick: attr('pick', 'pick', 'string', [...PICK_OPTIONS]),
        },
        owner: { username: `${prefix}owner` },
        certificates: CERTIFICATE_SEED_ROWS.map((r) => ({
            id: r.id,
            token: r.token,
            commonName: `${prefix}${r.token}`,
            keyBits: r.keyBits,
            hash: r.hash,
            ...(r.issuedBy ? { issuedBy: r.issuedBy } : {}),
            ca: !!r.ca,
            groups: [...r.groups],
            owner: r.owner,
            txt: r.txt ?? null,
            num: r.num ?? null,
            day: r.day === undefined ? null : days[r.day],
            flag: r.flag ?? null,
            pick: r.pick ? [...r.pick] : null,
            notBefore: at(r, 'before'),
            notAfter: at(r, 'after'),
        })),
    };
}

/** The isolation filter of a seed set: Common Name starts with the prefix (every exact row-set oracle carries it). */
export const seedIsolation = (m: Pick<CertificateSeedPlan, 'prefix'>): Filter => isolation(m.prefix);

// ------------------------------------------------------------------ pure accessors

export const certById = (m: SeedAManifest, id: CertId): SeedAManifest['certificates'][number] => {
    const c = m.certificates.find((x) => x.id === id);
    if (!c) throw new Error(`the certificate seed has no ${id}`);
    return c;
};

export const uuidsOfIds = (m: SeedAManifest, ids: readonly CertId[]): string[] => ids.map((id) => certById(m, id).uuid).sort();

export const idsOfUuids = (m: SeedAManifest, uuids: readonly string[]): CertId[] =>
    uuids.map((u) => m.certificates.find((c) => c.uuid === u)?.id ?? (`?${u.slice(0, 8)}` as CertId)).sort() as CertId[];

/** Ids of the seeds satisfying a predicate (the reference set of a row). */
export const idsWhere = (m: CertificateSeedPlan, pred: (c: CertificateSeedEntry) => boolean): CertId[] => m.certificates.filter(pred).map((c) => c.id);

// ------------------------------------------------------------------ build

const stillOwn = (m: SeedAManifest): boolean => {
    try {
        for (const uuid of [...Object.values(m.groupUuids), ...Object.values(m.attributeUuids), m.ownerUuid, ...m.certificates.map((c) => c.uuid)]) assertOwn({ uuid }, 'ensureCertificateSeed');
        return true;
    } catch {
        return false;
    }
};

/** Is there a usable certificate seed of this run in the run state (so the next `ensureCertificateSeed` sends nothing)? */
export function hasCertificateSeed(): boolean {
    const m = readRunState().inventorySeed?.certificateSeed as SeedAManifest | undefined;
    return !!m && m.runId === runId() && !certificateSeedProblems(m).length && stillOwn(m);
}

/** Why a manifest is not a usable certificate seed (empty = usable). */
export function certificateSeedProblems(m: SeedAManifest, ofRun: string = runId()): string[] {
    const problems: string[] = [];
    if (m.kind !== 'certificate-seed') problems.push(`kind ${String(m.kind)}`);
    if (m.runId !== ofRun) problems.push('the manifest belongs to another run');
    if (!m.prefix.startsWith(`${ofRun}-`)) problems.push('the prefix does not carry the run prefix');
    if (m.certificates.length !== 24) problems.push(`${m.certificates.length} certificates (24 expected)`);
    if (new Set(m.certificates.map((c) => c.uuid)).size !== m.certificates.length) problems.push('duplicate certificate uuids');
    if (!m.certificates.every((c) => c.commonName.startsWith(m.prefix))) problems.push('a certificate outside the prefix');
    return problems;
}

/**
 * Builds the certificate seed through the guarded API, or returns this run's earlier one. 24 uploads, 2 groups, 5 attribute definitions,
 * the owner user and the group / owner / trusted-CA updates (about 60 requests, ~20-40 s): the first caller sets a long
 * test timeout. `onStep` reports progress for `test.step`-less callers.
 */
export async function ensureCertificateSeed(api: GuardedApi, spec: string): Promise<SeedAManifest> {
    const earlier = readRunState().inventorySeed?.certificateSeed as SeedAManifest | undefined;
    if (earlier && earlier.runId === runId() && !certificateSeedProblems(earlier).length && stillOwn(earlier)) return earlier;

    const plan = planCertificateSeed();
    logger.info(`building the certificate seed under ${plan.prefix}…`);

    // Keys first, in parallel (native RSA): the CA's 2048 bits, the 3072 / 4096 ones take longest.
    const handles = new Map<CertId, IssuerHandle>();
    const built = new Map<CertId, BuiltCertificate>();
    const keyPairs = new Map<CertId, CryptoKeyPair>();
    await Promise.all(plan.certificates.map(async (c) => void keyPairs.set(c.id, await generateKeys(c.keyBits, c.issuedBy ? 'SHA-256' : c.hash))));
    for (const id of CERTIFICATE_SEED_UPLOAD_ORDER) {
        const c = plan.certificates.find((x) => x.id === id)!;
        const issuer = c.issuedBy ? handles.get(c.issuedBy) : undefined;
        if (c.issuedBy && !issuer) throw new Error(`certificate seed: ${c.id} needs ${c.issuedBy} built first`);
        const b = await buildCertificate({
            commonName: c.commonName,
            notBefore: new Date(c.notBefore),
            notAfter: new Date(c.notAfter),
            keyBits: c.keyBits,
            hash: c.issuedBy ? undefined : c.hash,
            ca: c.ca,
            issuer,
            keys: keyPairs.get(c.id),
        });
        built.set(id, b);
        handles.set(id, b.handle);
    }

    // Own attribute definitions (never required), the owner user and the groups.
    const attributeUuids = {} as Record<AttributeKey, string>;
    for (const key of ['txt', 'num', 'day', 'flag', 'pick'] as const) {
        const a = plan.attributes[key];
        const ref = await createOwnCustomAttribute(api, spec, 'seed', { name: a.name, label: a.label, contentType: a.contentType, options: a.options, description: `REG run ${runId()}: inventory seed`, note: 'seed custom attribute (not required)' });
        attributeUuids[key] = ref.uuid;
    }
    const owner = await createOwnUser(api, spec, 'seed-owner', { name: plan.owner.username, enabled: false, note: 'seed owner (disabled)' });
    const groupUuids = {} as Record<GroupKey, string>;
    for (const key of ['a', 'b'] as const) groupUuids[key] = (await createOwnGroup(api, spec, 'grp', { name: plan.groups[key].name, note: `seed group ${key}` })).uuid;

    // Uploads, sequentially: the CA first, then C01…C23. The attribute values travel in the upload request.
    const values = (c: CertificateSeedEntry): AttributeValue[] => {
        const out: AttributeValue[] = [];
        const add = (key: AttributeKey, data: unknown[] | null) => {
            if (data === null) return;
            const a = plan.attributes[key];
            out.push({ uuid: attributeUuids[key], name: a.name, contentType: a.contentType, data, list: !!a.options });
        };
        add('txt', c.txt === null ? null : [c.txt]);
        add('num', c.num === null ? null : [c.num]);
        add('day', c.day === null ? null : [c.day]);
        add('flag', c.flag === null ? null : [c.flag]);
        add('pick', c.pick);
        return out;
    };
    const refs = new Map<CertId, OwnRef>();
    for (const id of CERTIFICATE_SEED_UPLOAD_ORDER) {
        const c = plan.certificates.find((x) => x.id === id)!;
        const up = await uploadBuilt(api, spec, built.get(id)!, values(c), `certificate seed ${id}`);
        refs.set(id, up);
    }

    // Groups, owner and the trusted-CA mark by PATCH on the own certificates (guard: groupUuids -> own groups, ownerUuid -> own users).
    for (const c of plan.certificates) {
        const patch: Record<string, unknown> = {};
        if (c.groups.length) patch.groupUuids = c.groups.map((g) => groupUuids[g]);
        if (c.owner) patch.ownerUuid = owner.uuid;
        if (c.ca) patch.trustedCa = true;
        if (Object.keys(patch).length) await patchOwnCertificateOk(api, refs.get(c.id)!, patch);
    }

    // Read back what the platform stored (instants, fingerprint): these are the literals the tests use.
    const certificates: SeedAManifest['certificates'] = [];
    for (const c of plan.certificates) {
        const detail = await readCertificate(api, refs.get(c.id)!.uuid);
        certificates.push({
            ...c,
            uuid: refs.get(c.id)!.uuid,
            fingerprint: String(detail.fingerprint ?? built.get(c.id)!.fingerprintSha256),
            serialHex: built.get(c.id)!.serialHex,
            notBefore: detail.notBefore ? new Date(String(detail.notBefore)).toISOString() : c.notBefore,
            notAfter: detail.notAfter ? new Date(String(detail.notAfter)).toISOString() : c.notAfter,
        });
    }
    const manifest: SeedAManifest = { ...plan, runId: runId(), groupUuids, attributeUuids, ownerUuid: owner.uuid, certificates };
    updateRunState({ inventorySeed: { ...(readRunState().inventorySeed ?? {}), certificateSeed: manifest } });
    logger.info(`certificate seed built: ${certificates.length} certificates`);
    return manifest;
}

// ------------------------------------------------------------------ the two small seeds (archive, group replace)

interface SmallSeedCert {
    key: string;
    commonName: string;
    uuid: string;
}

export interface SmallSeedManifest {
    kind: 'archive-seed' | 'group-seed';
    runId: string;
    prefix: string;
    groups: Array<{ key: string; name: string; uuid: string }>;
    certificates: SmallSeedCert[];
}

async function buildSmallSeed(api: GuardedApi, spec: string, kind: 'archive-seed' | 'group-seed', tag: string, certKeys: string[], groupKeys: string[], assign: (certKey: string) => string[]): Promise<SmallSeedManifest> {
    const stamp = uniqueSuffix();
    const prefix = runName(`${tag}-${stamp}-`);
    const groups: SmallSeedManifest['groups'] = [];
    for (const key of groupKeys) {
        const name = `${prefix}${key}`;
        groups.push({ key, name, uuid: (await createOwnGroup(api, spec, 'grp', { name, note: `${kind} group ${key}` })).uuid });
    }
    const clock = new Date();
    const certificates: SmallSeedCert[] = [];
    for (const key of certKeys) {
        const commonName = `${prefix}${key}`;
        const b = await buildCertificate({ commonName, notBefore: new Date(clock.getTime() - 30 * DAY), notAfter: new Date(clock.getTime() + 100 * DAY) });
        const up = await uploadBuilt(api, spec, b, [], `${kind} ${key}`);
        certificates.push({ key, commonName, uuid: up.uuid });
    }
    for (const c of certificates) {
        const g = assign(c.key).map((k) => groups.find((x) => x.key === k)!.uuid);
        if (g.length) await patchOwnCertificateOk(api, { uuid: c.uuid, name: c.commonName, kind: 'own' }, { groupUuids: g });
    }
    return { kind, runId: runId(), prefix, groups, certificates };
}

/** Fresh archive and group seeds for a test that mutates them destructively (a second set under another stamp). */
export const buildFreshSeedB = (api: GuardedApi, spec: string): Promise<SmallSeedManifest> => buildSmallSeed(api, spec, 'archive-seed', 'arc', ['b1', 'b2', 'b3'], ['grp'], () => ['grp']);
