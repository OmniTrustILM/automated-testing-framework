import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

// Never propagate fetch/JSON errors: they can include a bearer header, body or credential URL.
export async function http(url, options = {}, statuses = [200, 201, 204]) {
    let response;
    try { response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error('HTTP transport failed (details withheld)'); }
    if (!statuses.includes(response.status)) throw new Error(`HTTP request failed (status ${response.status}; contents withheld)`);
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
}

export async function json(url, options = {}) {
    const response = await http(url, options);
    try { return JSON.parse(response.body.toString()); }
    catch { throw new Error('Invalid JSON response (contents withheld)'); }
}

export function claims(token) {
    try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
    catch { throw new Error('Invalid token response (contents withheld)'); }
}

export function signer(issuer, username, audience) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = randomUUID();
    return {
        jwkSet: Buffer.from(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] })).toString('base64'),
        token(act) {
            const now = Math.floor(Date.now() / 1000);
            const payload = { iss: issuer, sub: username, preferred_username: username, aud: audience, iat: now, nbf: now - 1, exp: now + 300, jti: randomUUID() };
            if (act !== undefined) payload.act = act;
            const unsigned = [JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }), JSON.stringify(payload)].map(value => Buffer.from(value).toString('base64url')).join('.');
            return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
        },
    };
}

export function requireDisposable(env) {
    if (env.DELEGATION_DISPOSABLE !== 'true') throw new Error('Set DELEGATION_DISPOSABLE=true for an isolated test deployment');
}

// Report only presence: matching credential values must never be returned or printed.
export function containsFullJwt(text) {
    return /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16,}/.test(text);
}

// RFC3161 v1, SHA256, a 32-byte zero imprint, certReq=true. No signing secret is needed.
export function timestampRequest() {
    return Buffer.from('30390201013031300d060960864801650304020105000420' + '00'.repeat(32) + '0101ff', 'hex');
}

export function timestampStatus(bytes) {
    function tlv(offset, tag) {
        if (bytes[offset++] !== tag) throw new Error('Invalid timestamp response');
        let length = bytes[offset++];
        if (length & 0x80) {
            const count = length & 0x7f;
            if (count < 1 || count > 4) throw new Error('Invalid timestamp response');
            length = 0;
            for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++];
        }
        if (!Number.isFinite(length) || offset + length > bytes.length) throw new Error('Invalid timestamp response');
        return { offset, length };
    }
    const outer = tlv(0, 0x30);
    const info = tlv(outer.offset, 0x30);
    const status = tlv(info.offset, 0x02);
    if (status.length !== 1) throw new Error('Invalid timestamp response');
    return bytes[status.offset];
}

// Java's default export is ZIP with a data descriptor; locate sizes in its central directory.
export function exportRows(body, separator = ',') {
    if (body.readUInt16LE(0) === 0x4b50) {
        const method = body.readUInt16LE(8);
        const central = body.lastIndexOf(Buffer.from('504b0102', 'hex'));
        const size = central >= 0 ? body.readUInt32LE(central + 20) : body.readUInt32LE(18);
        const start = 30 + body.readUInt16LE(26) + body.readUInt16LE(28);
        const compressed = body.subarray(start, start + size);
        if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression');
        body = method === 8 ? inflateRawSync(compressed) : compressed;
    }
    const text = body.toString('utf8').replace(/^\ufeff/, '');
    const rows = []; let row = []; let value = ''; let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted && ch === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
            value += text[++i];
        } else if (ch === '"') {
            if (quoted && text[i + 1] === '"') { value += '"'; i++; }
            else quoted = !quoted;
        } else if (!quoted && (ch === separator || ch === '\n')) {
            row.push(value.replace(/\r$/, '')); value = '';
            if (ch === '\n') { rows.push(row); row = []; }
        } else value += ch;
    }
    if (quoted) throw new Error('Invalid CSV quoting');
    if (value || row.length) { row.push(value); rows.push(row); }
    const header = rows.shift();
    return rows.map(cells => {
        if (cells.length !== header.length) throw new Error('Invalid CSV columns');
        return Object.fromEntries(header.map((key, index) => [key, cells[index]]));
    });
}
