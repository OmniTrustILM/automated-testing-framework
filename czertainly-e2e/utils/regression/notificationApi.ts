/**
 * notificationApi — notification instances and profiles for the API-WFL-19…27 / REG-WFL-23…29 rows (events-discovery area).
 *
 * Shared-tier rules (the test plan §0, guard 5): instances and profiles are CREATED and VALIDATED only —
 * nothing is delivered. The sender, the webhook URL and every address are reserved test names (`@example.test`,
 * `https://<run>.example.test/…`, RFC 6761), and no workflow trigger fires an instance of this module on a shared tier.
 * Delivery (REG-WFL-25…29) is `@local:notif` with the catchers of utils/regression/catchers.ts.
 *
 * The connector attributes are built from the LIVE definitions (`GET /v1/connectors/{uuid}/attributes/notificationProvider/
 * {kind}`: uuid, name, content type), never from remembered uuids; only the webhook's per-content-type template attribute
 * (resolved by a callback the guard does not send) is derived: `data_contentTemplate_<code>` with the name-based uuid
 * `UUID.nameUUIDFromBytes(DATA_CONTENT_TEMPLATE_UUID + code)` (webhook-notification-provider `Attributes.java`).
 *
 * Rules: T10 R1–R9 (instances), R10–R22 (profiles), R53–R62 (providers). Names are run-prefixed, every created object is
 * recorded in the ledger before any assertion and removed by utils/notificationUtils.ts `teardownHandlers`.
 */
import * as crypto from 'crypto';
import { GuardedApi } from './guardedApi';
import { findConnector, healthByVersion, listConnectors } from './connectorApi';
import { isOk, Sent, sendJson, wfName } from './workflowApi';
import { OwnRef, recordCreated, recordDeleted, RUN_ID } from './regressionRun';
import { assertOwnLive, ownership } from './ownObjects';

type Json = Record<string, any>;

export type NotificationKind = 'EMAIL' | 'WEBHOOK';
export type WebhookContentType = 'RAW_JSON' | 'JSON' | 'XML';
export type RecipientCode = 'user' | 'group' | 'role' | 'owner' | 'none' | 'default' | 'object';

export const NOTIFICATION_FUNCTION_GROUP = 'notificationProvider';

export interface NotificationConnector {
    uuid: string;
    name: string;
    kind: NotificationKind;
    /** Why it cannot be used ("live health 503"), or undefined when it answers its live health. */
    unhealthy?: string;
}

/**
 * The registered, connected notification connector that offers `kind` (a v1 connector with the `notificationProvider`
 * function group), with its LIVE health. Read-only. `undefined` = the tier has none: the spec skips with the named
 * reason (`@needs:email-provider` / `@needs:webhook-provider`).
 */
export async function findNotificationConnector(api: GuardedApi, kind: NotificationKind): Promise<NotificationConnector | undefined> {
    const rows = await api.get('/api/v1/connectors');
    if (!rows.ok()) throw new Error(`GET /v1/connectors answered ${rows.status()}`);
    const all = (await rows.json()) as Json[];
    const candidates = all.filter(
        (c) =>
            c.status === 'connected' &&
            (c.functionGroups ?? []).some((g: Json) => g.functionGroupCode === NOTIFICATION_FUNCTION_GROUP && (g.kinds ?? []).includes(kind)),
    );
    for (const c of candidates) {
        const connector = (await listConnectors(api)).find((x) => x.uuid === c.uuid) ?? (await findConnector(api, String(c.name)));
        if (!connector) continue;
        const health = await healthByVersion(api, connector);
        return { uuid: String(c.uuid), name: String(c.name), kind, ...(health.healthy ? {} : { unhealthy: health.why }) };
    }
    return undefined;
}

/** The attribute definitions of one kind (`GET /v1/connectors/{uuid}/attributes/notificationProvider/{kind}`), read-only. */
export async function instanceDefinitions(api: GuardedApi, connector: NotificationConnector): Promise<Json[]> {
    const res = await api.get(`/api/v1/connectors/${connector.uuid}/attributes/${NOTIFICATION_FUNCTION_GROUP}/${connector.kind}`);
    if (!res.ok()) throw new Error(`GET attribute definitions of ${connector.name} (${connector.kind}) answered ${res.status()}`);
    return (await res.json()) as Json[];
}

/** The mapping attributes of a kind (`GET /v1/notificationInstances/attributes/mapping/{connector}/{kind}`). */
export async function getMappingAttributes(api: GuardedApi, connector: NotificationConnector): Promise<Sent> {
    return sendJson(api, 'GET', `/api/v1/notificationInstances/attributes/mapping/${connector.uuid}/${connector.kind}`);
}

// ------------------------------------------------------------------ request attributes from definitions

/** Base64 of a template: the content of a CODEBLOCK attribute is `{ language, code: <base64> }`. */
export const codeBlock = (language: string, template: string): Json => ({ language, code: Buffer.from(template, 'utf8').toString('base64') });

const byName = (defs: Json[], name: string): Json => {
    const d = defs.find((x) => x.name === name);
    if (!d) throw new Error(`the connector offers no attribute ${name} (offers: ${defs.map((x) => x.name).join(', ')})`);
    return d;
};

/** `{ uuid, name, contentType, content }` of a definition with the given content items (the v2 request attribute). */
export const requestAttribute = (def: Json, content: Json[]): Json => ({ uuid: def.uuid, name: def.name, contentType: def.contentType, content });

export interface EmailAttributeValues {
    sender: string;
    subject: string;
    /** HTML template; omit to send none (a negative case). */
    template?: string;
}

/** The request attributes of an EMAIL instance; a missing value leaves its attribute out (negative cases). */
export function emailAttributes(defs: Json[], v: Partial<EmailAttributeValues>): Json[] {
    const out: Json[] = [];
    if (v.sender !== undefined) out.push(requestAttribute(byName(defs, 'data_senderEmailAddress'), [{ data: v.sender }]));
    if (v.subject !== undefined) out.push(requestAttribute(byName(defs, 'data_emailSubject'), [{ data: v.subject }]));
    if (v.template !== undefined) out.push(requestAttribute(byName(defs, 'data_emailContentTemplate'), [{ data: codeBlock('html', v.template) }]));
    return out;
}

/** Java's `UUID.nameUUIDFromBytes` (MD5, version 3). */
export function nameUuidFromBytes(bytes: Buffer): string {
    const h = crypto.createHash('md5').update(bytes).digest();
    h[6] = (h[6] & 0x0f) | 0x30;
    h[8] = (h[8] & 0x3f) | 0x80;
    const hex = h.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const WEBHOOK_TEMPLATE_UUID = '1b247b77-e9c0-45b9-8114-06377cbeedc7';
const WEBHOOK_CODE: Record<WebhookContentType, { code: string; language: string }> = {
    RAW_JSON: { code: 'raw_json', language: 'json' },
    JSON: { code: 'json', language: 'json' },
    XML: { code: 'xml', language: 'xml' },
};

/** The derived template attribute of a webhook content type (uuid and name per content type, webhook `Attributes.java`). */
export function webhookTemplateAttribute(contentType: WebhookContentType, template: string): Json {
    const { code, language } = WEBHOOK_CODE[contentType];
    return {
        uuid: nameUuidFromBytes(Buffer.from(WEBHOOK_TEMPLATE_UUID + code)),
        name: `data_contentTemplate_${code}`,
        contentType: 'codeblock',
        content: [{ data: codeBlock(language, template) }],
    };
}

export interface WebhookAttributeValues {
    url: string;
    contentType: WebhookContentType;
    /** The template of a JSON / XML webhook; none for RAW_JSON. */
    template?: string;
}

/** The request attributes of a WEBHOOK instance; `url` / `contentType` left undefined are left out (negative cases). */
export function webhookAttributes(defs: Json[], v: Partial<WebhookAttributeValues>): Json[] {
    const out: Json[] = [];
    if (v.url !== undefined) out.push(requestAttribute(byName(defs, 'data_webhookUrl'), [{ data: v.url }]));
    if (v.contentType !== undefined) {
        const def = byName(defs, 'data_contentType');
        const item = (def.content ?? []).find((c: Json) => c.data === v.contentType);
        out.push(requestAttribute(def, [item ? { reference: item.reference, data: item.data } : { reference: WEBHOOK_CODE[v.contentType].code, data: v.contentType }]));
        if (v.template !== undefined && v.contentType !== 'RAW_JSON') out.push(webhookTemplateAttribute(v.contentType, v.template));
    }
    return out;
}

/** Reserved test names (RFC 6761 `.test`): nothing resolves, nothing is delivered. */
export const reservedSender = (suffix = 'sender'): string => `${wfName(suffix)}@example.test`;
export const reservedWebhookUrl = (suffix = 'hook'): string => `https://${wfName(suffix)}.example.test/hook`;

export const EMAIL_TEMPLATE = '<html><body><p>QA ${event}</p></body></html>';
export const WEBHOOK_JSON_TEMPLATE = '{"event":"${event}"}';
export const WEBHOOK_XML_TEMPLATE = '<notification><event>${event}</event></notification>';

// ------------------------------------------------------------------ instances

export interface InstanceBody {
    name?: string;
    description?: string;
    connectorUuid?: string;
    kind?: string;
    attributes?: Json[];
    attributeMappings?: Json[];
}

export interface OwnInstance extends OwnRef {
    body: Json;
    connector: NotificationConnector;
}

/** The instance request body of a connector + attributes (pure). */
export function instanceBody(connector: NotificationConnector, name: string, attributes: Json[], extra: Partial<InstanceBody> = {}): Json {
    return { name, description: `REG run ${RUN_ID}`, connectorUuid: connector.uuid, kind: connector.kind, attributes, attributeMappings: [], ...extra };
}

/** Creates an own instance (ledger before assertion); throws on a refusal: a positive step. */
export async function createOwnInstance(api: GuardedApi, spec: string, o: { suffix: string; connector: NotificationConnector; attributes: Json[]; description?: string; attributeMappings?: Json[] }): Promise<OwnInstance> {
    const name = wfName(o.suffix);
    const sent = await sendJson(api, 'POST', '/api/v1/notificationInstances', instanceBody(o.connector, name, o.attributes, {
        ...(o.description !== undefined ? { description: o.description } : {}),
        ...(o.attributeMappings ? { attributeMappings: o.attributeMappings } : {}),
    }));
    if (!isOk(sent) || typeof sent.json?.uuid !== 'string') throw new Error(`POST /v1/notificationInstances → ${sent.status} ${sent.text.slice(0, 400)}`);
    const ref = recordCreated('notificationInstances', { uuid: sent.json.uuid, name }, spec, `${o.connector.kind} notification instance (nothing delivered)`);
    return { ...ref, body: sent.json, connector: o.connector };
}

/** A negative probe: POST as is; an accepted one is recorded so the teardown removes it. */
export async function probeInstance(api: GuardedApi, body: Json, spec: string): Promise<Sent> {
    const sent = await sendJson(api, 'POST', '/api/v1/notificationInstances', body);
    if (isOk(sent) && typeof sent.json?.uuid === 'string' && typeof body.name === 'string' && body.name.startsWith(`${RUN_ID}-`)) {
        recordCreated('notificationInstances', { uuid: sent.json.uuid, name: body.name }, spec, 'accepted although a refusal was expected');
    }
    return sent;
}

/** Every instance of the tier (`GET /v1/notificationInstances`, an unpaged list; read-only). */
export async function listInstances(api: GuardedApi): Promise<Json[]> {
    const sent = await sendJson(api, 'GET', '/api/v1/notificationInstances');
    if (sent.status !== 200 || !Array.isArray(sent.json)) throw new Error(`GET /v1/notificationInstances answered ${sent.status}`);
    return sent.json as Json[];
}

export async function getInstance(api: GuardedApi, uuid: string): Promise<Sent> {
    return sendJson(api, 'GET', `/api/v1/notificationInstances/${uuid}`);
}

/** `PUT` of an own instance: description, attributes and mappings only (R4). */
export async function putOwnInstance(api: GuardedApi, ref: OwnRef, body: Json): Promise<Sent> {
    await assertOwnLive(api, 'notificationInstances', ref, 'putOwnInstance');
    return sendJson(api, 'PUT', `/api/v1/notificationInstances/${ref.uuid}`, body);
}

/** `DELETE` of an own instance; a 204 is recorded (`deleted` ledger line), a refusal (422, naming the profiles) is returned. */
export async function deleteOwnInstance(api: GuardedApi, ref: OwnRef, spec: string): Promise<Sent> {
    await assertOwnLive(api, 'notificationInstances', ref, 'deleteOwnInstance');
    const sent = await sendJson(api, 'DELETE', `/api/v1/notificationInstances/${ref.uuid}`);
    if (sent.status === 204 || sent.status === 200) recordDeleted('notificationInstances', ref, spec, 'deleted as the behaviour under test');
    return sent;
}

// ------------------------------------------------------------------ profiles

export interface ProfileOptions {
    suffix: string;
    recipientType: RecipientCode;
    /** USER / GROUP / ROLE need uuids (of OWN objects: the guard types them); OWNER / NONE / DEFAULT / OBJECT carry none. */
    recipients?: Array<{ uuid: string }>;
    instance?: { uuid: string };
    internal?: boolean;
    /** ISO-8601 days and hours (`P1DT12H`). */
    frequency?: string;
    repetitions?: number;
    categories?: string[];
    description?: string;
}

export function profileBody(name: string | undefined, o: Omit<ProfileOptions, 'suffix'>): Json {
    return {
        ...(name !== undefined ? { name } : {}),
        description: o.description ?? `REG run ${RUN_ID}`,
        recipientType: o.recipientType,
        ...(o.recipients ? { recipientUuids: o.recipients.map((r) => r.uuid) } : {}),
        ...(o.instance ? { notificationInstanceUuid: o.instance.uuid } : {}),
        internalNotification: o.internal ?? false,
        ...(o.frequency !== undefined ? { frequency: o.frequency } : {}),
        ...(o.repetitions !== undefined ? { repetitions: o.repetitions } : {}),
        ...(o.categories ? { eventDataCategories: o.categories } : {}),
    };
}

export interface OwnProfile extends OwnRef {
    body: Json;
}

/** Creates an own profile (ledger before assertion); throws on a refusal: a positive step. */
export async function createOwnProfile(api: GuardedApi, spec: string, o: ProfileOptions): Promise<OwnProfile> {
    const name = wfName(o.suffix);
    const sent = await sendJson(api, 'POST', '/api/v1/notificationProfiles', profileBody(name, o));
    if (!isOk(sent) || typeof sent.json?.uuid !== 'string') throw new Error(`POST /v1/notificationProfiles → ${sent.status} ${sent.text.slice(0, 400)}`);
    const ref = recordCreated('notificationProfiles', { uuid: sent.json.uuid, name }, spec, `notification profile (${o.recipientType}${o.internal ? ', internal' : ''})`);
    return { ...ref, body: sent.json };
}

/** An internal-only profile (no instance, no connector): the only kind a shared-tier firing may use (guard 5). */
export const createOwnInternalProfile = (api: GuardedApi, spec: string, o: { suffix: string; recipientType: Exclude<RecipientCode, 'none' | 'default' | 'object'>; recipients?: Array<{ uuid: string }> }): Promise<OwnProfile> =>
    createOwnProfile(api, spec, { suffix: o.suffix, recipientType: o.recipientType, ...(o.recipients ? { recipients: o.recipients } : {}), internal: true });

/**
 * Ledger before assertion for a REFUSED create that may still have persisted something (a 404 raised after the save, a
 * partial create): every instance / profile of this run's prefix with exactly this name that the ledger does not know yet is
 * recorded, so the teardown removes it and the assertion that follows is about the refusal, not about a leftover.
 */
export async function recordNamed(api: GuardedApi, kind: 'instances' | 'profiles', name: string, spec: string): Promise<string[]> {
    if (!name.startsWith(`${RUN_ID}-`)) return [];
    const rows = kind === 'instances' ? await listInstances(api) : await listProfiles(api);
    const found = rows.filter((r) => r.name === name);
    const type = kind === 'instances' ? 'notificationInstances' : 'notificationProfiles';
    for (const r of found) if (!ownership({ uuid: String(r.uuid) }).own) recordCreated(type, { uuid: String(r.uuid), name }, spec, 'persisted by a refused create');
    return found.map((r) => String(r.uuid));
}

/** A negative probe: POST as is; an accepted one is recorded so the teardown removes it. */
export async function probeProfile(api: GuardedApi, body: Json, spec: string): Promise<Sent> {
    const sent = await sendJson(api, 'POST', '/api/v1/notificationProfiles', body);
    if (isOk(sent) && typeof sent.json?.uuid === 'string' && typeof body.name === 'string' && body.name.startsWith(`${RUN_ID}-`)) {
        recordCreated('notificationProfiles', { uuid: sent.json.uuid, name: body.name }, spec, 'accepted although a refusal was expected');
    }
    return sent;
}

/** Every profile of the tier, all pages of `GET /v1/notificationProfiles` (read-only). */
export async function listProfiles(api: GuardedApi): Promise<Json[]> {
    const rows: Json[] = [];
    for (let page = 1; ; page++) {
        const sent = await sendJson(api, 'GET', `/api/v1/notificationProfiles?itemsPerPage=100&pageNumber=${page}`);
        if (sent.status !== 200) throw new Error(`GET /v1/notificationProfiles answered ${sent.status}`);
        rows.push(...((sent.json?.notificationProfiles ?? []) as Json[]));
        if (page >= Number(sent.json?.totalPages ?? 0)) break;
    }
    return rows;
}

export async function getProfile(api: GuardedApi, uuid: string, version?: number): Promise<Sent> {
    return sendJson(api, 'GET', `/api/v1/notificationProfiles/${uuid}${version !== undefined ? `?version=${version}` : ''}`);
}

export async function putOwnProfile(api: GuardedApi, ref: OwnRef, body: Json): Promise<Sent> {
    await assertOwnLive(api, 'notificationProfiles', ref, 'putOwnProfile');
    return sendJson(api, 'PUT', `/api/v1/notificationProfiles/${ref.uuid}`, body);
}

/** `DELETE` of an own profile; a 204 is recorded (`deleted` ledger line), a refusal (422, naming the executions) is returned. */
export async function deleteOwnProfile(api: GuardedApi, ref: OwnRef, spec: string): Promise<Sent> {
    await assertOwnLive(api, 'notificationProfiles', ref, 'deleteOwnProfile');
    const sent = await sendJson(api, 'DELETE', `/api/v1/notificationProfiles/${ref.uuid}`);
    if (sent.status === 204 || sent.status === 200) recordDeleted('notificationProfiles', ref, spec, 'deleted as the behaviour under test');
    return sent;
}

/** The seconds of a duration the platform answered: an ISO-8601 string of days / hours (`P1DT12H`) or a number of seconds. */
export function durationSeconds(value: unknown): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return undefined;
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
    if (!m) return undefined;
    return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

/** A literal for `new RegExp`. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The label of an attribute definition (`properties.label`), the text core puts in its validation messages; the name when absent. */
export const attributeLabel = (defs: Json[], name: string): string => String(defs.find((d) => d.name === name)?.properties?.label ?? name);

/** An error body mentions `text` (in the array element or the `message`). */
export const mentions = (s: Sent, text: string | RegExp): boolean =>
    (Array.isArray(s.json) ? s.json.map(String) : s.json?.message ? [String(s.json.message)] : [s.text]).some((t) => (typeof text === 'string' ? t.includes(text) : text.test(t)));

export type { Json };
