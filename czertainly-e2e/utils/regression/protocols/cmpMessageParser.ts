/**
 * cmpMessageParser — reads a CMP PKIMessage (DER): the body type and, for an `error` body, the PKIStatusInfo; the builder makes error
 * messages for the reader's unit tests.
 */
import * as forge from 'node-forge';

export const PKI_FAILURE_INFO: readonly string[] = [
    'badAlg', 'badMessageCheck', 'badRequest', 'badTime', 'badCertId', 'badDataFormat', 'wrongAuthority', 'incorrectData',
    'missingTimeStamp', 'badPOP', 'certRevoked', 'certConfirmed', 'wrongIntegrity', 'badRecipientNonce', 'timeNotAvailable',
    'unacceptedPolicy', 'unacceptedExtension', 'addInfoNotAvailable', 'badSenderNonce', 'badCertTemplate', 'signerNotTrusted',
    'transactionIdInUse', 'unsupportedVersion', 'notAuthorized', 'systemUnavail', 'systemFailure', 'duplicateCertReq',
];

const PKI_STATUS: readonly string[] = ['accepted', 'grantedWithMods', 'rejection', 'waiting', 'revocationWarning', 'revocationNotification', 'keyUpdateWarning'];

const PKI_BODY_TYPES: Readonly<Record<number, string>> = {
    0: 'ir', 1: 'ip', 2: 'cr', 3: 'cp', 4: 'p10cr', 5: 'popdecc', 6: 'popdecr', 7: 'kur', 8: 'kup', 9: 'krr', 10: 'krp', 11: 'rr', 12: 'rp',
    13: 'ccr', 14: 'ccp', 15: 'ckuann', 16: 'cann', 17: 'rann', 18: 'crlann', 19: 'pkiconf', 20: 'nested', 21: 'genm', 22: 'genp',
    23: 'error', 24: 'certConf', 25: 'pollReq', 26: 'pollRep',
};

interface PkiStatusInfo {
    status: number;
    statusLabel: string;
    statusStrings: string[];
    failInfo: string[];
}

export interface ParsedPkiMessage {
    pvno?: number;
    bodyType: number;
    bodyName: string;
    error?: PkiStatusInfo & { errorCode?: number; errorDetails: string[] };
    protected: boolean;
}

type Asn1 = forge.asn1.Asn1;

const { Class, Type } = forge.asn1;

export const fromDerRaw = (der: Buffer): Asn1 =>
    (forge.asn1.fromDer as unknown as (bytes: forge.util.ByteBuffer, options: { strict?: boolean; decodeBitStrings?: boolean }) => Asn1)(
        forge.util.createBuffer(der.toString('binary')), { decodeBitStrings: false });

const isContext = (node: Asn1, tag: number): boolean => node.tagClass === Class.CONTEXT_SPECIFIC && node.type === tag;
const isUniversal = (node: Asn1, type: number): boolean => node.tagClass === Class.UNIVERSAL && node.type === type;
const children = (node: Asn1): Asn1[] => (Array.isArray(node.value) ? (node.value as Asn1[]) : []);
const bytesOf = (node: Asn1): Buffer => Buffer.from(typeof node.value === 'string' ? node.value : '', 'binary');

function integerOf(node: Asn1): number {
    const b = bytesOf(node);
    if (b.length === 0) return 0;
    let v = 0;
    for (const x of b) v = v * 256 + x;
    return b[0] & 0x80 ? v - 2 ** (8 * b.length) : v;
}

export function failInfoBits(node: Asn1): string[] {
    const b = bytesOf(node);
    if (b.length < 1) return [];
    const unused = b[0];
    const out: string[] = [];
    const totalBits = (b.length - 1) * 8 - unused;
    for (let i = 0; i < totalBits; i++) {
        const byte = b[1 + (i >> 3)];
        if (byte & (0x80 >> (i & 7))) out.push(PKI_FAILURE_INFO[i] ?? `bit${i}`);
    }
    return out;
}

function freeText(node: Asn1 | undefined): string[] {
    if (!node || !isUniversal(node, Type.SEQUENCE)) return [];
    return children(node).filter((c) => isUniversal(c, Type.UTF8)).map((c) => bytesOf(c).toString('utf8'));
}

function statusInfo(node: Asn1): PkiStatusInfo {
    if (!isUniversal(node, Type.SEQUENCE)) throw new Error('PKIStatusInfo is not a SEQUENCE');
    const parts = children(node);
    const status = parts[0] && isUniversal(parts[0], Type.INTEGER) ? integerOf(parts[0]) : -1;
    const strings = freeText(parts.find((p) => isUniversal(p, Type.SEQUENCE)));
    const bits = parts.find((p) => isUniversal(p, Type.BITSTRING));
    return { status, statusLabel: PKI_STATUS[status] ?? `status${status}`, statusStrings: strings, failInfo: bits ? failInfoBits(bits) : [] };
}

export function parsePkiMessage(der: Buffer): ParsedPkiMessage {
    let root: Asn1;
    try {
        // decodeBitStrings: false — a PKIFailureInfo BIT STRING must stay bytes (forge would otherwise try to read it as nested ASN.1).
        root = fromDerRaw(der);
    } catch (e) {
        throw new Error(`not DER: ${String((e as Error).message ?? e)}`);
    }
    if (!isUniversal(root, Type.SEQUENCE)) throw new Error('PKIMessage is not a SEQUENCE');
    const [header, body, ...rest] = children(root);
    if (!header || !isUniversal(header, Type.SEQUENCE)) throw new Error('PKIMessage has no header SEQUENCE');
    if (!body || body.tagClass !== Class.CONTEXT_SPECIFIC) throw new Error('PKIMessage has no tagged body');
    const pvnoNode = children(header)[0];
    const pvno = pvnoNode && isUniversal(pvnoNode, Type.INTEGER) ? integerOf(pvnoNode) : undefined;
    const bodyType = body.type;
    const out: ParsedPkiMessage = {
        ...(pvno !== undefined ? { pvno } : {}),
        bodyType,
        bodyName: PKI_BODY_TYPES[bodyType] ?? `body${bodyType}`,
        protected: rest.some((r) => isContext(r, 0)),
    };
    if (bodyType === 23) {
        const content = children(body)[0];
        if (!content || !isUniversal(content, Type.SEQUENCE)) throw new Error('error body without ErrorMsgContent');
        const [info, ...more] = children(content);
        const errorCode = more.find((m) => isUniversal(m, Type.INTEGER));
        const details = more.find((m) => isUniversal(m, Type.SEQUENCE));
        out.error = { ...statusInfo(info), ...(errorCode ? { errorCode: integerOf(errorCode) } : {}), errorDetails: freeText(details) };
    }
    return out;
}

/**
 * A minimal unprotected PKIMessage with an `error` body (the shape ILM answers an unparseable request with); fixture for the reader's unit
 * tests and the truncated-DER case.
 */
export function buildErrorPkiMessage(o: { failInfoBits: number[]; statusString?: string; status?: number; pvno?: number; errorDetails?: string }): Buffer {
    const a = forge.asn1;
    const int = (n: number) => a.create(Class.UNIVERSAL, Type.INTEGER, false, String.fromCharCode(n));
    const utf8 = (s: string) => a.create(Class.UNIVERSAL, Type.UTF8, false, Buffer.from(s, 'utf8').toString('binary'));
    const nullName = () => a.create(Class.CONTEXT_SPECIFIC, 4, true, [a.create(Class.UNIVERSAL, Type.SEQUENCE, true, [])]);
    const maxBit = Math.max(-1, ...o.failInfoBits);
    const byteCount = maxBit < 0 ? 1 : Math.floor(maxBit / 8) + 1;
    const bytes = new Array<number>(byteCount).fill(0);
    for (const bit of o.failInfoBits) bytes[bit >> 3] |= 0x80 >> (bit & 7);
    const unused = maxBit < 0 ? 8 * byteCount : 8 * byteCount - (maxBit + 1);
    const bitString = a.create(Class.UNIVERSAL, Type.BITSTRING, false, String.fromCharCode(unused, ...bytes));
    const statusInfo = a.create(Class.UNIVERSAL, Type.SEQUENCE, true, [
        int(o.status ?? 2),
        ...(o.statusString !== undefined ? [a.create(Class.UNIVERSAL, Type.SEQUENCE, true, [utf8(o.statusString)])] : []),
        bitString,
    ]);
    const errorContent = a.create(Class.UNIVERSAL, Type.SEQUENCE, true, [
        statusInfo,
        ...(o.errorDetails !== undefined ? [a.create(Class.UNIVERSAL, Type.SEQUENCE, true, [utf8(o.errorDetails)])] : []),
    ]);
    const header = a.create(Class.UNIVERSAL, Type.SEQUENCE, true, [int(o.pvno ?? 2), nullName(), nullName()]);
    const body = a.create(Class.CONTEXT_SPECIFIC, 23, true, [errorContent]);
    const message = a.create(Class.UNIVERSAL, Type.SEQUENCE, true, [header, body]);
    return Buffer.from(a.toDer(message).getBytes(), 'binary');
}

export function errorRejectionProblems(message: ParsedPkiMessage): string[] {
    const problems: string[] = [];
    if (message.bodyName !== 'error') problems.push(`body is ${message.bodyName} (${message.bodyType}), not error (23)`);
    else if (message.error!.statusLabel !== 'rejection') problems.push(`status is ${message.error!.statusLabel} (${message.error!.status}), not rejection (2)`);
    return problems;
}
