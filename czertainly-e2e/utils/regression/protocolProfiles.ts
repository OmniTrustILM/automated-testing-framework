/**
 * protocolProfiles — SCEP and CMP profiles of the REG-PROT / API-PROT rows: create (run-prefixed, recorded in the
 * ledger before any assertion), enable, activate on an OWN RA profile, deactivate, and the run-end teardown handlers
 * the registry loads for the ledger types `scepProfiles` / `cmpProfiles` (runTeardown HANDLER_MODULES).
 *
 * Rules kept (decisions Q1, D1, M4): protocol activation only on an RA profile this run created (`assertOwnLive` on
 * the RA profile AND the protocol profile before the PATCH); the dedicated RA profile of a protocol (plan: RA*) is a
 * copy of the run RA profile's connector attributes under the same pre-existing authority (`createRaProfileLike`,
 * read-only on the source), so flipping, activating or deactivating never touches the run RA profile other specs
 * issue through, nor anything pre-existing. The CA certificate of a SCEP profile and the RA profile of either are own
 * objects (the guard types `caCertificateUuid` / `raProfileUuid`: BODY_FIELD_TYPES).
 */
import * as crypto from 'crypto';
import { Logger } from '../Logger';
import { GuardedApi, guardApi } from './guardedApi';
import { assertOwnLive, ownership } from './ownObjects';
import { apiJson, createRaProfileLike, enableOwnRaProfile, ensureRaProfile, requiredCustomAttributes } from './regressionApi';
import { LedgerLine, OwnRef, readLedger, recordCreated, Ref, regName, RUN_ID } from './regressionRun';
import type { TeardownContext, TeardownHandler } from './runTeardown';
import { deleteVerified } from './teardownHandlers';

const logger = new Logger('ProtocolProfiles');

type Json = Record<string, any>;

export type ProtocolKind = 'scep' | 'cmp';

export interface OwnRaProfile extends OwnRef {
    authorityUuid: string;
}

/** A random shared secret / challenge password in `[A-Za-z0-9_-]` (never logged, never in a name). */
export const randomSecret = (bytes = 18): string => crypto.randomBytes(bytes).toString('base64url');

/** The ledger line of an object this run created, by type and name (the newest `created` line, if still own). */
function ownLedgerLine(type: string, name: string): LedgerLine | undefined {
    const lines = readLedger().filter((l) => l.runId === RUN_ID && l.type === type && l.name === name);
    const created = [...lines].reverse().find((l) => l.event === 'created');
    return created && ownership(created).own ? created : undefined;
}

const parentOf = (line: LedgerLine, key: string): string | undefined => {
    const v = line.parents?.[key];
    return Array.isArray(v) ? v[0] : v;
};

/** Required custom attributes of a resource: the ONE shared helper of regressionApi (version + contentType on every item). */
export const requiredCustomAttributesOf = (api: GuardedApi, resource: string, value: string): Promise<Json[]> => requiredCustomAttributes(api, resource, value);

/**
 * The dedicated RA profile of a protocol flow (plan: RA*), `<run>-ra-<label>`: created once per run and label (found
 * again through the ledger on a re-run or under `--repeat-each`), enabled, a copy of the run RA profile's attributes.
 * Throws `RaProfileSourceMissing` like `ensureRaProfile` when no CA can issue (the spec skips with that reason).
 */
export async function ensureProtocolRaProfile(api: GuardedApi, spec: string, label: string): Promise<OwnRaProfile> {
    if (!/^[a-z0-9-]+$/.test(label)) throw new Error(`ensureProtocolRaProfile: label "${label}" must be [a-z0-9-] (it is part of a URL path)`);
    const name = regName(`ra-${label}`);
    const known = ownLedgerLine('raProfiles', name);
    const knownAuthority = known && parentOf(known, 'authority');
    if (known && knownAuthority) return { uuid: known.uuid, name: known.name, kind: 'own', authorityUuid: knownAuthority };
    const runRa = await ensureRaProfile(api, spec);
    const ref = recordCreated('raProfiles', await createRaProfileLike(api, runRa, name), spec,
        `dedicated RA profile of the ${label} protocol flow (RA*): attributes copied read-only from the run RA profile`, { authority: runRa.authorityUuid });
    await enableOwnRaProfile(api, runRa.authorityUuid, ref);
    return { ...ref, authorityUuid: runRa.authorityUuid };
}

// ------------------------------------------------------------------ SCEP

export interface ScepProfileOptions {
    name: string;
    /** An OWN certificate (F-CA): the guard needs its ledger line (BODY_FIELD_TYPES caCertificateUuid). */
    caCertificateUuid: string;
    /** Sets `enableChallengePassword=true` with this password; absent = no password protection. */
    challengePassword?: string;
    /** An own RA profile as the default RA profile (profile-based URL); absent = none. */
    raProfileUuid?: string;
    includeCaCertificate?: boolean;
    includeCaCertificateChain?: boolean;
    renewalThreshold?: number;
    description?: string;
}

/** `POST /v1/scepProfiles` (ScepProfileRequestDto); the profile is created DISABLED (rules §7.2 r8). */
export async function createScepProfile(api: GuardedApi, o: ScepProfileOptions): Promise<Ref> {
    const created = await apiJson<Json>(api, 'POST', '/api/v1/scepProfiles', {
        name: o.name,
        description: o.description ?? `REG run ${RUN_ID}`,
        ...(o.raProfileUuid ? { raProfileUuid: o.raProfileUuid } : {}),
        issueCertificateAttributes: [],
        caCertificateUuid: o.caCertificateUuid,
        customAttributes: await requiredCustomAttributesOf(api, 'scepProfiles', regName('ca')),
        ...(o.renewalThreshold !== undefined ? { renewalThreshold: o.renewalThreshold } : {}),
        includeCaCertificate: o.includeCaCertificate ?? false,
        includeCaCertificateChain: o.includeCaCertificateChain ?? false,
        ...(o.challengePassword !== undefined ? { challengePassword: o.challengePassword, enableChallengePassword: true } : {}),
    });
    return { uuid: String(created.uuid), name: o.name };
}

/** Create and record (ledger before any assertion); parents: the CA certificate and the default RA profile. */
export async function createOwnScepProfile(api: GuardedApi, spec: string, o: ScepProfileOptions, note = 'SCEP profile of the protocol rows'): Promise<OwnRef> {
    const ref = await createScepProfile(api, o);
    return recordCreated('scepProfiles', ref, spec, note, { caCertificate: o.caCertificateUuid, ...(o.raProfileUuid ? { raProfile: o.raProfileUuid } : {}) });
}

export async function enableOwnScepProfile(api: GuardedApi, scep: OwnRef): Promise<void> {
    await assertOwnLive(api, 'scepProfiles', scep, 'enableOwnScepProfile');
    await apiJson(api, 'PATCH', `/api/v1/scepProfiles/${scep.uuid}/enable`);
}

export async function disableOwnScepProfile(api: GuardedApi, scep: OwnRef): Promise<void> {
    await assertOwnLive(api, 'scepProfiles', scep, 'disableOwnScepProfile');
    await apiJson(api, 'PATCH', `/api/v1/scepProfiles/${scep.uuid}/disable`);
}

export interface ScepActivation {
    scepAvailable: boolean;
    /** `…/v1/protocols/scep/raProfile/<ra>/pkiclient.exe` (rules §7.2 r10). */
    url?: string;
}

/** `PATCH …/raProfiles/{own}/protocols/scep/activate/{own scep}` (ActivateScepForRaProfileRequestDto). */
export async function activateScepOnOwnRaProfile(api: GuardedApi, ra: OwnRaProfile, scep: OwnRef): Promise<ScepActivation> {
    await assertOwnLive(api, 'raProfiles', ra, 'activateScepOnOwnRaProfile (RA profile)');
    await assertOwnLive(api, 'scepProfiles', scep, 'activateScepOnOwnRaProfile (SCEP profile)');
    const res = await apiJson<Json>(api, 'PATCH', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/scep/activate/${scep.uuid}`, { issueCertificateAttributes: [] });
    return { scepAvailable: !!res?.scepAvailable, url: res?.url };
}

export async function deactivateScepOnOwnRaProfile(api: GuardedApi, ra: OwnRaProfile): Promise<void> {
    await assertOwnLive(api, 'raProfiles', ra, 'deactivateScepOnOwnRaProfile');
    await apiJson(api, 'PATCH', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/scep/deactivate`);
}

/** `GET …/protocols/scep` of an RA profile (read-only). */
export async function scepOnRaProfile(api: GuardedApi, authorityUuid: string, raProfileUuid: string): Promise<ScepActivation & Json> {
    return apiJson<ScepActivation & Json>(api, 'GET', `/api/v1/authorities/${authorityUuid}/raProfiles/${raProfileUuid}/protocols/scep`);
}

/** The profile-based SCEP URL (rules §7.2 endpoint); `base` = BASE_URL without a trailing slash. */
export const scepProfileUrl = (base: string, profileName: string): string => `${base.replace(/\/$/, '')}/api/v1/protocols/scep/${profileName}/pkiclient.exe`;

/**
 * Makes `GET …/protocols/scep` of the own RA profile true, activating when it is not (idempotent per RA profile).
 * Returns the URL the server reports.
 */
export async function ensureScepActiveOnOwnRaProfile(api: GuardedApi, ra: OwnRaProfile, scep: OwnRef): Promise<string> {
    const current = await scepOnRaProfile(api, ra.authorityUuid, ra.uuid);
    if (current.scepAvailable && current.url && (current.uuid === scep.uuid || current.name === scep.name)) return current.url;
    const activated = await activateScepOnOwnRaProfile(api, ra, scep);
    if (!activated.scepAvailable || !activated.url) throw new Error(`SCEP activation on ${ra.name} did not report scepAvailable + url: ${JSON.stringify(activated)}`);
    return activated.url;
}

// ------------------------------------------------------------------ CMP

export type CmpVariant = 'v2' | 'v2_3gpp' | 'v3';
export type ProtectionMethod = 'sharedSecret' | 'signature';

export interface CmpProfileOptions {
    name: string;
    variant?: CmpVariant;
    requestProtectionMethod?: ProtectionMethod;
    responseProtectionMethod?: ProtectionMethod;
    /** Needed when the request protection is sharedSecret (rules §8.2 r3). */
    sharedSecret?: string;
    /** Needed when the response protection is signature (an OWN certificate). */
    signingCertificateUuid?: string;
    raProfileUuid?: string;
    description?: string;
}

/** `POST /v1/cmpProfiles` (CmpProfileRequestDto); created DISABLED (rules §8.2 r5). Default: v2 / sharedSecret / sharedSecret. */
export async function createCmpProfile(api: GuardedApi, o: CmpProfileOptions): Promise<Ref> {
    const request = o.requestProtectionMethod ?? 'sharedSecret';
    const response = o.responseProtectionMethod ?? 'sharedSecret';
    if (request === 'sharedSecret' && !o.sharedSecret) throw new Error('createCmpProfile: a sharedSecret request protection needs a secret');
    const created = await apiJson<Json>(api, 'POST', '/api/v1/cmpProfiles', {
        name: o.name,
        description: o.description ?? `REG run ${RUN_ID}`,
        variant: o.variant ?? 'v2',
        ...(o.raProfileUuid ? { raProfileUuid: o.raProfileUuid, issueCertificateAttributes: [], revokeCertificateAttributes: [] } : {}),
        customAttributes: await requiredCustomAttributesOf(api, 'cmpProfiles', regName('ca')),
        requestProtectionMethod: request,
        responseProtectionMethod: response,
        ...(o.sharedSecret ? { sharedSecret: o.sharedSecret } : {}),
        ...(o.signingCertificateUuid ? { signingCertificateUuid: o.signingCertificateUuid } : {}),
    });
    return { uuid: String(created.uuid), name: o.name };
}

export async function createOwnCmpProfile(api: GuardedApi, spec: string, o: CmpProfileOptions, note = 'CMP profile of the protocol rows'): Promise<OwnRef> {
    const ref = await createCmpProfile(api, o);
    return recordCreated('cmpProfiles', ref, spec, note, {
        ...(o.raProfileUuid ? { raProfile: o.raProfileUuid } : {}),
        ...(o.signingCertificateUuid ? { signingCertificate: o.signingCertificateUuid } : {}),
    });
}

export async function enableOwnCmpProfile(api: GuardedApi, cmp: OwnRef): Promise<void> {
    await assertOwnLive(api, 'cmpProfiles', cmp, 'enableOwnCmpProfile');
    await apiJson(api, 'PATCH', `/api/v1/cmpProfiles/${cmp.uuid}/enable`);
}

export async function disableOwnCmpProfile(api: GuardedApi, cmp: OwnRef): Promise<void> {
    await assertOwnLive(api, 'cmpProfiles', cmp, 'disableOwnCmpProfile');
    await apiJson(api, 'PATCH', `/api/v1/cmpProfiles/${cmp.uuid}/disable`);
}

export interface CmpActivation {
    cmpAvailable: boolean;
    /** `…/v1/protocols/cmp/raProfile/<ra>` (rules §8.2 r5). */
    cmpUrl?: string;
}

/** `PATCH …/raProfiles/{own}/protocols/cmp/activate/{own cmp}` (ActivateCmpForRaProfileRequestDto). */
export async function activateCmpOnOwnRaProfile(api: GuardedApi, ra: OwnRaProfile, cmp: OwnRef): Promise<CmpActivation> {
    await assertOwnLive(api, 'raProfiles', ra, 'activateCmpOnOwnRaProfile (RA profile)');
    await assertOwnLive(api, 'cmpProfiles', cmp, 'activateCmpOnOwnRaProfile (CMP profile)');
    const res = await apiJson<Json>(api, 'PATCH', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/cmp/activate/${cmp.uuid}`, {
        issueCertificateAttributes: [],
        revokeCertificateAttributes: [],
    });
    return { cmpAvailable: !!res?.cmpAvailable, cmpUrl: res?.cmpUrl };
}

export async function deactivateCmpOnOwnRaProfile(api: GuardedApi, ra: OwnRaProfile): Promise<void> {
    await assertOwnLive(api, 'raProfiles', ra, 'deactivateCmpOnOwnRaProfile');
    await apiJson(api, 'PATCH', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/cmp/deactivate`);
}

export async function cmpOnRaProfile(api: GuardedApi, authorityUuid: string, raProfileUuid: string): Promise<CmpActivation & Json> {
    return apiJson<CmpActivation & Json>(api, 'GET', `/api/v1/authorities/${authorityUuid}/raProfiles/${raProfileUuid}/protocols/cmp`);
}

export const cmpProfileUrl = (base: string, profileName: string): string => `${base.replace(/\/$/, '')}/api/v1/protocols/cmp/${profileName}`;

export async function ensureCmpActiveOnOwnRaProfile(api: GuardedApi, ra: OwnRaProfile, cmp: OwnRef): Promise<string> {
    const current = await cmpOnRaProfile(api, ra.authorityUuid, ra.uuid);
    if (current.cmpAvailable && current.cmpUrl && (current.uuid === cmp.uuid || current.name === cmp.name)) return current.cmpUrl;
    const activated = await activateCmpOnOwnRaProfile(api, ra, cmp);
    if (!activated.cmpAvailable || !activated.cmpUrl) throw new Error(`CMP activation on ${ra.name} did not report cmpAvailable + cmpUrl: ${JSON.stringify(activated)}`);
    return activated.cmpUrl;
}

/** The URL path (`/api/…`) of a protocol URL the server reported, for `openssl cmp -path`. */
export function pathOfUrl(url: string): string {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
}

/** The origin (`scheme://host[:port]`) of a protocol URL, for `openssl cmp -server`. */
export const originOfUrl = (url: string): string => new URL(url).origin;

// ------------------------------------------------------------------ run-end teardown (registry: scepProfiles / cmpProfiles → protocolProfiles)

/** The authority of an RA profile: the ledger's parents, else the RA profile detail (read-only). */
async function authorityOf(ctx: TeardownContext, raProfileUuid: string): Promise<string | undefined> {
    const own = ctx.ledger.find((l) => l.uuid === raProfileUuid && l.event === 'created');
    const fromLedger = own && parentOf(own, 'authority');
    if (fromLedger) return fromLedger;
    const res = await ctx.api.get(`/api/v1/raProfiles/${raProfileUuid}`);
    return res.ok() ? ((await res.json()) as Json).authorityInstanceUuid : undefined;
}

/** Live (created, not deleted) own RA profiles of this run: the only places a protocol can be active for us. */
function liveOwnRaProfiles(ctx: TeardownContext): LedgerLine[] {
    return ctx.ledger.filter((l) => l.type === 'raProfiles' && l.event === 'created' && ownership(l, { lines: ctx.ledger, runId: ctx.runId }).own);
}

/**
 * Deactivates `kind` on every own RA profile the profile `line` is active on (each RA profile checked live, R6), through
 * the guard (the teardown's raw context wrapped: the PATCH names an own RA profile and nothing else).
 */
async function deactivateOnOwnRaProfiles(ctx: TeardownContext, kind: ProtocolKind, line: LedgerLine): Promise<void> {
    const candidates = new Set([...(line.parents?.raProfiles ? ([] as string[]).concat(line.parents.raProfiles) : []), ...liveOwnRaProfiles(ctx).map((l) => l.uuid)]);
    const api = guardApi(ctx.api);
    for (const raUuid of candidates) {
        let authorityUuid: string | undefined;
        try {
            authorityUuid = await authorityOf(ctx, raUuid);
        } catch {
            authorityUuid = undefined;
        }
        if (!authorityUuid) continue;
        const res = await ctx.api.get(`/api/v1/authorities/${authorityUuid}/raProfiles/${raUuid}/protocols/${kind}`);
        if (!res.ok()) continue;
        const info = (await res.json()) as Json;
        const available = kind === 'scep' ? info.scepAvailable : info.cmpAvailable;
        if (!available || (info.uuid !== line.uuid && info.name !== line.name)) continue;
        // The deactivation changes the RA profile: it must be this run's, live (R6).
        await assertOwnLive(ctx.api, 'raProfiles', { uuid: raUuid }, `teardown.${kind}Profiles (deactivate)`, {
            lines: ctx.ledger, runId: ctx.runId, tier: ctx.tier, env: {}, ...(ctx.knownBug ? { onKnownBug: ctx.knownBug } : {}),
        });
        ctx.seen.add(raUuid);
        const resp = await api.patch(`/api/v1/authorities/${authorityUuid}/raProfiles/${raUuid}/protocols/${kind}/deactivate`);
        // A 404 here follows a 200 read of both objects in this step (R5): the activation is gone already.
        if (!resp.ok() && resp.status() !== 404) {
            throw new Error(`Failed to deactivate ${kind.toUpperCase()} on RA profile ${raUuid}: ${resp.status()} - ${(await resp.text()).slice(0, 300)}`);
        }
        logger.info(`teardown: ${kind.toUpperCase()} deactivated on own RA profile ${raUuid}`);
    }
}

const scepProfiles: TeardownHandler = {
    action: 'deactivate on every own RA profile it is active on (each checked live), then DELETE /v1/scepProfiles/{uuid}; absence proven by GET',
    async remove(ctx, line) {
        await deactivateOnOwnRaProfiles(ctx, 'scep', line);
        await deleteVerified(ctx, { uuid: line.uuid, what: `SCEP profile ${line.uuid}`, detailUrl: `/api/v1/scepProfiles/${line.uuid}` });
    },
};

const cmpProfiles: TeardownHandler = {
    action: 'deactivate on every own RA profile it is active on (each checked live), then DELETE /v1/cmpProfiles/{uuid}; absence proven by GET',
    async remove(ctx, line) {
        await deactivateOnOwnRaProfiles(ctx, 'cmp', line);
        await deleteVerified(ctx, { uuid: line.uuid, what: `CMP profile ${line.uuid}`, detailUrl: `/api/v1/cmpProfiles/${line.uuid}` });
    },
};

/** The raw handlers; runTeardown wraps each with guardHandler when it loads this module. */
export const teardownHandlers: Record<string, TeardownHandler> = { scepProfiles, cmpProfiles };
