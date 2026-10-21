/**
 * preRegistration — platform-level pre-registration of own certificates (`…/certificates/register`, with or without a
 * challenge), the registration block of a detail, the registration and validation settings of the tier (read, never
 * set), and the re-validation of an own certificate. The placeholder a register makes is recorded before any assertion.
 */
import type { APIRequestContext } from '@playwright/test';
import { apiJson, getCertificate } from '../apiReads';
import { requestVersion } from '../attributeVersion';
import type { GuardedApi } from '../guard/types';
import { Logger } from '../../Logger';
import { assertOwnLive } from '../ledger/ownership';
import type { RaLike } from '../ownRaProfiles';
import { isJsonObject, JsonObject } from '../json';
import { OwnRef, recordCreated } from '../ledger/ledger';
import { runId } from '../ledger/runState';
import { timestampSuffix } from '../text';
import { opsBase } from './certificateLabels';
import { certificateName } from '../ownCertificates';
import { createdAfterOfAnswer, RawAnswer, sendRaw } from './rawAnswers';

const logger = new Logger('Lifecycle');

/** The parts of an attribute definition a request attribute copies. */
interface AttributeDefinitionRef {
    uuid?: string;
    name?: string;
    contentType?: string;
    version?: string;
}

/** The registration and validation settings of `GET /v1/settings/platform` (the only members read here). */
interface PlatformCertificateSettings {
    certificates?: {
        registration?: { defaultIssuanceWindowDays?: number; maxFailedAttempts?: number };
        validation?: { enabled?: unknown };
    };
}

// ------------------------------------------------------------------ register and complete (pre-registration)

/** A challenge secret: 12–255 printable ASCII; run-prefixed so a log line never looks like a real secret. */
export const newChallenge = (): string => `${runId()}-s-${Math.random().toString(36).slice(2, 10)}${timestampSuffix()}`;

/** The platform default CN definition (core `CsrAttributes`, a fixed uuid). */
export const DEFAULT_CN_DEFINITION: Readonly<AttributeDefinitionRef> = { uuid: '9abaeba0-973d-11ed-a8fc-0242ac120002', name: 'commonName', contentType: 'string', version: 'v3' };

/**
 * Pure: the request attribute carrying `cn` for a CN definition. A v3 request attribute's content items are polymorphic
 * on their own `contentType` (interfaces BaseAttributeContentV3.java:20-34, no default subtype), so every v3 item carries
 * it; without it core answers 400 "Unable to read HTTP message". A v2 item has no such member.
 */
export function cnAttributeOf(def: AttributeDefinitionRef, cn: string): JsonObject {
    const version = requestVersion(def, 'v3');
    const contentType = def.contentType ?? 'string';
    return { version, uuid: def.uuid, name: def.name, contentType, content: [version === 'v3' ? { data: cn, contentType } : { data: cn }] };
}

/**
 * The `commonName` request attribute of the RA profile's resolved request-attribute set
 * (`GET /v1/certificates/csr/attributes?raProfileUuid=`), as a request attribute carrying `cn`. Without the set (an
 * RA profile the suite may not query) the platform default definition is used.
 */
export async function cnRequestAttribute(api: APIRequestContext, ra: Pick<RaLike, 'uuid'>, cn: string): Promise<JsonObject> {
    let def: AttributeDefinitionRef = DEFAULT_CN_DEFINITION;
    try {
        const defs = await apiJson<AttributeDefinitionRef[]>(api, 'GET', `/api/v1/certificates/csr/attributes?raProfileUuid=${encodeURIComponent(ra.uuid)}`);
        const found = (defs ?? []).find((d) => d.name === 'commonName');
        if (found) def = found;
    } catch (e) {
        logger.warn(`csr attributes of RA profile ${ra.uuid} not readable (${String(e).slice(0, 120)}); using the platform default CN definition`);
    }
    return cnAttributeOf(def, cn);
}

export interface RegisterOptions {
    suffix?: string;
    /** The challenge; `undefined` registers without one (no authorization row). */
    secret?: string;
    /** ISO date of the issuance window (only with a secret). */
    expiresAt?: string;
    /** Replaces the CN request attribute (negatives: special characters, two identities, …). */
    cn?: string;
    body?: JsonObject;
    note?: string;
}

export interface Registration {
    answer: RawAnswer;
    cn: string;
    secret?: string;
    /** The placeholder the platform made (recorded), when the answer carried a uuid. */
    cert?: OwnRef;
    createdAfter?: string;
}

/**
 * `POST …/certificates/register` (platform-level pre-registration) with the CN as `csrAttributes` and an
 * optional challenge; the placeholder is recorded before any assertion. GUARD REQUEST (lifecycle-shared-patches
 * README): the route is a create and must be on the guard's POST_CREATE list; until then the guard refuses it.
 */
export async function registerOwnCertificate(api: GuardedApi, ra: RaLike, spec: string, opts: RegisterOptions = {}): Promise<Registration> {
    const cn = opts.cn ?? certificateName(opts.suffix ?? 'reg');
    const body: JsonObject = { csrAttributes: [await cnRequestAttribute(api, ra, cn)], attributes: [], customAttributes: [], ...(opts.body ?? {}) };
    if (opts.secret !== undefined) body.authorizationSecret = opts.secret;
    if (opts.expiresAt !== undefined) body.expiresAt = opts.expiresAt;
    const answer = await sendRaw(api, 'POST', `${opsBase(ra)}/certificates/register`, body);
    const uuid = isJsonObject(answer.json) ? answer.json.uuid : undefined;
    const cert = typeof uuid === 'string'
        ? recordCreated('certificates', { uuid, name: cn }, spec, opts.note ?? `pre-registered via API${opts.secret ? ' with a challenge' : ''}`, { raProfile: ra.uuid, authority: ra.authorityUuid })
        : undefined;
    return { answer, cn, secret: opts.secret, cert, createdAfter: createdAfterOfAnswer(answer) };
}

/** The `registration` block of a certificate detail (`CertificateRegistrationDetailDto`), or undefined. */
export async function registrationOf(api: APIRequestContext, uuid: string): Promise<{ state?: string; expiresAt?: string; failedAttempts?: number } | undefined> {
    const cert = await getCertificate(api, uuid);
    return cert.registration ?? undefined;
}

/** `defaultIssuanceWindowDays` / `maxFailedAttempts` of the tier (read, never set; core defaults 7 / 5 when unset). */
export async function registrationDefaults(api: APIRequestContext): Promise<{ defaultIssuanceWindowDays: number; maxFailedAttempts: number }> {
    const settings = await apiJson<PlatformCertificateSettings | undefined>(api, 'GET', '/api/v1/settings/platform');
    const r = settings?.certificates?.registration ?? {};
    return { defaultIssuanceWindowDays: Number(r.defaultIssuanceWindowDays ?? 7), maxFailedAttempts: Number(r.maxFailedAttempts ?? 5) };
}

/**
 * Whether certificate validation runs for the certificates of an RA profile (a preflight): the RA profile's own
 * `certificateValidationSettings.enabled`, else the platform `certificates.validation.enabled`; undefined = not readable.
 */
export async function validationEnabledFor(api: APIRequestContext, ra: Pick<RaLike, 'uuid'>): Promise<boolean | undefined> {
    const profile = await apiJson<{ certificateValidationSettings?: { enabled?: unknown } } | undefined>(api, 'GET', `/api/v1/raProfiles/${ra.uuid}`).catch(() => undefined);
    const own = profile?.certificateValidationSettings?.enabled;
    if (typeof own === 'boolean') return own;
    const settings = await apiJson<PlatformCertificateSettings | undefined>(api, 'GET', '/api/v1/settings/platform').catch(() => undefined);
    const platform = settings?.certificates?.validation?.enabled;
    return typeof platform === 'boolean' ? platform : undefined;
}

/** `GET /v1/certificates/{own}/validate`: re-runs the validation of an OWN certificate (a side-effect GET the guard admits on own objects only). */
export async function revalidate(api: GuardedApi, cert: OwnRef): Promise<JsonObject> {
    await assertOwnLive(api, 'certificates', cert, 'revalidate');
    return apiJson<JsonObject>(api, 'GET', `/api/v1/certificates/${cert.uuid}/validate`);
}

/** |a − b| in milliseconds of two ISO / Date values. */
export const msBetween = (a: string | Date, b: string | Date): number => Math.abs(new Date(a).getTime() - new Date(b).getTime());
