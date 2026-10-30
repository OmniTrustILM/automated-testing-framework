/**
 * protocolProfiles — own SCEP and CMP profiles.
 *
 * Creates (recorded before any assertion), enables, activates on an own RA profile and deactivates them, plus the teardown
 * handlers for `scepProfiles` / `cmpProfiles`. Activation is only sent for an RA profile and a protocol profile this run
 * created (`assertOwnLive` on both), so the run RA profile and every pre-existing object stay untouched.
 */
import * as crypto from 'crypto';
import { Logger } from '../../Logger';
import { GuardedApi } from '../guard/types';
import { guardApi } from '../guard/createGuard';
import { assertOwnLive, checkOwnership } from '../ledger/ownership';
import { OwnRaProfile } from '../ownRaProfiles';
import { apiJson } from '../apiReads';
import { requiredCustomAttributes } from '../customAttributes';
import { LedgerLine, OwnRef } from '../ledger/ledger';
import { runName, runId, ownName } from '../ledger/runState';
import type { TeardownContext, TeardownHandler } from '../teardown/runTeardown';
import { deleteAndVerify } from '../teardown/teardownHandlers';
import type { JsonObject } from '../json';
import { createOwn } from '../ownCrud';

const logger = new Logger('ProtocolProfiles');

type ProtocolKind = 'scep' | 'cmp';

/** A random shared secret / challenge password in `[A-Za-z0-9_-]` (never logged, never in a name). */
export const randomSecret = (bytes = 18): string => crypto.randomBytes(bytes).toString('base64url');

const parentOf = (line: LedgerLine, key: string): string | undefined => {
    const v = line.parents?.[key];
    return Array.isArray(v) ? v[0] : v;
};

// ------------------------------------------------------------------ SCEP

export interface ScepProfileOptions {
    /** A planned name; default `ownName(suffix)`. */
    name?: string;
    note?: string;
    /** An OWN certificate (the protocol CA): the guard needs its ledger line (BODY_FIELD_TYPES caCertificateUuid). */
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

/**
 * `POST /v1/scepProfiles` (ScepProfileRequestDto); the profile is created DISABLED. Recorded (ledger before any assertion); parents: the CA
 * certificate and the default RA profile.
 */
export async function createOwnScepProfile(api: GuardedApi, spec: string, suffix: string, o: ScepProfileOptions): Promise<OwnRef> {
    const { answer: _answer, ...ref } = await createOwn(api, spec, {
        type: 'scepProfiles',
        path: '/api/v1/scepProfiles',
        name: o.name ?? ownName(suffix),
        note: o.note ?? 'SCEP profile of the protocol rows',
        parents: { caCertificate: o.caCertificateUuid, ...(o.raProfileUuid ? { raProfile: o.raProfileUuid } : {}) },
        body: {
            description: o.description ?? `REG run ${runId()}`,
            ...(o.raProfileUuid ? { raProfileUuid: o.raProfileUuid } : {}),
            issueCertificateAttributes: [],
            caCertificateUuid: o.caCertificateUuid,
            customAttributes: await requiredCustomAttributes(api, 'scepProfiles', runName('ca')),
            ...(o.renewalThreshold !== undefined ? { renewalThreshold: o.renewalThreshold } : {}),
            includeCaCertificate: o.includeCaCertificate ?? false,
            includeCaCertificateChain: o.includeCaCertificateChain ?? false,
            ...(o.challengePassword !== undefined ? { challengePassword: o.challengePassword, enableChallengePassword: true } : {}),
        },
    });
    return ref;
}

export async function enableOwnScepProfile(api: GuardedApi, scep: OwnRef): Promise<void> {
    await assertOwnLive(api, 'scepProfiles', scep, 'enableOwnScepProfile');
    await apiJson(api, 'PATCH', `/api/v1/scepProfiles/${scep.uuid}/enable`);
}

async function disableOwnScepProfile(api: GuardedApi, scep: OwnRef): Promise<void> {
    await assertOwnLive(api, 'scepProfiles', scep, 'disableOwnScepProfile');
    await apiJson(api, 'PATCH', `/api/v1/scepProfiles/${scep.uuid}/disable`);
}

export interface ScepActivation {
    scepAvailable: boolean;
    /** `…/v1/protocols/scep/raProfile/<ra>/pkiclient.exe`. */
    url?: string;
}

/** `PATCH …/raProfiles/{own}/protocols/scep/activate/{own scep}` (ActivateScepForRaProfileRequestDto). */
async function activateScepOnOwnRaProfile(api: GuardedApi, ra: OwnRaProfile, scep: OwnRef): Promise<ScepActivation> {
    await assertOwnLive(api, 'raProfiles', ra, 'activateScepOnOwnRaProfile (RA profile)');
    await assertOwnLive(api, 'scepProfiles', scep, 'activateScepOnOwnRaProfile (SCEP profile)');
    const res = await apiJson<JsonObject>(api, 'PATCH', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/scep/activate/${scep.uuid}`, { issueCertificateAttributes: [] });
    return { scepAvailable: !!res?.scepAvailable, url: typeof res?.url === 'string' ? res.url : undefined };
}

async function deactivateScepOnOwnRaProfile(api: GuardedApi, ra: OwnRaProfile): Promise<void> {
    await assertOwnLive(api, 'raProfiles', ra, 'deactivateScepOnOwnRaProfile');
    await apiJson(api, 'PATCH', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/scep/deactivate`);
}

/** `GET …/protocols/scep` of an RA profile (read-only). */
async function scepOnRaProfile(api: GuardedApi, authorityUuid: string, raProfileUuid: string): Promise<ScepActivation & JsonObject> {
    return apiJson<ScepActivation & JsonObject>(api, 'GET', `/api/v1/authorities/${authorityUuid}/raProfiles/${raProfileUuid}/protocols/scep`);
}

/** The profile-based SCEP URL; `base` = BASE_URL without a trailing slash. */
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

type CmpVariant = 'v2' | 'v2_3gpp' | 'v3';
type ProtectionMethod = 'sharedSecret' | 'signature';

export interface CmpProfileOptions {
    /** A planned name; default `ownName(suffix)`. */
    name?: string;
    note?: string;
    variant?: CmpVariant;
    requestProtectionMethod?: ProtectionMethod;
    responseProtectionMethod?: ProtectionMethod;
    /** Needed when the request protection is sharedSecret. */
    sharedSecret?: string;
    /** Needed when the response protection is signature (an OWN certificate). */
    signingCertificateUuid?: string;
    raProfileUuid?: string;
    description?: string;
}

/**
 * `POST /v1/cmpProfiles` (CmpProfileRequestDto); created DISABLED. Default: v2 / sharedSecret / sharedSecret. Recorded before any
 * assertion.
 */
export async function createOwnCmpProfile(api: GuardedApi, spec: string, suffix: string, o: CmpProfileOptions = {}): Promise<OwnRef> {
    const request = o.requestProtectionMethod ?? 'sharedSecret';
    const response = o.responseProtectionMethod ?? 'sharedSecret';
    if (request === 'sharedSecret' && !o.sharedSecret) throw new Error('createOwnCmpProfile: a sharedSecret request protection needs a secret');
    const { answer: _answer, ...ref } = await createOwn(api, spec, {
        type: 'cmpProfiles',
        path: '/api/v1/cmpProfiles',
        name: o.name ?? ownName(suffix),
        note: o.note ?? 'CMP profile of the protocol rows',
        parents: {
            ...(o.raProfileUuid ? { raProfile: o.raProfileUuid } : {}),
            ...(o.signingCertificateUuid ? { signingCertificate: o.signingCertificateUuid } : {}),
        },
        body: {
            description: o.description ?? `REG run ${runId()}`,
            variant: o.variant ?? 'v2',
            ...(o.raProfileUuid ? { raProfileUuid: o.raProfileUuid, issueCertificateAttributes: [], revokeCertificateAttributes: [] } : {}),
            customAttributes: await requiredCustomAttributes(api, 'cmpProfiles', runName('ca')),
            requestProtectionMethod: request,
            responseProtectionMethod: response,
            ...(o.sharedSecret ? { sharedSecret: o.sharedSecret } : {}),
            ...(o.signingCertificateUuid ? { signingCertificateUuid: o.signingCertificateUuid } : {}),
        },
    });
    return ref;
}

export async function enableOwnCmpProfile(api: GuardedApi, cmp: OwnRef): Promise<void> {
    await assertOwnLive(api, 'cmpProfiles', cmp, 'enableOwnCmpProfile');
    await apiJson(api, 'PATCH', `/api/v1/cmpProfiles/${cmp.uuid}/enable`);
}

async function disableOwnCmpProfile(api: GuardedApi, cmp: OwnRef): Promise<void> {
    await assertOwnLive(api, 'cmpProfiles', cmp, 'disableOwnCmpProfile');
    await apiJson(api, 'PATCH', `/api/v1/cmpProfiles/${cmp.uuid}/disable`);
}

export interface CmpActivation {
    cmpAvailable: boolean;
    /** `…/v1/protocols/cmp/raProfile/<ra>`. */
    cmpUrl?: string;
}

/** `PATCH …/raProfiles/{own}/protocols/cmp/activate/{own cmp}` (ActivateCmpForRaProfileRequestDto). */
export async function activateCmpOnOwnRaProfile(api: GuardedApi, ra: OwnRaProfile, cmp: OwnRef): Promise<CmpActivation> {
    await assertOwnLive(api, 'raProfiles', ra, 'activateCmpOnOwnRaProfile (RA profile)');
    await assertOwnLive(api, 'cmpProfiles', cmp, 'activateCmpOnOwnRaProfile (CMP profile)');
    const res = await apiJson<JsonObject>(api, 'PATCH', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/cmp/activate/${cmp.uuid}`, {
        issueCertificateAttributes: [],
        revokeCertificateAttributes: [],
    });
    return { cmpAvailable: !!res?.cmpAvailable, cmpUrl: typeof res?.cmpUrl === 'string' ? res.cmpUrl : undefined };
}

async function deactivateCmpOnOwnRaProfile(api: GuardedApi, ra: OwnRaProfile): Promise<void> {
    await assertOwnLive(api, 'raProfiles', ra, 'deactivateCmpOnOwnRaProfile');
    await apiJson(api, 'PATCH', `/api/v1/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/protocols/cmp/deactivate`);
}

async function cmpOnRaProfile(api: GuardedApi, authorityUuid: string, raProfileUuid: string): Promise<CmpActivation & JsonObject> {
    return apiJson<CmpActivation & JsonObject>(api, 'GET', `/api/v1/authorities/${authorityUuid}/raProfiles/${raProfileUuid}/protocols/cmp`);
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

// ------------------------------------------------------------- run-end teardown (registry: scepProfiles / cmpProfiles → protocolProfiles)

/** The authority of an RA profile: the ledger's parents, else the RA profile detail (read-only). */
async function authorityOf(ctx: TeardownContext, raProfileUuid: string): Promise<string | undefined> {
    const own = ctx.ledger.find((l) => l.uuid === raProfileUuid && l.event === 'created');
    const fromLedger = own && parentOf(own, 'authority');
    if (fromLedger) return fromLedger;
    const res = await ctx.api.get(`/api/v1/raProfiles/${raProfileUuid}`);
    if (!res.ok()) return undefined;
    const authority = ((await res.json()) as JsonObject).authorityInstanceUuid;
    return typeof authority === 'string' ? authority : undefined;
}

/** Live (created, not deleted) own RA profiles of this run: the only places a protocol can be active for us. */
function liveOwnRaProfiles(ctx: TeardownContext): LedgerLine[] {
    return ctx.ledger.filter((l) => l.type === 'raProfiles' && l.event === 'created' && checkOwnership(l, { lines: ctx.ledger, runId: ctx.runId }).own);
}

/**
 * Deactivates `kind` on every own RA profile the profile `line` is active on (each RA profile checked live), through
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
        const info = (await res.json()) as JsonObject;
        const available = kind === 'scep' ? info.scepAvailable : info.cmpAvailable;
        if (!available || (info.uuid !== line.uuid && info.name !== line.name)) continue;
        // The deactivation changes the RA profile: it must be this run's, live.
        await assertOwnLive(ctx.api, 'raProfiles', { uuid: raUuid }, `teardown.${kind}Profiles (deactivate)`, {
            lines: ctx.ledger, runId: ctx.runId, tier: ctx.tier, env: {}, ...(ctx.knownBug ? { onKnownBug: ctx.knownBug } : {}),
        });
        ctx.seen.add(raUuid);
        const resp = await api.patch(`/api/v1/authorities/${authorityUuid}/raProfiles/${raUuid}/protocols/${kind}/deactivate`);
        // A 404 here follows a 200 read of both objects in this step: the activation is gone already.
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
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `SCEP profile ${line.uuid}`, detailUrl: `/api/v1/scepProfiles/${line.uuid}` });
    },
};

const cmpProfiles: TeardownHandler = {
    action: 'deactivate on every own RA profile it is active on (each checked live), then DELETE /v1/cmpProfiles/{uuid}; absence proven by GET',
    async remove(ctx, line) {
        await deactivateOnOwnRaProfiles(ctx, 'cmp', line);
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `CMP profile ${line.uuid}`, detailUrl: `/api/v1/cmpProfiles/${line.uuid}` });
    },
};

/** The raw handlers; runTeardown wraps each with wrapHandlerWithGuard when it loads this module. */
export const teardownHandlers: Record<string, TeardownHandler> = { scepProfiles, cmpProfiles };
