/**
 * cryptoAlgorithmCases — the key algorithm cases as data.
 *
 * WHAT: the key algorithm cases as data: per provider what must be offered, must not be offered, and
 *       which cells the tests run (generate, sign / verify, encrypt / decrypt), with the software cryptography provider's
 *       attribute names. Pure data and functions; the live attribute definitions are still read before a key is made.
 * WHY: The algorithm matrix must be read as data, with the provider's names in one place.
 * HOW: Per provider what must be offered, must not be offered and which cells run; pure, while the live attribute definitions are still
 * read before a key is made.
 */

export type Provider = 'scp-v1' | 'scp-v2' | 'pkcs11';

/** A key family the suite can generate (one row of the matrix). */
export type Family = 'rsa-1024' | 'rsa-2048' | 'rsa-3072' | 'rsa-4096' | 'ec-p256' | 'ec-p384' | 'ec-p521' | 'ml-dsa-44' | 'ml-dsa-65' | 'ml-dsa-87' | 'falcon-1024' | 'slh-dsa-sha2-128s' | 'ml-kem-768';

export type Algorithm = 'RSA' | 'ECDSA' | 'ML-DSA' | 'FALCON' | 'SLH-DSA' | 'ML-KEM';

export interface FamilySpec {
    family: Family;
    algorithm: Algorithm;
    /** The SCP option: `RSA_2048`, `secp256r1`, `MLDSA_65`, … (the `reference` of the attribute content). */
    option?: string;
    /** The option's `data` (SCP: the integer size for RSA, the curve name for EC, the NIST category for ML-DSA). */
    optionData?: string | number;
    /** Key size (bits) or the ML-DSA level, for the detail assertions. */
    size?: number;
    /** Readable label used in test titles. */
    label: string;
}

export const FAMILIES: Readonly<Record<Family, FamilySpec>> = {
    'rsa-1024': { family: 'rsa-1024', algorithm: 'RSA', option: 'RSA_1024', optionData: 1024, size: 1024, label: 'RSA 1024' },
    'rsa-2048': { family: 'rsa-2048', algorithm: 'RSA', option: 'RSA_2048', optionData: 2048, size: 2048, label: 'RSA 2048' },
    'rsa-3072': { family: 'rsa-3072', algorithm: 'RSA', option: 'RSA_3072', optionData: 3072, size: 3072, label: 'RSA 3072' },
    'rsa-4096': { family: 'rsa-4096', algorithm: 'RSA', option: 'RSA_4096', optionData: 4096, size: 4096, label: 'RSA 4096' },
    'ec-p256': { family: 'ec-p256', algorithm: 'ECDSA', option: 'secp256r1', optionData: 'secp256r1', size: 256, label: 'EC P-256' },
    'ec-p384': { family: 'ec-p384', algorithm: 'ECDSA', option: 'secp384r1', optionData: 'secp384r1', size: 384, label: 'EC P-384' },
    'ec-p521': { family: 'ec-p521', algorithm: 'ECDSA', option: 'secp521r1', optionData: 'secp521r1', size: 521, label: 'EC P-521' },
    'ml-dsa-44': { family: 'ml-dsa-44', algorithm: 'ML-DSA', option: 'MLDSA_44', optionData: 2, size: 44, label: 'ML-DSA-44' },
    'ml-dsa-65': { family: 'ml-dsa-65', algorithm: 'ML-DSA', option: 'MLDSA_65', optionData: 3, size: 65, label: 'ML-DSA-65' },
    'ml-dsa-87': { family: 'ml-dsa-87', algorithm: 'ML-DSA', option: 'MLDSA_87', optionData: 5, size: 87, label: 'ML-DSA-87' },
    'falcon-1024': { family: 'falcon-1024', algorithm: 'FALCON', label: 'FALCON-1024' },
    'slh-dsa-sha2-128s': { family: 'slh-dsa-sha2-128s', algorithm: 'SLH-DSA', option: 'SLHDSA_SHA2_128S', optionData: 'SLHDSA_SHA2_128S', label: 'SLH-DSA SHA2-128s' },
    'ml-kem-768': { family: 'ml-kem-768', algorithm: 'ML-KEM', option: 'MLKEM_768', optionData: 3, size: 768, label: 'ML-KEM-768' },
};

/** The SCP attribute names and uuids a key create sends (connector constants). */
export const SCP_ATTR = {
    keyAlias: { name: 'data_keyAlias', uuid: '61a228de-c54e-461e-b0d7-ad156a547b51' },
    keyAlgorithm: { name: 'data_keyAlgorithm', uuid: '72159c04-d1a9-4703-8b23-469224425d5f' },
    groupKeySpecV1: { name: 'group_keySpec', uuid: 'dfcfb71f-a161-4aa7-8b1f-726b477b3492' },
    groupKeySpecV2: { name: 'group_keySpecV2', uuid: '05927c10-b5ca-43cb-a69f-098885b8c307' },
    rsaKeySize: { name: 'data_rsaKeySize', uuid: 'aa7df6ff-1d64-4a1a-96d6-6c7aeadfbdf3' },
    ecdsaCurve: { name: 'data_ecdsaCurve', uuid: '08730b36-90f3-4046-9f13-3cf827ad6cc7' },
    mldsaLevel: { name: 'data_mldsaLevel', uuid: '22e317d6-dd78-4968-9a26-c1823a4fb2e6' },
    mldsaPrehash: { name: 'data_mldsaPrehash', uuid: 'dd1a8f25-a529-42a6-9c3d-3b9a70fc7e9b' },
    // Token attributes (TokenInstanceAttributes.java): the same schema on the v1 and the v2 record.
    tokenOptions: { name: 'data_options', uuid: '6285683f-f474-4b21-a0ff-56accf28c604' },
    createTokenAction: { name: 'data_createTokenAction', uuid: 'cc781ba3-d90b-4fe9-915a-e8d44e1cff86' },
    newTokenName: { name: 'data_newTokenName', uuid: '21a79858-a246-4b2a-93e1-1677c8beb6a4' },
    tokenCode: { name: 'data_tokenCode', uuid: '181aae19-d2a3-40ca-b5c7-570c8dfbb3cb' },
} as const;

/** The key-spec attribute (name) each family's size / curve / level goes into on the SCP; FALCON has none (fixed 1024). */
export function specAttributeOf(family: Family): { name: string; uuid: string; contentType: 'integer' | 'string' } | undefined {
    const spec = FAMILIES[family];
    switch (spec.algorithm) {
        case 'RSA': return { ...SCP_ATTR.rsaKeySize, contentType: 'integer' };
        case 'ECDSA': return { ...SCP_ATTR.ecdsaCurve, contentType: 'string' };
        case 'ML-DSA': return { ...SCP_ATTR.mldsaLevel, contentType: 'integer' };
        default: return undefined;
    }
}

// ------------------------------------------------------------------ the matrix cells

/** `G` generate, `S` sign / verify, `E` RSA encrypt / decrypt, `absent` must NOT be offered, `obs` observed only, `?` token-dependent. */
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

/** Families the suite generates on a provider (the `G*` cells), in matrix order. */
export function generatedFamilies(provider: Provider): Family[] {
    return (Object.keys(MATRIX) as Family[]).filter((f) => MATRIX[f][provider].startsWith('G'));
}

/** Families whose sign / verify round trip is executed on a provider (`GS` / `GSE`). */
export function signedFamilies(provider: Provider): Family[] {
    return (Object.keys(MATRIX) as Family[]).filter((f) => /^GS/.test(MATRIX[f][provider]));
}

/** Families whose RSA encrypt / decrypt round trip is executed (`GSE`). */
export function encryptedFamilies(provider: Provider): Family[] {
    return (Object.keys(MATRIX) as Family[]).filter((f) => MATRIX[f][provider] === 'GSE');
}

/** Families that must NOT be offered on a provider (`absent`). */
export function absentFamilies(provider: Provider): Family[] {
    return (Object.keys(MATRIX) as Family[]).filter((f) => MATRIX[f][provider] === 'absent');
}

/**
 * Algorithm entries that must never appear in a create-key algorithm list (software-cryptography-provider#50: Unknown / AES / deprecated
 * names).
 */
const NEVER_OFFERED_ALGORITHMS: readonly string[] = ['Unknown', 'AES', 'CRYSTALS-Dilithium', 'SPHINCS+'];

/** The must-offer algorithm list per provider (SoftHSM behind PKCS#11 reports RSA and ECDSA only, ilm#415). */
const MUST_OFFER_ALGORITHMS: Readonly<Record<Provider, readonly Algorithm[]>> = {
    'scp-v1': ['RSA', 'ECDSA', 'ML-DSA', 'FALCON', 'SLH-DSA', 'ML-KEM'],
    'scp-v2': ['RSA', 'ECDSA', 'ML-DSA', 'FALCON', 'SLH-DSA', 'ML-KEM'],
    pkcs11: ['RSA', 'ECDSA'],
};

/** The must-not-offer algorithm list per provider. */
const MUST_NOT_OFFER_ALGORITHMS: Readonly<Record<Provider, readonly Algorithm[]>> = {
    'scp-v1': [],
    'scp-v2': [],
    pkcs11: ['FALCON'],
};

/** Sign digests executed on RSA / ECDSA (v2 lists hold SHA-2 only, never MD5 / SHA-1 — API-KEY-15). */
const SIGN_DIGESTS = ['SHA-256', 'SHA-384', 'SHA-512'] as const;
const RSA_SCHEMES = ['PKCS1-v1_5', 'PSS'] as const;
const FORBIDDEN_DIGESTS = ['MD5', 'SHA-1', 'SHA1'] as const;

export interface SignVariant {
    family: Family;
    scheme?: (typeof RSA_SCHEMES)[number];
    digest?: (typeof SIGN_DIGESTS)[number];
    label: string;
}

/** The full-factorial sign / verify variants of the matrix for one family (API-KEY-13): RSA scheme × digest, EC digest, PQC one. */
export function signVariants(family: Family): SignVariant[] {
    const spec = FAMILIES[family];
    if (spec.algorithm === 'RSA') {
        return RSA_SCHEMES.flatMap((scheme) => SIGN_DIGESTS.map((digest) => ({ family, scheme, digest, label: `${spec.label} ${scheme} ${digest}` })));
    }
    if (spec.algorithm === 'ECDSA') return SIGN_DIGESTS.map((digest) => ({ family, digest, label: `${spec.label} ${digest}` }));
    return [{ family, label: spec.label }];
}

// ------------------------------------------------------------------ reading a live attribute list

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
    /** NG attributes: the callback declaration (a group with `dependsOn`). */
    attributeCallback?: unknown;
    properties?: { required?: boolean; list?: boolean };
}

/** The algorithm names a create-key definition list offers (`data_keyAlgorithm` content references / data). */
export function offeredAlgorithms(definitions: AttributeDefinition[]): string[] {
    const def = definitions.find((d) => d.name === SCP_ATTR.keyAlgorithm.name || /keyAlgorithm$/i.test(d.name));
    return (def?.content ?? []).map((c) => String(c.reference ?? c.data));
}

/** The option values (references) a definition offers, by attribute name (`data_rsaKeySize` → `RSA_2048`, …). */
export function offeredOptions(definitions: AttributeDefinition[], attributeName: string): string[] {
    const def = definitions.find((d) => d.name === attributeName);
    return (def?.content ?? []).map((c) => String(c.reference ?? c.data));
}

/**
 * The matrix verdict for an algorithm list (API-KEY-09): names that must be offered but are not, names that must not be
 * offered but are, and the software-cryptography-provider#50 entries (Unknown / AES / deprecated) that are present.
 */
export function algorithmListProblems(provider: Provider, offered: string[]): { missing: string[]; forbidden: string[]; neverOffered: string[] } {
    const have = new Set(offered.map((s) => s.trim()));
    return {
        missing: MUST_OFFER_ALGORITHMS[provider].filter((a) => !have.has(a)),
        forbidden: MUST_NOT_OFFER_ALGORITHMS[provider].filter((a) => have.has(a)),
        neverOffered: NEVER_OFFERED_ALGORITHMS.filter((a) => have.has(a)),
    };
}

/** Every label a verify-false / tamper check uses (fixed 64 random bytes plus one tampered copy, the matrix execution policy). */
export const SIGN_DATA_BYTES = 64;

/**
 * Picks the v2 `signatureAlgorithm` option for a sign variant from the LIVE option list of the sign-attribute
 * definition: RSA = scheme + digest, ECDSA = digest, ML-DSA / FALCON = the single family option. Matching is by the
 * option's text (reference, then data), case-insensitively, digests with or without the dash. Returns the option, or
 * undefined (the caller reports "not offered", never guesses).
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

/** True when any option of a v2 sign list names a forbidden digest (API-KEY-15 / 13 guard: no MD5 / SHA-1 anywhere). */
export function namesForbiddenDigest(options: AttributeOption[]): string[] {
    return options
        .map((o) => `${o.reference ?? ''} ${typeof o.data === 'string' ? o.data : ''}`)
        .filter((t) => FORBIDDEN_DIGESTS.some((d) => new RegExp(`(^|[^A-Z0-9])${d}([^0-9]|$)`, 'i').test(t)));
}

// ------------------------------------------------------------------ usages

export type Usage = 'sign' | 'verify' | 'encrypt' | 'decrypt' | 'wrap' | 'unwrap';
export const PROFILE_USAGES: readonly Usage[] = ['sign', 'verify', 'encrypt', 'decrypt'];

/**
 * The usages a key ITEM gets at creation from the profile's usages (core's `CryptographyUtil`): the private item never VERIFY / ENCRYPT /
 * WRAP, the public item never SIGN / DECRYPT / UNWRAP, and an ECDSA item never ENCRYPT / DECRYPT.
 */
export function expectedItemUsages(profileUsages: readonly Usage[], item: 'private' | 'public', algorithm: Algorithm | string): Usage[] {
    const forbidden = new Set<Usage>(item === 'private' ? ['verify', 'encrypt', 'wrap'] : ['sign', 'decrypt', 'unwrap']);
    if (algorithm === 'ECDSA') {
        forbidden.add('encrypt');
        forbidden.add('decrypt');
    }
    return profileUsages.filter((u) => !forbidden.has(u));
}

/** Same set regardless of order (usages are a set on the wire). */
export const sameUsages = (a: readonly string[], b: readonly string[]): boolean => [...a].sort().join(',') === [...b].sort().join(',');
