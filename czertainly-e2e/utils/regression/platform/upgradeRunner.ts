/**
 * upgradeRunner — the local upgrade test.
 *
 * Seeds on the old core image, takes a snapshot, upgrades on the same database, takes a snapshot again and diffs. An upgrade
 * must keep every object, and every migration drift must show. The snapshot diff and the schema-history checks are pure; the
 * live half reads through the API and `PlatformStack.psql`. The upgrade is one way: a target older than the source image is
 * refused.
 */
import type { APIRequestContext } from '@playwright/test';
import { apiJson } from '../apiReads';
import { PlatformStack } from './localStack';
import type { JsonObject } from '../json';

/** The listed types whose uuid sets must survive an upgrade (DEP-02-4). */
const SNAPSHOT_TYPES: readonly string[] = ['raProfiles', 'acmeProfiles', 'roles', 'users', 'groups', 'credentials', 'authorities', 'tokens', 'tokenProfiles', 'connectors'];

interface TypeSnapshot {
    count: number;
    /** uuid → name (or the key attribute that identifies the object). */
    objects: Record<string, string>;
}

export interface SchemaHistoryRow {
    installedRank: number;
    version: string | null;
    description: string;
    checksum: number | null;
    success: boolean;
}

export interface Snapshot {
    takenAt: string;
    coreVersion?: string;
    types: Record<string, TypeSnapshot>;
    certificatesTotal: number;
    auditLogTotal?: number;
    connectorStatuses: Record<string, string>;
    schemaHistory: SchemaHistoryRow[];
}

// ------------------------------------------------------------------ pure: the diff rules

/** Users and roles may grow by the SYSTEM objects that migrations create: any extra must match these patterns. */
const SYSTEM_IDENTITY = /^(localhost|superadmin|acme|scep|cmp|attribute-content-resolver|cert-manager|protocol-)/i;

export interface DiffReport {
    problems: string[];
    /** Extras in users / roles that look like system objects (reported, not failed). */
    systemExtras: string[];
}

/** DEP-02-4: every before-uuid still after with the same name, counts equal except system extras in users / roles. */
export function diffSnapshots(before: Snapshot, after: Snapshot): DiffReport {
    const problems: string[] = [];
    const systemExtras: string[] = [];
    for (const type of Object.keys(before.types)) {
        const b = before.types[type];
        const a = after.types[type];
        if (!a) {
            problems.push(`${type}: missing after the upgrade`);
            continue;
        }
        for (const [uuid, name] of Object.entries(b.objects)) {
            if (!(uuid in a.objects)) problems.push(`${type}: ${uuid} (${name}) is gone`);
            else if (a.objects[uuid] !== name) problems.push(`${type}: ${uuid} renamed ${name} → ${a.objects[uuid]}`);
        }
        const extras = Object.entries(a.objects).filter(([uuid]) => !(uuid in b.objects));
        if (type === 'users' || type === 'roles') {
            for (const [uuid, name] of extras) {
                if (SYSTEM_IDENTITY.test(name)) systemExtras.push(`${type}: ${name} (${uuid})`);
                else problems.push(`${type}: unexpected new ${name} (${uuid})`);
            }
        } else if (extras.length) problems.push(`${type}: count ${b.count} → ${a.count} (${extras.length} new object(s))`);
        else if (a.count !== b.count) problems.push(`${type}: count ${b.count} → ${a.count}`);
    }
    if (after.certificatesTotal < before.certificatesTotal) problems.push(`certificates total ${before.certificatesTotal} → ${after.certificatesTotal}`);
    if (before.auditLogTotal !== undefined && after.auditLogTotal !== undefined && after.auditLogTotal < before.auditLogTotal) {
        problems.push(`audit log total ${before.auditLogTotal} → ${after.auditLogTotal} (the 2.14 reset must not be crossed)`);
    }
    for (const [name, status] of Object.entries(before.connectorStatuses)) {
        if (status === 'connected' && after.connectorStatuses[name] !== 'connected') problems.push(`connector ${name}: ${status} → ${after.connectorStatuses[name] ?? 'missing'}`);
    }
    return { problems, systemExtras };
}

/** DEP-02-2: before-rows kept (same checksum, success), new rows success, out-of-order evidenced. */
export function schemaHistoryProblems(before: SchemaHistoryRow[], after: SchemaHistoryRow[]): { problems: string[]; newVersions: string[]; outOfOrder: boolean } {
    const problems: string[] = [];
    const byRank = new Map(after.map((r) => [r.installedRank, r]));
    for (const b of before) {
        const a = byRank.get(b.installedRank);
        if (!a) problems.push(`schema history rank ${b.installedRank} (${b.version}) is gone`);
        else {
            if (a.version !== b.version || a.checksum !== b.checksum) problems.push(`schema history rank ${b.installedRank}: ${b.version}/${b.checksum} → ${a.version}/${a.checksum}`);
            if (!a.success) problems.push(`schema history rank ${b.installedRank} (${b.version}) is not success`);
        }
    }
    const maxBefore = before.reduce((m, r) => (r.version && versionGreater(r.version, m) ? r.version : m), '');
    const newRows = after.filter((r) => !before.some((b) => b.installedRank === r.installedRank));
    for (const r of newRows) if (!r.success) problems.push(`new migration ${r.version} is not success`);
    const newVersions = newRows.map((r) => r.version ?? '').filter(Boolean);
    const outOfOrder = newVersions.some((v) => versionGreater(maxBefore, v));
    return { problems, newVersions, outOfOrder };
}

/** Flyway compares versions numerically (a 13-digit version is greater than every 12-digit one); non-numeric parts fall back to text. */
export function versionGreater(a: string, b: string): boolean {
    if (!b) return true;
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) > BigInt(b);
    return a > b;
}

/** Never downgrade — the `from` tag must not be newer than the target. Tags `2.19.1`, `2.20.0-SNAPSHOT`, …; undefined = cannot compare. */
export function upgradeDirectionProblem(fromTag: string, targetVersion: string): string | undefined {
    const parse = (s: string) => /(\d+)\.(\d+)\.(\d+)/.exec(s)?.slice(1, 4).map(Number);
    const f = parse(fromTag);
    const t = parse(targetVersion);
    if (!f || !t) return `cannot compare versions "${fromTag}" and "${targetVersion}"`;
    for (let i = 0; i < 3; i++) {
        if (f[i] < t[i]) return undefined;
        if (f[i] > t[i]) return `REG_UPGRADE_FROM_TAG ${fromTag} is newer than the image under test ${targetVersion}: an upgrade is one way, never a downgrade`;
    }
    return undefined;
}

/** `core_schema_history` rows from the unaligned psql output (`rank|version|description|checksum|success`). */
export function parseSchemaHistory(rows: string[]): SchemaHistoryRow[] {
    return rows.map((line) => {
        const [rank, version, description, checksum, success] = line.split('|');
        return { installedRank: Number(rank), version: version || null, description, checksum: checksum ? Number(checksum) : null, success: success === 't' || success === 'true' };
    });
}

const SCHEMA_HISTORY_SQL = 'select installed_rank, version, description, checksum, success from core.core_schema_history order by installed_rank';

// ------------------------------------------------------------------ live: snapshots

const LIST_URLS: Readonly<Record<string, string>> = {
    raProfiles: '/api/v1/raProfiles', acmeProfiles: '/api/v1/acmeProfiles', roles: '/api/v1/roles', users: '/api/v1/users', groups: '/api/v1/groups',
    credentials: '/api/v1/credentials', authorities: '/api/v1/authorities', tokens: '/api/v1/tokens', tokenProfiles: '/api/v1/tokenProfiles', connectors: '/api/v1/connectors',
};

const nameOf = (row: JsonObject): string => String(row.name ?? row.username ?? row.uuid);

/** A snapshot through the API (read-only) and, when a stack is given, the schema history through psql. */
export async function takeSnapshot(api: APIRequestContext, stack?: PlatformStack): Promise<Snapshot> {
    const types: Record<string, TypeSnapshot> = {};
    for (const type of SNAPSHOT_TYPES) {
        const rows = await apiJson<JsonObject[] | JsonObject>(api, 'GET', LIST_URLS[type]);
        const list: JsonObject[] = Array.isArray(rows) ? rows : ((rows.items ?? []) as JsonObject[]);
        types[type] = { count: list.length, objects: Object.fromEntries(list.map((r) => [String(r.uuid), nameOf(r)])) };
    }
    const certs = await apiJson<JsonObject>(api, 'POST', '/api/v1/certificates', { itemsPerPage: 1, pageNumber: 1, filters: [] });
    let auditLogTotal: number | undefined;
    try {
        const audit = await apiJson<JsonObject>(api, 'POST', '/api/v1/auditLogs', { itemsPerPage: 1, pageNumber: 1, filters: [] });
        auditLogTotal = Number(audit.totalItems ?? audit.total ?? 0);
    } catch {
        auditLogTotal = undefined;
    }
    const connectors = (await apiJson<JsonObject[]>(api, 'GET', '/api/v1/connectors')).map((c) => [String(c.name), String(c.status)] as const);
    let coreVersion: string | undefined;
    try {
        coreVersion = String(((await apiJson<JsonObject>(api, 'GET', '/api/v1/info')).app as JsonObject | undefined)?.version ?? '');
    } catch {
        coreVersion = undefined;
    }
    return {
        takenAt: new Date().toISOString(),
        coreVersion,
        types,
        certificatesTotal: Number(certs.totalItems ?? certs.total ?? 0),
        auditLogTotal,
        connectorStatuses: Object.fromEntries(connectors),
        schemaHistory: stack ? parseSchemaHistory(stack.psql(SCHEMA_HISTORY_SQL)) : [],
    };
}
