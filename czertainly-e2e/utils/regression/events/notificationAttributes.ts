/**
 * notificationAttributes — request attributes for e-mail and webhook notification instances.
 *
 * Builds the attributes from the connector's live definitions, plus the code-block and template attributes and the fixed
 * templates. Every sender address and webhook URL is a reserved `.test` name, so nothing is ever delivered from a shared
 * tier.
 */

import { checkedDnsName, ownName } from '../ledger/runState';
import type { JsonObject } from '../json';
import { objectOf, rowsOf } from '../json';

export type WebhookContentType = 'RAW_JSON' | 'JSON' | 'XML';


/** Base64 of a template: the content of a CODEBLOCK attribute is `{ language, code: <base64> }`. */
export const codeBlock = (language: string, template: string): JsonObject => ({ language, code: Buffer.from(template, 'utf8').toString('base64') });

const byName = (defs: JsonObject[], name: string): JsonObject => {
    const d = defs.find((x) => x.name === name);
    if (!d) throw new Error(`the connector offers no attribute ${name} (offers: ${defs.map((x) => x.name).join(', ')})`);
    return d;
};

/** `{ uuid, name, contentType, content }` of a definition with the given content items (the v2 request attribute). */
export const requestAttribute = (def: JsonObject, content: JsonObject[]): JsonObject => ({ uuid: def.uuid, name: def.name, contentType: def.contentType, content });

export interface EmailAttributeValues {
    sender: string;
    subject: string;
    /** HTML template; omit to send none (a negative case). */
    template?: string;
}

/** The request attributes of an EMAIL instance; a missing value leaves its attribute out (negative cases). */
export function emailAttributes(defs: JsonObject[], v: Partial<EmailAttributeValues>): JsonObject[] {
    const out: JsonObject[] = [];
    if (v.sender !== undefined) out.push(requestAttribute(byName(defs, 'data_senderEmailAddress'), [{ data: v.sender }]));
    if (v.subject !== undefined) out.push(requestAttribute(byName(defs, 'data_emailSubject'), [{ data: v.subject }]));
    if (v.template !== undefined) out.push(requestAttribute(byName(defs, 'data_emailContentTemplate'), [{ data: codeBlock('html', v.template) }]));
    return out;
}

const WEBHOOK_CODE: Record<WebhookContentType, { code: string; language: string }> = {
    RAW_JSON: { code: 'raw_json', language: 'json' },
    JSON: { code: 'json', language: 'json' },
    XML: { code: 'xml', language: 'xml' },
};

/**
 * The template attribute's uuid per content type, as the webhook connector derives it (`Attributes.java`):
 * `UUID.nameUUIDFromBytes(("1b247b77-e9c0-45b9-8114-06377cbeedc7" + code).getBytes())`, a version-3 (MD5) uuid. Kept as
 * fixed values, so the suite computes no MD5.
 */
const WEBHOOK_TEMPLATE_ATTRIBUTE_UUID: Record<WebhookContentType, string> = {
    RAW_JSON: '07ea053b-3515-3ce8-a8a5-acfca3d4ed15',
    JSON: '77ddf598-724a-31d4-943b-79ee71c854c5',
    XML: '610ed4fa-0b1f-33a9-9a31-0be332673a58',
};

/** The derived template attribute of a webhook content type (uuid and name per content type, webhook `Attributes.java`). */
export function webhookTemplateAttribute(contentType: WebhookContentType, template: string): JsonObject {
    const { code, language } = WEBHOOK_CODE[contentType];
    return {
        uuid: WEBHOOK_TEMPLATE_ATTRIBUTE_UUID[contentType],
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
export function webhookAttributes(defs: JsonObject[], v: Partial<WebhookAttributeValues>): JsonObject[] {
    const out: JsonObject[] = [];
    if (v.url !== undefined) out.push(requestAttribute(byName(defs, 'data_webhookUrl'), [{ data: v.url }]));
    if (v.contentType !== undefined) {
        const def = byName(defs, 'data_contentType');
        const item = rowsOf(def.content).find((c) => c.data === v.contentType);
        out.push(requestAttribute(def, [item ? { reference: item.reference, data: item.data } : { reference: WEBHOOK_CODE[v.contentType].code, data: v.contentType }]));
        if (v.template !== undefined && v.contentType !== 'RAW_JSON') out.push(webhookTemplateAttribute(v.contentType, v.template));
    }
    return out;
}

/** Reserved test names (RFC 6761 `.test`): nothing resolves, nothing is delivered. */
export const reservedSender = (suffix = 'sender'): string => `${ownName(suffix)}@example.test`;
export const reservedWebhookUrl = (suffix = 'hook'): string => `https://${checkedDnsName(`${ownName(suffix)}.example.test`)}/hook`;

export const EMAIL_TEMPLATE = '<html><body><p>QA ${event}</p></body></html>';
export const WEBHOOK_JSON_TEMPLATE = '{"event":"${event}"}';
export const WEBHOOK_XML_TEMPLATE = '<notification><event>${event}</event></notification>';

/** The label of an attribute definition (`properties.label`), the text core puts in its validation messages; the name when absent. */
export const attributeLabel = (defs: JsonObject[], name: string): string => String(objectOf(defs.find((d) => d.name === name)?.properties).label ?? name);
