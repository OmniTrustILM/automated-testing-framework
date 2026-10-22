/**
 * notificationAttributes — request attributes and reserved test values for notification instances.
 *
 * WHAT: Builds the e-mail and webhook request attributes from the connector's definitions, the code-block and template attributes, the
 * reserved sender and URL, and the fixed templates.
 * WHY: The attribute shapes are a connector contract written once; every address and URL is a reserved `.test` name, so nothing is ever
 * delivered from a shared tier.
 * HOW: Pure builders over the live definition list; the only run-specific part is the unique name inside a reserved sender or URL.
 */

import * as crypto from 'crypto';
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
export function webhookTemplateAttribute(contentType: WebhookContentType, template: string): JsonObject {
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
