/**
 * cryptoAlgorithmCases — the key algorithm cases as pure data per provider:
 * what must and must not be offered and which matrix cells the tests run.
 */

export type Provider = 'scp-v1' | 'scp-v2' | 'pkcs11';

export type Family = 'rsa-1024' | 'rsa-2048' | 'rsa-3072' | 'rsa-4096' | 'ec-p256' | 'ec-p384' | 'ec-p521' | 'ml-dsa-44' | 'ml-dsa-65' | 'ml-dsa-87' | 'falcon-1024' | 'slh-dsa-sha2-128s' | 'ml-kem-768';

export type Algorithm = 'RSA' | 'ECDSA' | 'ML-DSA' | 'FALCON' | 'SLH-DSA' | 'ML-KEM';

/** One key-spec field of a family: the attribute (a `SCP_ATTR` key) and the option it takes, by its reference. */
export interface SpecChoice {
    attribute: keyof typeof SCP_ATTR;
    contentType: 'integer' | 'string';
    reference: string;
    data: string | number;
}

export interface FamilySpec {
    family: Family;
    algorithm: Algorithm;
    /** The key-spec fields a create sends, size / curve / level first (the field a negative case overrides). */
    spec: readonly SpecChoice[];
    size?: number;
    label: string;
}

const rsaSize = (size: number): SpecChoice[] => [{ attribute: 'rsaKeySize', contentType: 'integer', reference: `RSA_${size}`, data: size }];
const curve = (name: string): SpecChoice[] => [{ attribute: 'ecdsaCurve', contentType: 'string', reference: name, data: name }];
const mldsa = (level: 44 | 65 | 87, data: number): SpecChoice[] => [{ attribute: 'mldsaLevel', contentType: 'integer', reference: `MLDSA_${level}`, data }];

export const FAMILIES: Readonly<Record<Family, FamilySpec>> = {
    'rsa-1024': { family: 'rsa-1024', algorithm: 'RSA', spec: rsaSize(1024), size: 1024, label: 'RSA 1024' },
    'rsa-2048': { family: 'rsa-2048', algorithm: 'RSA', spec: rsaSize(2048), size: 2048, label: 'RSA 2048' },
    'rsa-3072': { family: 'rsa-3072', algorithm: 'RSA', spec: rsaSize(3072), size: 3072, label: 'RSA 3072' },
    'rsa-4096': { family: 'rsa-4096', algorithm: 'RSA', spec: rsaSize(4096), size: 4096, label: 'RSA 4096' },
    'ec-p256': { family: 'ec-p256', algorithm: 'ECDSA', spec: curve('secp256r1'), size: 256, label: 'EC P-256' },
    'ec-p384': { family: 'ec-p384', algorithm: 'ECDSA', spec: curve('secp384r1'), size: 384, label: 'EC P-384' },
    'ec-p521': { family: 'ec-p521', algorithm: 'ECDSA', spec: curve('secp521r1'), size: 521, label: 'EC P-521' },
    'ml-dsa-44': { family: 'ml-dsa-44', algorithm: 'ML-DSA', spec: mldsa(44, 2), size: 44, label: 'ML-DSA-44' },
    'ml-dsa-65': { family: 'ml-dsa-65', algorithm: 'ML-DSA', spec: mldsa(65, 3), size: 65, label: 'ML-DSA-65' },
    'ml-dsa-87': { family: 'ml-dsa-87', algorithm: 'ML-DSA', spec: mldsa(87, 5), size: 87, label: 'ML-DSA-87' },
    'falcon-1024': { family: 'falcon-1024', algorithm: 'FALCON', spec: [], label: 'FALCON-1024' },
    // SHA2-128s: security category 1, the small signature mode (the SHA2 hash is the provider's fixed v2 parameter).
    'slh-dsa-sha2-128s': {
        family: 'slh-dsa-sha2-128s', algorithm: 'SLH-DSA', label: 'SLH-DSA SHA2-128s',
        spec: [
            { attribute: 'slhdsaSecurityCategory', contentType: 'string', reference: 'CATEGORY_1', data: '1' },
            { attribute: 'slhdsaSignatureMode', contentType: 'string', reference: 'SMALL', data: 'SMALL' },
        ],
    },
    'ml-kem-768': { family: 'ml-kem-768', algorithm: 'ML-KEM', spec: [{ attribute: 'mlkemLevel', contentType: 'integer', reference: 'CATEGORY_3', data: 3 }], size: 768, label: 'ML-KEM-768' },
};

export const SCP_ATTR = {
    keyAlias: { name: 'data_keyAlias', uuid: '61a228de-c54e-461e-b0d7-ad156a547b51' },
    keyAlgorithm: { name: 'data_keyAlgorithm', uuid: '72159c04-d1a9-4703-8b23-469224425d5f' },
    groupKeySpecV1: { name: 'group_keySpec', uuid: 'dfcfb71f-a161-4aa7-8b1f-726b477b3492' },
    groupKeySpecV2: { name: 'group_keySpecV2', uuid: '05927c10-b5ca-43cb-a69f-098885b8c307' },
    rsaKeySize: { name: 'data_rsaKeySize', uuid: 'aa7df6ff-1d64-4a1a-96d6-6c7aeadfbdf3' },
    ecdsaCurve: { name: 'data_ecdsaCurve', uuid: '08730b36-90f3-4046-9f13-3cf827ad6cc7' },
    mldsaLevel: { name: 'data_mldsaLevel', uuid: '22e317d6-dd78-4968-9a26-c1823a4fb2e6' },
    mldsaPrehash: { name: 'data_mldsaPrehash', uuid: 'dd1a8f25-a529-42a6-9c3d-3b9a70fc7e9b' },
    slhdsaSecurityCategory: { name: 'data_slhdsaSecurityCategory', uuid: 'b4d4cf43-d214-42e5-a402-3db66d9c1c6c' },
    slhdsaSignatureMode: { name: 'data_slhdsaSignatureMode', uuid: '7a33f35a-8e32-4bcc-bf3e-37654b6a8107' },
    mlkemLevel: { name: 'data_mlkemLevel', uuid: 'b574e0fb-9db5-4864-9652-40ccf9cff64d' },
    tokenOptions: { name: 'data_options', uuid: '6285683f-f474-4b21-a0ff-56accf28c604' },
    createTokenAction: { name: 'data_createTokenAction', uuid: 'cc781ba3-d90b-4fe9-915a-e8d44e1cff86' },
    newTokenName: { name: 'data_newTokenName', uuid: '21a79858-a246-4b2a-93e1-1677c8beb6a4' },
    tokenCode: { name: 'data_tokenCode', uuid: '181aae19-d2a3-40ca-b5c7-570c8dfbb3cb' },
} as const;

export type Cell = 'G' | 'GS' | 'GSE' | 'absent' | 'obs' | '?';

export const MATRIX: Readonly<Record<Family, Readonly<Record<Provider, Cell>>>> = {
    'rsa-1024': { 'scp-v1': 'obs', 'scp-v2': 'obs', pkcs11: 'absent' },
    'rsa-2048': { 'scp-v1': 'GSE', 'scp-v2': 'GSE', pkcs11: 'GSE' },
    'rsa-3072': { 'scp-v1': 'absent', 'scp-v2': 'absent', pkcs11: '?' },
    'rsa-4096': { 'scp-v1': 'GSE', 'scp-v2': 'GSE', pkcs11: 'GSE' },
    'ec-p256': { 'scp-v1': 'GS', 'scp-v2': 'GS', pkcs11: 'GS' },
    'ec-p384': { 'scp-v1': 'GS', 'scp-v2': 'GS', pkcs11: 'GS' },
    'ec-p521': { 'scp-v1': 'GS', 'scp-v2': 'GS', pkcs11: 'GS' },
    'ml-dsa-44': { 'scp-v1': 'G', 'scp-v2': 'GS', pkcs11: '?' },
    'ml-dsa-65': { 'scp-v1': 'G', 'scp-v2': 'GS', pkcs11: '?' },
    'ml-dsa-87': { 'scp-v1': 'G', 'scp-v2': 'GS', pkcs11: '?' },
    'falcon-1024': { 'scp-v1': 'G', 'scp-v2': 'GS', pkcs11: 'absent' },
    'slh-dsa-sha2-128s': { 'scp-v1': 'G', 'scp-v2': 'GS', pkcs11: '?' },
    'ml-kem-768': { 'scp-v1': 'G', 'scp-v2': 'G', pkcs11: 'absent' },
};

export function generatedFamilies(provider: Provider): Family[] {
    return (Object.keys(MATRIX) as Family[]).filter((f) => MATRIX[f][provider].startsWith('G'));
}

export function signedFamilies(provider: Provider): Family[] {
    return (Object.keys(MATRIX) as Family[]).filter((f) => /^GS/.test(MATRIX[f][provider]));
}

export function encryptedFamilies(provider: Provider): Family[] {
    return (Object.keys(MATRIX) as Family[]).filter((f) => MATRIX[f][provider] === 'GSE');
}

export function absentFamilies(provider: Provider): Family[] {
    return (Object.keys(MATRIX) as Family[]).filter((f) => MATRIX[f][provider] === 'absent');
}

/** Entries that must never appear in a create-key algorithm list (software-cryptography-provider#50). */
const NEVER_OFFERED_ALGORITHMS: readonly string[] = ['Unknown', 'AES', 'CRYSTALS-Dilithium', 'SPHINCS+'];

const MUST_OFFER_ALGORITHMS: Readonly<Record<Provider, readonly Algorithm[]>> = {
    'scp-v1': ['RSA', 'ECDSA', 'ML-DSA', 'FALCON', 'SLH-DSA', 'ML-KEM'],
    'scp-v2': ['RSA', 'ECDSA', 'ML-DSA', 'FALCON', 'SLH-DSA', 'ML-KEM'],
    pkcs11: ['RSA', 'ECDSA'],
};

const MUST_NOT_OFFER_ALGORITHMS: Readonly<Record<Provider, readonly Algorithm[]>> = {
    'scp-v1': [],
    'scp-v2': [],
    pkcs11: ['FALCON'],
};

const SIGN_DIGESTS = ['SHA-256', 'SHA-384', 'SHA-512'] as const;
const RSA_SCHEMES = ['PKCS1-v1_5', 'PSS'] as const;
const FORBIDDEN_DIGESTS = ['MD5', 'SHA-1', 'SHA1'] as const;

export interface SignVariant {
    family: Family;
    scheme?: (typeof RSA_SCHEMES)[number];
    digest?: (typeof SIGN_DIGESTS)[number];
    label: string;
}

export function signVariants(family: Family): SignVariant[] {
    const spec = FAMILIES[family];
    if (spec.algorithm === 'RSA') {
        return RSA_SCHEMES.flatMap((scheme) => SIGN_DIGESTS.map((digest) => ({ family, scheme, digest, label: `${spec.label} ${scheme} ${digest}` })));
    }
    if (spec.algorithm === 'ECDSA') return SIGN_DIGESTS.map((digest) => ({ family, digest, label: `${spec.label} ${digest}` }));
    return [{ family, label: spec.label }];
}


export interface AttributeOption {
    reference?: string;
    data: unknown;
}

export interface AttributeDefinition {
    uuid?: string;
    name: string;
    type?: string;
    contentType?: string;
    content?: AttributeOption[];
    attributeCallback?: unknown;
    properties?: { required?: boolean; list?: boolean };
}

export function offeredAlgorithms(definitions: AttributeDefinition[]): string[] {
    const def = definitions.find((d) => d.name === SCP_ATTR.keyAlgorithm.name || /keyAlgorithm$/i.test(d.name));
    return (def?.content ?? []).map((c) => String(c.reference ?? c.data));
}

export function offeredOptions(definitions: AttributeDefinition[], attributeName: string): string[] {
    const def = definitions.find((d) => d.name === attributeName);
    return (def?.content ?? []).map((c) => String(c.reference ?? c.data));
}

/** The matrix verdict for an algorithm list: missing must-offer names, offered must-not names, and the #50 entries present. */
export function algorithmListProblems(provider: Provider, offered: string[]): { missing: string[]; forbidden: string[]; neverOffered: string[] } {
    const have = new Set(offered.map((s) => s.trim()));
    return {
        missing: MUST_OFFER_ALGORITHMS[provider].filter((a) => !have.has(a)),
        forbidden: MUST_NOT_OFFER_ALGORITHMS[provider].filter((a) => have.has(a)),
        neverOffered: NEVER_OFFERED_ALGORITHMS.filter((a) => have.has(a)),
    };
}

/** Fixed 64 random bytes plus one tampered copy for the verify-false check. */
export const SIGN_DATA_BYTES = 64;

/**
 * Picks the v2 `signatureAlgorithm` option for a variant from the LIVE list, matching by text case-insensitively; undefined when not
 * offered (never guesses).
 */
export function pickSignatureOption(options: AttributeOption[], variant: SignVariant): AttributeOption | undefined {
    const text = (o: AttributeOption) => `${o.reference ?? ''} ${typeof o.data === 'string' ? o.data : JSON.stringify(o.data)}`.toUpperCase();
    const digestRe = variant.digest ? new RegExp(variant.digest.replace('-', '-?'), 'i') : undefined;
    const spec = FAMILIES[variant.family];
    return options.find((o) => {
        const t = text(o);
        if (digestRe && !digestRe.test(t)) return false;
        if (spec.algorithm === 'RSA') {
            if (!/RSA/.test(t)) return false;
            const pss = /PSS/.test(t);
            return variant.scheme === 'PSS' ? pss : !pss;
        }
        if (spec.algorithm === 'ECDSA') return /ECDSA/.test(t);
        if (spec.algorithm === 'ML-DSA') return new RegExp(`ML-?DSA-?${spec.size}`).test(t);
        if (spec.algorithm === 'FALCON') return /FALCON-?1024/.test(t);
        if (spec.algorithm === 'SLH-DSA') return /SLH-?DSA/.test(t);
        return false;
    });
}

/** Core's split selection fields: RSA scheme + digest, ECDSA digest; a post-quantum key keeps the one `signatureAlgorithm`. */
const SPLIT_FIELDS = {
    sigScheme: 'data_rsaSigScheme', sigDigest: 'data_sigDigest', encScheme: 'data_rsaEncScheme', oaepHash: 'data_rsaOaepHash', oaepMgf: 'data_rsaOaepMgf',
} as const;

export interface Selected {
    def: AttributeDefinition;
    option: AttributeOption;
}

const optionText = (o: AttributeOption): string => `${o.reference ?? ''} ${typeof o.data === 'string' ? o.data : JSON.stringify(o.data)}`.toUpperCase();
const codeOf = (v: unknown): string => String(v ?? '').replace(/[-_\s]/g, '').toUpperCase();
const optionWithCode = (def: AttributeDefinition | undefined, code: string): AttributeOption | undefined =>
    (def?.content ?? []).find((o) => codeOf(o.data) === codeOf(code) || codeOf(o.reference) === codeOf(code));

/** The live options that select `variant` (split fields where core serves them, else the one selector); undefined when not offered. */
export function pickSignatureSelection(defs: AttributeDefinition[], variant: SignVariant): Selected[] | undefined {
    const algorithm = FAMILIES[variant.family].algorithm;
    const digestDef = defs.find((d) => d.name === SPLIT_FIELDS.sigDigest);
    if (digestDef && (algorithm === 'RSA' || algorithm === 'ECDSA')) {
        const digest = variant.digest ? optionWithCode(digestDef, variant.digest) : undefined;
        if (!digest) return undefined;
        if (algorithm === 'ECDSA') return [{ def: digestDef, option: digest }];
        const schemeDef = defs.find((d) => d.name === SPLIT_FIELDS.sigScheme);
        const scheme = (schemeDef?.content ?? []).find((o) => {
            const pss = /PSS/.test(optionText(o));
            return variant.scheme === 'PSS' ? pss : !pss && /PKCS/.test(optionText(o));
        });
        return schemeDef && scheme ? [{ def: schemeDef, option: scheme }, { def: digestDef, option: digest }] : undefined;
    }
    const def = defs.find((d) => /signatureAlgorithm/i.test(d.name)) ?? (digestDef ? undefined : defs[0]);
    const option = def ? pickSignatureOption(def.content ?? [], variant) : undefined;
    return def && option ? [{ def, option }] : undefined;
}

/** Every option of every live definition: the digests of a split list sit in their own field. */
export const allOptions = (defs: AttributeDefinition[]): AttributeOption[] => defs.flatMap((d) => d.content ?? []);

export interface CipherChoice {
    label: string;
    scheme: 'PKCS1' | 'OAEP';
    hash?: string;
}

/** The RSA encryption choices the live split fields offer: PKCS#1 v1.5, and OAEP with each offered hash (MGF1 on, core's only OAEP form). */
export function cipherChoices(defs: AttributeDefinition[]): CipherChoice[] {
    const schemes = defs.find((d) => d.name === SPLIT_FIELDS.encScheme)?.content ?? [];
    const out: CipherChoice[] = [];
    if (schemes.some((o) => /PKCS/.test(optionText(o)))) out.push({ label: 'PKCS1-v1_5', scheme: 'PKCS1' });
    if (schemes.some((o) => /OAEP/.test(optionText(o)))) {
        for (const h of defs.find((d) => d.name === SPLIT_FIELDS.oaepHash)?.content ?? []) out.push({ label: `OAEP ${String(h.data)}`, scheme: 'OAEP', hash: String(h.data) });
    }
    return out;
}

/** The live options of one cipher choice; undefined when a field or option is missing. */
export function pickCipherSelection(defs: AttributeDefinition[], choice: CipherChoice): Selected[] | undefined {
    const schemeDef = defs.find((d) => d.name === SPLIT_FIELDS.encScheme);
    const scheme = (schemeDef?.content ?? []).find((o) => (choice.scheme === 'OAEP' ? /OAEP/ : /PKCS/).test(optionText(o)));
    if (!schemeDef || !scheme) return undefined;
    if (choice.scheme === 'PKCS1') return [{ def: schemeDef, option: scheme }];
    const hashDef = defs.find((d) => d.name === SPLIT_FIELDS.oaepHash);
    const mgfDef = defs.find((d) => d.name === SPLIT_FIELDS.oaepMgf);
    const hash = choice.hash ? optionWithCode(hashDef, choice.hash) : undefined;
    if (!hashDef || !hash || !mgfDef) return undefined;
    return [{ def: schemeDef, option: scheme }, { def: hashDef, option: hash }, { def: mgfDef, option: (mgfDef.content ?? []).find((o) => o.data === true) ?? { data: true } }];
}

export function namesForbiddenDigest(options: AttributeOption[]): string[] {
    return options
        .map((o) => `${o.reference ?? ''} ${typeof o.data === 'string' ? o.data : ''}`)
        .filter((t) => FORBIDDEN_DIGESTS.some((d) => new RegExp(`(^|[^A-Z0-9])${d}([^0-9]|$)`, 'i').test(t)));
}


export type Usage = 'sign' | 'verify' | 'encrypt' | 'decrypt' | 'wrap' | 'unwrap';
export const PROFILE_USAGES: readonly Usage[] = ['sign', 'verify', 'encrypt', 'decrypt'];

/**
 * The usages a key item gets at creation: private never VERIFY / ENCRYPT /
 * WRAP, public never SIGN / DECRYPT / UNWRAP, ECDSA never ENCRYPT / DECRYPT.
 */
export function expectedItemUsages(profileUsages: readonly Usage[], item: 'private' | 'public', algorithm: Algorithm | string): Usage[] {
    const forbidden = new Set<Usage>(item === 'private' ? ['verify', 'encrypt', 'wrap'] : ['sign', 'decrypt', 'unwrap']);
    if (algorithm === 'ECDSA') {
        forbidden.add('encrypt');
        forbidden.add('decrypt');
    }
    return profileUsages.filter((u) => !forbidden.has(u));
}

export const sameUsages = (a: readonly string[], b: readonly string[]): boolean => [...a].sort().join(',') === [...b].sort().join(',');
