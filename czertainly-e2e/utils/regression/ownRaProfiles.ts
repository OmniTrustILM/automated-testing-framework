/**
 * ownRaProfiles — every way the regression suite gets an RA profile it may change, in one family:
 *
 * - `createRaProfileLike`: the raw create of a NEW RA profile whose connector attributes are copied (read-only) from a
 *   source RA profile; not recorded, not enabled;
 * - `createOwnRaProfileLike`: that create, recorded in the ledger with its authority as parent, then enabled — the one
 *   sequence every creator below ends in;
 * - `ensureRunRaProfile`: the RUN RA profile every issuing flow goes through (run state first; REG_RA_PROFILE_NAME on a local
 *   stack as an issue-only parent; otherwise a new own RA profile under the first healthy CA);
 * - `ensureOwnRaProfile`: an RA profile this run CREATED, for flows that change it (protocol activation): the run RA profile
 *   when it is own, else an own clone of the issue-only one;
 * - `ensureProtocolRaProfile`: the dedicated RA profile of one protocol flow (`<run>-ra-<label>`), found again through the ledger;
 * - `cloneRunRaProfile`: an own, enabled clone of the run RA profile for flows that flip flags or associations on it;
 * - `createOwnRaProfile`: a new own RA profile for one row, named by suffix, under the first healthy CA (event rows hang
 *   their associations on it alone).
 *
 * No healthy CA with an enabled RA profile to copy from: `RaProfileSourceMissing` (the caller skips with the named deploy
 * gate; a skip is never coverage). Every change goes through `assertOwnLive`; nothing pre-existing is ever changed.
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
import { CreateOnlyRef, isIssueOnly, LedgerLine, OwnRef, readLedger, recordCreated, Ref } from './ledger/ledger';
import { readRunState, runName, runId, updateRunState } from './ledger/runState';
import { hasRunFamilyPrefix } from './run/runId';
import { timestampSuffix } from './text';
import { ownName } from './events/workflowRequests';

const logger = new Logger('OwnRaProfiles');

type Json = Record<string, any>;

/** An RA profile a lifecycle call goes through: the run RA profile or an own clone (`RA+`). */
export interface RaLike {
    uuid: string;
    name: string;
    authorityUuid: string;
}

/** An RA profile this run created: the ledger knows it, so it may be changed. */
export interface OwnRaProfile extends OwnRef {
    authorityUuid: string;
}

/** The run RA profile: own, or an issue-only parent (REG_RA_PROFILE_NAME on a local stack). */
export type RunRaProfile = (OwnRef | CreateOnlyRef) & { authorityUuid: string };

/** Enable an RA profile this run created (RA profiles are created disabled). */
export async function enableOwnRaProfile(api: GuardedApi, authorityUuid: string, raProfile: OwnRef): Promise<void> {
    await assertOwnLive(api, 'raProfiles', raProfile, 'enableOwnRaProfile');
    await apiJson(api, 'PATCH', `/api/v1/authorities/${authorityUuid}/raProfiles/${raProfile.uuid}/enable`);
}

/**
 * The connectors whose authorities may issue the run's certificates, in this order (MS ADCS, EJBCA-NG, PyADCS):
 * REG_CA_CONNECTORS (comma list of connector registration names) overrides it.
 */
export function caConnectorOrder(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = env.REG_CA_CONNECTORS ?? `${env.REG_ADCS_CONNECTOR ?? 'MS-ADCS-NG-Connector'},EJBCA-NG-Connector,PyADCS-Connector`;
    return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

/** Thrown when no healthy authority with an enabled RA profile exists to copy from: the caller skips with `reason`. */
export class RaProfileSourceMissing extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'RaProfileSourceMissing';
    }
}

export interface RaProfileSource {
    /** The RA profile whose attributes are copied (read-only; it existed before the run, or is this run's own). */
    uuid: string;
    authorityUuid: string;
    connectorName: string;
}

/**
 * The first healthy CA in `caConnectorOrder()` that has a connected authority (not a run object) with an ENABLED RA
 * profile (not a run object) to copy — the first such RA profile by name (deterministic) —: health is read live and by
 * version (connectorApi). Read-only. Returns the source or `{ skip }` with one reason per connector ("deploy gate": a
 * skip, never a pass).
 */
export async function pickHealthyAuthority(api: APIRequestContext, env: NodeJS.ProcessEnv = process.env): Promise<RaProfileSource | { skip: string }> {
    const connectors = await listConnectors(api);
    const authorities = await apiJson<Json[]>(api, 'GET', '/api/v1/authorities');
    const raProfiles = await apiJson<Json[]>(api, 'GET', '/api/v1/raProfiles');
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
        // The candidates sorted by name (code points), so the copy source does not depend on the list order.
        const byName = (a: Json, b: Json): number => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0);
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
 * The body `POST /v1/authorities/{a}/raProfiles` takes for a new RA profile whose connector attributes are COPIED from the
 * source RA profile (read-only: one GET of its detail; nothing on the source changes), plus the tier's required custom attributes.
 */
export async function raProfileBodyLike(api: APIRequestContext, source: Pick<RaProfileSource, 'uuid' | 'authorityUuid'>, name: string, description = `REG run ${runId()}`): Promise<Json> {
    const detail = await apiJson<Json>(api, 'GET', `/api/v1/authorities/${source.authorityUuid}/raProfiles/${source.uuid}`);
    return {
        name,
        description,
        attributes: (detail.attributes ?? []).filter((a: Json) => !a.type || a.type === 'data').map(toRequestAttribute),
        customAttributes: await requiredCustomAttributes(api, 'raProfiles', runName('ca')),
    };
}

/**
 * A new RA profile of the run on the source's authority whose connector attributes are COPIED from the source RA profile
 * (`raProfileBodyLike`). Created disabled (core default, RA-1); `createOwnRaProfileLike` records and enables it. The authority
 * is a scope parent of the create (`POST /v1/authorities/{a}/raProfiles` is on the guard's create list): an own RA profile may
 * live under a pre-existing authority.
 */
export async function createRaProfileLike(api: GuardedApi, source: Pick<RaProfileSource, 'uuid' | 'authorityUuid'>, name: string): Promise<Ref> {
    const created = await apiJson<Json>(api, 'POST', `/api/v1/authorities/${source.authorityUuid}/raProfiles`, await raProfileBodyLike(api, source, name));
    return { uuid: created.uuid, name };
}

/**
 * The one creator every other function of this module ends in: a NEW RA profile like `source`, recorded in the ledger right
 * after the create (with its authority as parent), then enabled (RA profiles are created disabled).
 */
export async function createOwnRaProfileLike(api: GuardedApi, spec: string, source: Pick<RaProfileSource, 'uuid' | 'authorityUuid'>, name: string, note: string): Promise<OwnRaProfile> {
    const ref = recordCreated('raProfiles', await createRaProfileLike(api, source, name), spec, note, { authority: source.authorityUuid });
    await enableOwnRaProfile(api, source.authorityUuid, ref);
    return { ...ref, authorityUuid: source.authorityUuid };
}

/**
 * The run's RA profile, CA-agnostic: the run state's when a flow already made it (REG-CFG-03 on a healthy MS ADCS
 * tier); REG_RA_PROFILE_NAME on a local stack (issue-only parent); otherwise a NEW own RA profile copied from an
 * enabled RA profile of the first healthy CA (`pickHealthyAuthority`: MS ADCS, else EJBCA-NG, else PyADCS), enabled.
 * When no CA qualifies it throws RaProfileSourceMissing (callers skip with its reason: `ensureRunRaProfileOrSkip`).
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
    const ra = await createOwnRaProfileLike(api, spec, pick, runName('ra'), `API prerequisite; connector attributes copied from an enabled RA profile on ${pick.connectorName}`);
    updateRunState({ raProfile: ra });
    return ra;
}

/**
 * ensureRunRaProfile, with the deploy gate as a skip: `skip` is called with the reason when no CA qualifies (pass
 * `(reason) => test.skip(true, reason)`); every other error propagates.
 */
export async function ensureRunRaProfileOrSkip(api: GuardedApi, spec: string, skip: (reason: string) => void): Promise<RunRaProfile> {
    return orSkipWithoutCa(ensureRunRaProfile(api, spec), skip);
}

/** Any work that needs a CA-backed RA profile (ensureOwnRaProfile, ensureAcmeOnRaProfile, …), with the deploy gate as a skip. */
export async function orSkipWithoutCa<T>(work: Promise<T>, skip: (reason: string) => void): Promise<T> {
    try {
        return await work;
    } catch (e) {
        if (e instanceof RaProfileSourceMissing) skip(e.reason);
        throw e;
    }
}

/** The ledger's own RA profile of this run with this exact name (created, not deleted), or undefined. */
function ownRaProfileNamed(name: string): OwnRaProfile | undefined {
    const lines: LedgerLine[] = readLedger().filter((l) => l.runId === runId() && l.type === 'raProfiles' && l.name === name);
    const created = [...lines].reverse().find((l) => l.event === 'created');
    if (!created || !checkOwnership(created).own) return undefined;
    const authority = created.parents?.authority;
    const authorityUuid = Array.isArray(authority) ? authority[0] : authority;
    return authorityUuid ? { uuid: created.uuid, name: created.name, kind: 'own', authorityUuid } : undefined;
}

/**
 * An RA profile this run CREATED, for flows that change the RA profile (protocol activation): the run RA profile when
 * it is own; for an issue-only parent (REG_RA_PROFILE_NAME, local stack) an own clone of it (`<run>-ra-own`, connector
 * attributes copied read-only, enabled), found again through the ledger on later calls. Nothing is ever activated
 * on the issue-only parent itself.
 */
export async function ensureOwnRaProfile(api: GuardedApi, spec: string): Promise<OwnRaProfile> {
    const ra = await ensureRunRaProfile(api, spec);
    if (!isIssueOnly(ra)) return ra;
    const name = runName('ra-own');
    const known = ownRaProfileNamed(name);
    if (known) return known;
    return createOwnRaProfileLike(api, spec, ra, name, 'own clone of the issue-only RA profile (REG_RA_PROFILE_NAME): protocol activation needs an own RA profile');
}

/**
 * The dedicated RA profile of a protocol flow (plan: RA*), `<run>-ra-<label>`: created once per run and label (found
 * again through the ledger on a re-run or under `--repeat-each`), enabled, a copy of the run RA profile's attributes.
 * Throws `RaProfileSourceMissing` like `ensureRunRaProfile` when no CA can issue (the spec skips with that reason).
 */
export async function ensureProtocolRaProfile(api: GuardedApi, spec: string, label: string): Promise<OwnRaProfile> {
    if (!/^[a-z0-9-]+$/.test(label)) throw new Error(`ensureProtocolRaProfile: label "${label}" must be [a-z0-9-] (it is part of a URL path)`);
    const name = runName(`ra-${label}`);
    const known = ownRaProfileNamed(name);
    if (known) return known;
    const runRa = await ensureRunRaProfile(api, spec);
    return createOwnRaProfileLike(api, spec, runRa, name, `dedicated RA profile of the ${label} protocol flow (RA*): attributes copied read-only from the run RA profile`);
}

/**
 * An OWN, ENABLED clone of the run RA profile (`RA+`): the same authority and connector attributes (read-only copy), an
 * own name. Flags and associations are flipped on the clone only, never on the run RA profile.
 */
export async function cloneRunRaProfile(api: GuardedApi, spec: string, suffix: string): Promise<OwnRaProfile> {
    const run = await ensureRunRaProfile(api, spec);
    return createOwnRaProfileLike(api, spec, run, runName(`ra-${suffix}-${timestampSuffix()}`), `RA+ clone of the run RA profile (${suffix})`);
}

/**
 * A NEW own RA profile (a clone of an enabled RA profile of the first healthy CA, enabled) for one row: event associations
 * and triggers hang on it alone, named `<run>-<suffix>-<time>`. Throws RaProfileSourceMissing when no CA qualifies (the caller
 * skips with its reason).
 */
export async function createOwnRaProfile(api: GuardedApi, spec: string, suffix: string): Promise<OwnRaProfile> {
    const pick = await pickHealthyAuthority(api);
    if ('skip' in pick) throw new RaProfileSourceMissing(pick.skip);
    return createOwnRaProfileLike(api, spec, pick, ownName(suffix), `own RA profile of an event row; attributes copied read-only from an enabled RA profile on ${pick.connectorName}`);
}

/** `createOwnRaProfile` with the deploy gate as a skip: `skip` is called with the reason when no CA qualifies. */
export async function createOwnRaProfileOrSkip(api: GuardedApi, spec: string, suffix: string, skip: (reason: string) => void): Promise<OwnRaProfile> {
    return orSkipWithoutCa(createOwnRaProfile(api, spec, suffix), skip);
}

/** The run's own RA profile with the run's ACME profile activated on it; returns the RA-profile directory URL. */
export async function ensureAcmeOnRaProfile(api: GuardedApi, spec: string): Promise<{ raProfile: OwnRaProfile; acmeProfile: OwnRef & { identifier: string }; directoryUrl: string }> {
    const ra = await ensureOwnRaProfile(api, spec);
    const acmeProfile = await ensureAcmeProfile(api, spec);
    if (readRunState().acmeActivatedOn !== ra.uuid) {
        await activateAcmeOnOwnRaProfile(api, ra.authorityUuid, ra, acmeProfile);
        updateRunState({ acmeActivatedOn: ra.uuid });
    }
    const acme = await apiJson<Json>(api, 'GET', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/acme`);
    expect(acme.acmeAvailable, 'ACME should be available on the run RA profile').toBe(true);
    logger.info(`ACME directory: ${acme.directoryUrl}`);
    return { raProfile: ra, acmeProfile, directoryUrl: acme.directoryUrl };
}
