/**
 * inventory — a read-only before / after check of what the timestamping block must never touch on a shared tier.
 * `compareBaseline` says `same`, `differs` (resource, counts and hash prefixes, never a name) or `skipped` with the reason; a refused
 * identity (401 / 403) still fails.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { readLedger } from '../regression/ledger/ledger';
import { currentRunId, regressionStateDir } from '../regression/run/runId';
import { Admin, TierError } from './provision/transport';

export const INVENTORY_RESOURCES: ReadonlyArray<{ name: string; path: string }> = [
    { name: 'signing profiles', path: '/v1/signingProfiles/list' },
    { name: 'TSP profiles', path: '/v1/tspProfiles/list' },
    { name: 'time-quality configurations', path: '/v1/timeQualityConfigurations/list' },
];

const PAGE = 200;

export interface ResourceDigest {
    count: number;
    hash: string;
}

export type Baseline =
    | { status: 'taken'; runId: string; at: string; resources: Record<string, ResourceDigest> }
    | { status: 'skipped'; runId: string; at: string; reason: string };

export type InventoryOutcome =
    | { status: 'same'; resources: Record<string, ResourceDigest> }
    | { status: 'differs'; differences: string[] }
    | { status: 'skipped'; reason: string };

export const inventoryFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(regressionStateDir(env), `${currentRunId(env)}.timestamping.inventory.json`);

function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') {
        return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    return JSON.stringify(v) ?? 'null';
}

export function digestOf(rows: Array<Record<string, unknown>>, own: ReadonlySet<string>): ResourceDigest {
    const kept = rows.filter((r) => !own.has(String(r.uuid ?? '').toLowerCase())).sort((a, b) => String(a.uuid).localeCompare(String(b.uuid)));
    return { count: kept.length, hash: crypto.createHash('sha256').update(kept.map(canonical).join('\n')).digest('hex') };
}

function ownUuids(env: NodeJS.ProcessEnv): Set<string> {
    const runId = currentRunId(env);
    return new Set(readLedger().filter((l) => l.runId === runId && l.event === 'created').map((l) => l.uuid.toLowerCase()));
}

async function allRows(admin: Admin, listPath: string): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= 10_000; page++) {
        const { body } = await admin.request<{ items?: Array<Record<string, unknown>>; totalPages?: number }>('POST', listPath, { itemsPerPage: PAGE, pageNumber: page, filters: [] });
        rows.push(...(body?.items ?? []));
        if (page >= (body?.totalPages ?? 1) || !(body?.items ?? []).length) return rows;
    }
    throw new TierError(`${listPath} did not end after 10000 pages`);
}

export async function readInventory(admin: Admin, env: NodeJS.ProcessEnv = process.env): Promise<{ resources: Record<string, ResourceDigest> } | { skip: string }> {
    const own = ownUuids(env);
    const resources: Record<string, ResourceDigest> = {};
    try {
        for (const r of INVENTORY_RESOURCES) resources[r.name] = digestOf(await allRows(admin, r.path), own);
    } catch (e) {
        if (e instanceof TierError) return { skip: `the tier cannot list the ${INVENTORY_RESOURCES.find((r) => !(r.name in resources))?.name ?? 'resources'}: ${e.message}` };
        throw e;
    }
    return { resources };
}

export function clearBaseline(env: NodeJS.ProcessEnv = process.env): void {
    fs.rmSync(inventoryFile(env), { force: true });
}

export async function takeBaseline(admin: Admin, env: NodeJS.ProcessEnv = process.env): Promise<Baseline> {
    const read = await readInventory(admin, env);
    const meta = { runId: currentRunId(env), at: new Date().toISOString() };
    const baseline: Baseline = 'skip' in read ? { status: 'skipped', ...meta, reason: read.skip } : { status: 'taken', ...meta, resources: read.resources };
    fs.mkdirSync(path.dirname(inventoryFile(env)), { recursive: true });
    fs.writeFileSync(inventoryFile(env), `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
    return baseline;
}

export function readBaseline(env: NodeJS.ProcessEnv = process.env): Baseline | undefined {
    try {
        const b = JSON.parse(fs.readFileSync(inventoryFile(env), 'utf8')) as Baseline;
        return b.runId === currentRunId(env) ? b : undefined;
    } catch {
        return undefined;
    }
}

const short = (d: ResourceDigest): string => `${d.count} rows, ${d.hash.slice(0, 12)}`;

export async function compareBaseline(admin: Admin, env: NodeJS.ProcessEnv = process.env): Promise<InventoryOutcome> {
    const before = readBaseline(env);
    if (!before) return { status: 'skipped', reason: 'no baseline: the setup took none (the tier was unavailable, or the setup did not run)' };
    if (before.status === 'skipped') return { status: 'skipped', reason: `no baseline: ${before.reason}` };
    const after = await readInventory(admin, env);
    if ('skip' in after) return { status: 'skipped', reason: after.skip };
    const differences = INVENTORY_RESOURCES.filter((r) => before.resources[r.name]?.hash !== after.resources[r.name].hash || before.resources[r.name]?.count !== after.resources[r.name].count)
        .map((r) => `${r.name}: before ${before.resources[r.name] ? short(before.resources[r.name]) : 'not read'}, after ${short(after.resources[r.name])}`);
    return differences.length ? { status: 'differs', differences } : { status: 'same', resources: after.resources };
}
