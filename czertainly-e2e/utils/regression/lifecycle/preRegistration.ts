/**
 * preRegistration — platform-level pre-registration of own certificates: the register call, the registration block of a detail, the tier's
 * settings (read, never set) and re-validation; the placeholder is recorded before any assertion.
 */
import type { APIRequestContext } from '@playwright/test';
import { apiJson, getCertificate, ApiAnswer } from '../apiReads';
import { requestVersion } from '../attributeVersion';
import type { GuardedApi } from '../guard/types';
import { Logger } from '../../Logger';
import { assertOwnLive } from '../ledger/ownership';
import type { RaLike } from '../ownRaProfiles';
import { isJsonObject, JsonObject } from '../json';
import { OwnRef, recordCreated } from '../ledger/ledger';
import { runId } from '../ledger/runState';
import { opsBase } from './certificateLabels';
import { certificateName } from '../ownCertificates';
import { createdAfterOfAnswer, sendRaw } from './rawAnswers';
import { randomBytes } from 'crypto';
import { uniqueSuffix } from '../text';

const logger = new Logger('Lifecycle');

interface AttributeDefinitionRef {
    uuid?: string;
    name?: string;
    contentType?: string;
    version?: string;
}

interface PlatformCertificateSettings {
    certificates?: {
        registration?: { defaultIssuanceWindowDays?: number; maxFailedAttempts?: number };
        validation?: { enabled?: unknown };
    };
}


export const newChallenge = (): string => `${runId()}-s-${randomBytes(4).toString('hex')}${uniqueSuffix()}`;

export const DEFAULT_CN_DEFINITION: Readonly<AttributeDefinitionRef> = { uuid: '9abaeba0-973d-11ed-a8fc-0242ac120002', name: 'commonName', contentType: 'string', version: 'v3' };

/** The request attribute carrying `cn`; a v3 item must carry its own `contentType` or core answers 400 "Unable to read HTTP message". */
export function cnAttributeOf(def: AttributeDefinitionRef, cn: string): JsonObject {
    const version = requestVersion(def, 'v3');
    const contentType = def.contentType ?? 'string';
    return { version, uuid: def.uuid, name: def.name, contentType, content: [version === 'v3' ? { data: cn, contentType } : { data: cn }] };
}

/** The `commonName` request attribute of the RA profile's resolved attribute set, or the platform default when the set is not readable. */
export async function commonNameRequestAttribute(api: APIRequestContext, ra: Pick<RaLike, 'uuid'>, cn: string): Promise<JsonObject> {
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
    secret?: string;
    expiresAt?: string;
    cn?: string;
    body?: JsonObject;
    note?: string;
}

export interface Registration {
    answer: ApiAnswer;
    cn: string;
    secret?: string;
    cert?: OwnRef;
    createdAfter?: string;
}

/**
 * `POST …/certificates/register` with the CN as `csrAttributes` and an optional challenge; the placeholder is recorded first. The route
 * must be on the guard's POST_CREATE list.
 */
export async function registerOwnCertificate(api: GuardedApi, ra: RaLike, spec: string, opts: RegisterOptions = {}): Promise<Registration> {
    const cn = opts.cn ?? certificateName(opts.suffix ?? 'reg');
    const body: JsonObject = { csrAttributes: [await commonNameRequestAttribute(api, ra, cn)], attributes: [], customAttributes: [], ...(opts.body ?? {}) };
    if (opts.secret !== undefined) body.authorizationSecret = opts.secret;
    if (opts.expiresAt !== undefined) body.expiresAt = opts.expiresAt;
    const answer = await sendRaw(api, 'POST', `${opsBase(ra)}/certificates/register`, body);
    const uuid = isJsonObject(answer.json) ? answer.json.uuid : undefined;
    const cert = typeof uuid === 'string'
        ? recordCreated('certificates', { uuid, name: cn }, { spec, note: opts.note ?? `pre-registered via API${opts.secret ? ' with a challenge' : ''}`, parents: { raProfile: ra.uuid, authority: ra.authorityUuid } })
        : undefined;
    return { answer, cn, secret: opts.secret, cert, createdAfter: createdAfterOfAnswer(answer) };
}

export async function registrationOf(api: APIRequestContext, uuid: string): Promise<{ state?: string; expiresAt?: string; failedAttempts?: number } | undefined> {
    const cert = await getCertificate(api, uuid);
    return cert.registration ?? undefined;
}

export async function registrationDefaults(api: APIRequestContext): Promise<{ defaultIssuanceWindowDays: number; maxFailedAttempts: number }> {
    const settings = await apiJson<PlatformCertificateSettings | undefined>(api, 'GET', '/api/v1/settings/platform');
    const r = settings?.certificates?.registration ?? {};
    return { defaultIssuanceWindowDays: Number(r.defaultIssuanceWindowDays ?? 7), maxFailedAttempts: Number(r.maxFailedAttempts ?? 5) };
}

/** Whether validation runs for an RA profile's certificates (profile setting, else platform setting); undefined = not readable. */
export async function validationEnabledFor(api: APIRequestContext, ra: Pick<RaLike, 'uuid'>): Promise<boolean | undefined> {
    const profile = await apiJson<{ certificateValidationSettings?: { enabled?: unknown } } | undefined>(api, 'GET', `/api/v1/raProfiles/${ra.uuid}`).catch(() => undefined);
    const own = profile?.certificateValidationSettings?.enabled;
    if (typeof own === 'boolean') return own;
    const settings = await apiJson<PlatformCertificateSettings | undefined>(api, 'GET', '/api/v1/settings/platform').catch(() => undefined);
    const platform = settings?.certificates?.validation?.enabled;
    return typeof platform === 'boolean' ? platform : undefined;
}

/** `GET /v1/certificates/{own}/validate`: re-runs validation of an OWN certificate (a side-effect GET). */
export async function revalidate(api: GuardedApi, cert: OwnRef): Promise<JsonObject> {
    await assertOwnLive(api, 'certificates', cert, 'revalidate');
    return apiJson<JsonObject>(api, 'GET', `/api/v1/certificates/${cert.uuid}/validate`);
}

export const msBetween = (a: string | Date, b: string | Date): number => Math.abs(new Date(a).getTime() - new Date(b).getTime());
