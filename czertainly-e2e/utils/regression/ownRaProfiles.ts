/**
 * ownRaProfiles — every way the suite gets an RA profile it may change; nothing pre-existing is ever changed. Without a healthy CA to copy
 * from it throws `RaProfileSourceMissing` and the caller skips.
 */
import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { Logger } from '../Logger';
import { healthByVersion, listConnectors } from './platform/connectorApi';
import { GuardedApi } from './guard/types';
import { assertOwnLive, checkOwnership } from './ledger/ownership';
import { activateAcmeOnOwnRaProfile, ensureAcmeProfile } from './config/acmeProfiles';
import { apiJson } from './apiReads';
import { existingRaProfile } from './config/authorities';
import { requiredCustomAttributes, toRequestAttribute } from './customAttributes';
import { CreateOnlyRef, isIssueOnly, LedgerLine, OwnRef, readLedger } from './ledger/ledger';
import { readRunState, runName, runId, updateRunState, ownName } from './ledger/runState';
import { hasRunFamilyPrefix } from './run/runId';
import { createOwn } from './ownCrud';
import { settings } from './run/settings';
import type { JsonObject } from './json';
import { rowsOf } from './json';

const logger = new Logger('OwnRaProfiles');

export interface RaLike {
    uuid: string;
    name: string;
    authorityUuid: string;
}

export interface OwnRaProfile extends OwnRef {
    authorityUuid: string;
}

export type RunRaProfile = (OwnRef | CreateOnlyRef) & { authorityUuid: string };

export async function enableOwnRaProfile(api: GuardedApi, authorityUuid: string, raProfile: OwnRef): Promise<void> {
    await assertOwnLive(api, 'raProfiles', raProfile, 'enableOwnRaProfile');
    await apiJson(api, 'PATCH', `/api/v1/authorities/${authorityUuid}/raProfiles/${raProfile.uuid}/enable`);
}

/** The connectors whose authorities may issue the run's certificates, in order; REG_CA_CONNECTORS overrides it. */
export function caConnectorOrder(env: NodeJS.ProcessEnv = process.env): string[] {
    return settings(env).caConnectors;
}

export class RaProfileSourceMissing extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'RaProfileSourceMissing';
    }
}

export interface RaProfileSource {
    uuid: string;
    authorityUuid: string;
    connectorName: string;
}

/**
 * The first healthy CA (by `caConnectorOrder`) with a connected authority and an enabled RA profile to copy, both not run objects;
 * read-only. Returns the source or `{ skip }` with a reason per connector.
 */
export async function pickHealthyAuthority(api: APIRequestContext, env: NodeJS.ProcessEnv = process.env): Promise<RaProfileSource | { skip: string }> {
    const connectors = await listConnectors(api);
    const authorities = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/authorities');
    const raProfiles = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/raProfiles');
    const reasons: string[] = [];
    for (const name of caConnectorOrder(env)) {
        const connector = connectors.find((c) => c.name === name);
        if (!connector) {
            reasons.push(`${name}: not registered`);
            continue;
        }
        if (connector.status !== 'connected') {
            reasons.push(`${name}: stored status ${connector.status}`);
            continue;
        }
        const health = await healthByVersion(api, connector);
        if (!health.healthy) {
            reasons.push(`${name}: ${health.why}`);
            continue;
        }
        const onConnector = new Set(
            authorities.filter((a) => a.connectorUuid === connector.uuid && a.status === 'connected' && !hasRunFamilyPrefix(String(a.name))).map((a) => String(a.uuid)),
        );
        if (!onConnector.size) {
            reasons.push(`${name}: no connected authority`);
            continue;
        }
        // Sorted by name, so the copy source does not depend on the list order.
        const byName = (a: JsonObject, b: JsonObject): number => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0);
        const source = raProfiles
            .filter((r) => onConnector.has(String(r.authorityInstanceUuid)) && r.enabled === true && !hasRunFamilyPrefix(String(r.name)))
            .sort(byName)[0];
        if (!source) {
            reasons.push(`${name}: no enabled RA profile to copy the attributes from`);
            continue;
        }
        return { uuid: String(source.uuid), authorityUuid: String(source.authorityInstanceUuid), connectorName: name };
    }
    return { skip: `deploy gate: no healthy CA with an enabled RA profile to copy (${reasons.join('; ')}); DevOps: RA-profile attributes per tier` };
}

/**
 * The body for a new RA profile whose connector attributes are copied from the
 * source RA profile (read-only), plus the tier's required custom attributes.
 */
export async function raProfileBodyLike(api: APIRequestContext, source: Pick<RaProfileSource, 'uuid' | 'authorityUuid'>, name: string, description = `REG run ${runId()}`): Promise<JsonObject> {
    const detail = await apiJson<JsonObject>(api, 'GET', `/api/v1/authorities/${source.authorityUuid}/raProfiles/${source.uuid}`);
    return {
        name,
        description,
        attributes: rowsOf(detail.attributes).filter((a) => !a.type || a.type === 'data').map(toRequestAttribute),
        customAttributes: await requiredCustomAttributes(api, 'raProfiles', runName('ca')),
    };
}

export interface RaProfileLikeOptions {
    source: Pick<RaProfileSource, 'uuid' | 'authorityUuid'>;
    name?: string;
    note: string;
    /** The profile is enabled unless this is false (RA profiles are created disabled). */
    enable?: boolean;
}

/**
 * The creator every other function ends in: a new RA profile on the source's authority with copied attributes, recorded in the ledger right
 * after the create, then enabled.
 */
export async function createOwnRaProfileLike(api: GuardedApi, spec: string, suffix: string, o: RaProfileLikeOptions): Promise<OwnRaProfile> {
    const name = o.name ?? ownName(suffix);
    const { name: _name, ...body } = await raProfileBodyLike(api, o.source, name);
    const { answer: _answer, ...ref } = await createOwn(api, spec, {
        type: 'raProfiles',
        path: `/api/v1/authorities/${o.source.authorityUuid}/raProfiles`,
        name,
        note: o.note,
        parents: { authority: o.source.authorityUuid },
        body,
    });
    if (o.enable !== false) await enableOwnRaProfile(api, o.source.authorityUuid, ref);
    return { ...ref, authorityUuid: o.source.authorityUuid };
}

/**
 * The run's RA profile: the run state's, REG_RA_PROFILE_NAME on a local stack (issue-only), or a new own one copied from the first healthy
 * CA; throws RaProfileSourceMissing when none qualifies.
 */
export async function ensureRunRaProfile(api: GuardedApi, spec: string): Promise<RunRaProfile> {
    const state = readRunState();
    if (state.raProfile) return state.raProfile;
    const existing = await existingRaProfile(api);
    if (existing) {
        updateRunState({ raProfile: existing });
        return existing;
    }
    const pick = await pickHealthyAuthority(api);
    if ('skip' in pick) throw new RaProfileSourceMissing(pick.skip);
    const ra = await createOwnRaProfileLike(api, spec, 'ra', { source: pick, name: runName('ra'), note: `API prerequisite; connector attributes copied from an enabled RA profile on ${pick.connectorName}` });
    updateRunState({ raProfile: ra });
    return ra;
}

/** ensureRunRaProfile, with the deploy gate as a skip: `skip` gets the reason; other errors propagate. */
export async function ensureRunRaProfileOrSkip(api: GuardedApi, spec: string, skip: (reason: string) => void): Promise<RunRaProfile> {
    return orSkipWithoutCa(ensureRunRaProfile(api, spec), skip);
}

export async function orSkipWithoutCa<T>(work: Promise<T>, skip: (reason: string) => void): Promise<T> {
    try {
        return await work;
    } catch (e) {
        if (e instanceof RaProfileSourceMissing) skip(e.reason);
        throw e;
    }
}

function ownRaProfileNamed(name: string): OwnRaProfile | undefined {
    const lines: LedgerLine[] = readLedger().filter((l) => l.runId === runId() && l.type === 'raProfiles' && l.name === name);
    const created = [...lines].reverse().find((l) => l.event === 'created');
    if (!created || !checkOwnership(created).own) return undefined;
    const authority = created.parents?.authority;
    const authorityUuid = Array.isArray(authority) ? authority[0] : authority;
    return authorityUuid ? { uuid: created.uuid, name: created.name, kind: 'own', authorityUuid } : undefined;
}

/**
 * An RA profile this run created, for flows that change it: the run RA profile when own, else an own clone `<run>-ra-own`; the issue-only
 * parent is never changed.
 */
export async function ensureOwnRaProfile(api: GuardedApi, spec: string): Promise<OwnRaProfile> {
    const ra = await ensureRunRaProfile(api, spec);
    if (!isIssueOnly(ra)) return ra;
    const name = runName('ra-own');
    const known = ownRaProfileNamed(name);
    if (known) return known;
    return createOwnRaProfileLike(api, spec, 'ra', { source: ra, name, note: 'own clone of the issue-only RA profile (REG_RA_PROFILE_NAME): protocol activation needs an own RA profile' });
}

/**
 * The dedicated RA profile of a protocol flow, `<run>-ra-<label>`: created
 * once per run and label, enabled, a copy of the run RA profile's attributes.
 */
export async function ensureProtocolRaProfile(api: GuardedApi, spec: string, label: string): Promise<OwnRaProfile> {
    if (!/^[a-z0-9-]+$/.test(label)) throw new Error(`ensureProtocolRaProfile: label "${label}" must be [a-z0-9-] (it is part of a URL path)`);
    const name = runName(`ra-${label}`);
    const known = ownRaProfileNamed(name);
    if (known) return known;
    const runRa = await ensureRunRaProfile(api, spec);
    return createOwnRaProfileLike(api, spec, 'ra', { source: runRa, name, note: `dedicated RA profile of the ${label} protocol flow: attributes copied read-only from the run RA profile` });
}

/** An own, enabled clone of the run RA profile; flags and associations are flipped on the clone only. */
export async function cloneRunRaProfile(api: GuardedApi, spec: string, suffix: string): Promise<OwnRaProfile> {
    const run = await ensureRunRaProfile(api, spec);
    return createOwnRaProfileLike(api, spec, `ra-${suffix}`, { source: run, note: `own clone of the run RA profile (${suffix})` });
}

/** A new own, enabled RA profile for one row, named `<run>-<suffix>-<time>`. */
export async function createOwnRaProfile(api: GuardedApi, spec: string, suffix: string): Promise<OwnRaProfile> {
    const pick = await pickHealthyAuthority(api);
    if ('skip' in pick) throw new RaProfileSourceMissing(pick.skip);
    return createOwnRaProfileLike(api, spec, suffix, { source: pick, note: `own RA profile of an event row; attributes copied read-only from an enabled RA profile on ${pick.connectorName}` });
}

export async function createOwnRaProfileOrSkip(api: GuardedApi, spec: string, suffix: string, skip: (reason: string) => void): Promise<OwnRaProfile> {
    return orSkipWithoutCa(createOwnRaProfile(api, spec, suffix), skip);
}

export async function ensureAcmeOnRaProfile(api: GuardedApi, spec: string): Promise<{ raProfile: OwnRaProfile; acmeProfile: OwnRef & { identifier: string }; directoryUrl: string }> {
    const ra = await ensureOwnRaProfile(api, spec);
    const acmeProfile = await ensureAcmeProfile(api, spec);
    if (readRunState().acmeActivatedOn !== ra.uuid) {
        await activateAcmeOnOwnRaProfile(api, ra.authorityUuid, ra, acmeProfile);
        updateRunState({ acmeActivatedOn: ra.uuid });
    }
    const acme = await apiJson<JsonObject>(api, 'GET', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/acme`);
    expect(acme.acmeAvailable, 'ACME should be available on the run RA profile').toBe(true);
    logger.info(`ACME directory: ${acme.directoryUrl}`);
    return { raProfile: ra, acmeProfile, directoryUrl: String(acme.directoryUrl) };
}
