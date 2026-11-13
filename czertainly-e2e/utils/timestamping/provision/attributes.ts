/**
 * attributes — the request attributes of the timestamping setup, built from the connector's LIVE definitions.
 * development-environment `scripts/timestamping-setup.sh` is the source of truth for every request body. A missing definition or offered
 * value is a TierError; what the connector offered goes to the log only.
 */
import { Logger } from '../../Logger';
import type { CryptoProvider } from '../config';
import { TierError } from './transport';

const logger = new Logger('TimestampingSetup');

export interface AttributeContent {
    data?: unknown;
    reference?: string;
    contentType?: string;
}

export interface AttributeDef {
    uuid: string;
    name: string;
    type?: string;
    contentType?: string;
    version?: string | number;
    content?: AttributeContent[];
    properties?: { required?: boolean; list?: boolean };
    attributeCallback?: { mappings?: Array<{ to?: string; value?: unknown }> };
}

export interface RequestAttribute {
    name: string;
    content: AttributeContent[];
    contentType: string | null;
    uuid: string;
    version: 'v2' | 'v3';
}

export const jqString = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

function missing(defs: AttributeDef[], expectation: string): TierError {
    const received = defs.map((d) => `${d.name}/${d.contentType ?? '(none)'}/${d.type ?? '?'}`).join(', ');
    logger.warn(`expected ${expectation}; received attributes: ${received || 'nothing'}`);
    return new TierError(`expected ${expectation}, not found (the received attributes are in the setup log)`);
}

export function attrUuid(defs: AttributeDef[], name: string, contentType: string): string {
    const d = defs.find((x) => x.name === name && x.contentType === contentType);
    if (!d?.uuid) throw missing(defs, `attribute name='${name}' contentType='${contentType}'`);
    return d.uuid;
}

export function groupUuid(defs: AttributeDef[], name: string): string {
    const d = defs.find((x) => x.name === name && x.type === 'group');
    if (!d?.uuid) throw missing(defs, `group attribute name='${name}'`);
    return d.uuid;
}

export const offersAttribute = (defs: AttributeDef[], name: string): boolean => defs.some((d) => d.name === name && !!d.uuid);

/** A v3 definition takes the content type on every content item (an item's own wins), a v2 one on the attribute only. */
export function requestAttribute(defs: AttributeDef[], name: string, content: AttributeContent[]): RequestAttribute {
    const d = defs.find((x) => x.name === name);
    if (!d || !d.uuid) throw missing(defs, `attribute name='${name}'`);
    const contentType = d.contentType ?? null;
    if (String(d.version ?? '').replace(/^v/, '') === '3') {
        return { name, content: content.map((c) => ({ contentType: contentType ?? undefined, ...c })), contentType, uuid: d.uuid, version: 'v3' };
    }
    return { name, content: content.map(({ contentType: _dropped, ...c }) => c), contentType, uuid: d.uuid, version: 'v2' };
}

export function chosenAttribute(defs: AttributeDef[], name: string, value: string): RequestAttribute {
    const d = defs.find((x) => x.name === name);
    const item = d?.content?.find((c) => jqString(c.data) === value);
    if (!item) {
        if (!offersAttribute(defs, name)) throw missing(defs, `attribute name='${name}'`);
        logger.warn(`attribute '${name}' offers no value '${value}'; offered: ${JSON.stringify((d?.content ?? []).map((c) => c.data))}`);
        throw new TierError(`attribute '${name}' offers no value '${value}' (the offered values are in the setup log)`);
    }
    return requestAttribute(defs, name, [item]);
}


export interface ProviderNames {
    keyAlgorithm: string;
    keySpecGroup: string;
    keyAlias: string;
    rsaKeySize: string;
    mldsaLevel: string;
    /** Empty where the connector offers pure ML-DSA only. */
    mldsaPrehash: string;
}

export function providerNames(provider: CryptoProvider): ProviderNames {
    switch (provider) {
        case 'software-v1':
            return { keyAlgorithm: 'data_keyAlgorithm', keySpecGroup: 'group_keySpec', keyAlias: 'data_keyAlias', rsaKeySize: 'data_rsaKeySize', mldsaLevel: 'data_mldsaLevel', mldsaPrehash: 'data_mldsaPrehash' };
        case 'software-v2':
            return { keyAlgorithm: 'data_keyAlgorithm', keySpecGroup: 'group_keySpecV2', keyAlias: 'data_keyAlias', rsaKeySize: 'data_rsaKeySize', mldsaLevel: 'data_mldsaLevel', mldsaPrehash: '' };
        case 'pkcs11':
            return { keyAlgorithm: 'keyAlgorithm', keySpecGroup: 'keySpec', keyAlias: 'keyLabel', rsaKeySize: 'rsaKeySize', mldsaLevel: 'mlDsaLevel', mldsaPrehash: '' };
    }
}

// The script's key-spec defaults: RSA 2048 bits, ML-DSA-65, pure ML-DSA.
const DEFAULT_RSA_KEY_SIZE = '2048';
const DEFAULT_MLDSA_LEVEL = '3';
const DEFAULT_MLDSA_PREHASH = 'false';

export function requestedKeySpec(names: ProviderNames, keyAlgorithm: 'RSA' | 'ML-DSA'): Record<string, string> {
    if (keyAlgorithm === 'RSA') return { [names.rsaKeySize]: DEFAULT_RSA_KEY_SIZE };
    return { [names.mldsaLevel]: DEFAULT_MLDSA_LEVEL, ...(names.mldsaPrehash ? { [names.mldsaPrehash]: DEFAULT_MLDSA_PREHASH } : {}) };
}

const hasDefault = (f: AttributeDef): boolean => f.properties?.list !== true && (f.content ?? []).length > 0;

/**
 * A requested field the connector's key spec does not offer, or a required field without a default or a requested value, stops the family: a key
 * must never silently get the connector's default.
 */
export function keySpecAttributes(defs: AttributeDef[], requested: Record<string, string>, keyAlgorithm: string): RequestAttribute[] {
    const fields = defs.filter((d) => d.type === 'data');
    const offeredNames = fields.map((f) => f.name);
    const unknown = Object.keys(requested).filter((n) => !offeredNames.includes(n));
    if (unknown.length) {
        logger.warn(`${keyAlgorithm} key spec offers: ${offeredNames.join(', ') || 'nothing'}`);
        throw new TierError(`the run sets ${unknown.join(', ')}, which the ${keyAlgorithm} key spec does not offer`);
    }
    const unset = fields.find((f) => f.properties?.required === true && !(f.name in requested) && !hasDefault(f));
    if (unset) throw new TierError(`${keyAlgorithm} key-spec field '${unset.name}' needs a value the run does not set`);
    const plan: Array<[string, string]> = [];
    for (const f of fields) {
        if (f.name in requested) plan.push([f.name, requested[f.name]]);
        else if (f.properties?.required === true && hasDefault(f)) plan.push([f.name, jqString(f.content![0].data)]);
    }
    return plan.map(([name, value]) => keySpecAttribute(defs, name, value));
}

function keySpecAttribute(defs: AttributeDef[], name: string, value: string): RequestAttribute {
    const field = defs.find((d) => d.name === name)!;
    const takesOffered = field.properties?.list === true || (field.content ?? []).some((c) => jqString(c.data) === value);
    if (takesOffered) return chosenAttribute(defs, name, value);
    let data: unknown = value;
    if (field.contentType === 'boolean') {
        if (value !== 'true' && value !== 'false') throw new TierError(`key-spec field '${name}' takes a boolean value; got '${value}'`);
        data = value === 'true';
    } else if (field.contentType === 'integer' || field.contentType === 'float') {
        data = Number(value);
        if (Number.isNaN(data)) throw new TierError(`key-spec field '${name}' takes a ${field.contentType} value; got '${value}'`);
    }
    return requestAttribute(defs, name, [{ data }]);
}


/**
 * The RSA scheme and digest where the key offers them, plus `signatureAlgorithm`
 * where Core offers it instead (a post-quantum key on a v2 token).
 */
export function signingOperationAttributes(defs: AttributeDef[], scheme: string, digest: string): RequestAttribute[] {
    const out: RequestAttribute[] = [];
    if (offersAttribute(defs, 'data_rsaSigScheme')) out.push(chosenAttribute(defs, 'data_rsaSigScheme', scheme));
    if (offersAttribute(defs, 'data_sigDigest')) out.push(chosenAttribute(defs, 'data_sigDigest', digest));
    if (offersAttribute(defs, 'signatureAlgorithm')) {
        const first = defs.find((d) => d.name === 'signatureAlgorithm')?.content?.[0]?.data;
        if (first === undefined) throw new TierError('attribute \'signatureAlgorithm\' offers no value');
        out.push(chosenAttribute(defs, 'signatureAlgorithm', jqString(first)));
    }
    return out;
}
