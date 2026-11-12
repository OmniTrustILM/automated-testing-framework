/**
 * acmeClient — a minimal RFC 8555 client (ES256, node:crypto): directory, nonce, account, order, finalize, poll and
 * download, with the response headers of every answer. Challenges are not answered (the test ACME profile
 * pre-authorizes its identifier); revocation is left to the run-end teardown. Signed POSTs go through
 * `allowedRawPost`, which accepts protocol paths only, and the client sends no credentials.
 */
import * as crypto from 'crypto';
import { Logger } from '../../Logger';
import { allowedRawPost } from '../guard/rawPost';
import { base64Url } from '../text';
import { pollUntil } from '../wait';

const logger = new Logger('AcmeClient');

export interface AcmeResponse<T = any> {
    status: number;
    location?: string;
    body: T;
    /** Every response header, lower-case names. */
    headers: Record<string, string>;
    /** `Retry-After` as sent (RFC 8555 §7.4: on new-account, new-order, finalize, order reads). */
    retryAfter?: string;
    /** `Replay-Nonce` as sent. */
    replayNonce?: string;
    /** `Content-Type` as sent. */
    contentType?: string;
    /** The server's clock (`Date` header), for oracles relative to the server's "now". */
    date?: Date;
}

/** The headers of a fetch Response as a plain object (lower-case names) plus the read-outs of AcmeResponse. */
export function acmeHeaders(res: { headers: { forEach(cb: (value: string, name: string) => void): void } }): Pick<AcmeResponse, 'headers' | 'retryAfter' | 'replayNonce' | 'contentType' | 'date' | 'location'> {
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
    });
    const t = headers.date ? Date.parse(headers.date) : NaN;
    return {
        headers,
        retryAfter: headers['retry-after'],
        replayNonce: headers['replay-nonce'],
        contentType: headers['content-type'],
        location: headers.location,
        ...(Number.isNaN(t) ? {} : { date: new Date(t) }),
    };
}

export class AcmeClient {
    private readonly keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    private readonly jwk = this.keys.publicKey.export({ format: 'jwk' }) as Record<string, string>;
    private nonce?: string;
    private kid?: string;
    directory!: Record<string, any>;

    constructor(private readonly directoryUrl: string) {}

    async init(): Promise<Record<string, any>> {
        const res = await fetch(this.directoryUrl);
        if (!res.ok) throw new Error(`ACME directory ${this.directoryUrl} → ${res.status}`);
        this.directory = await res.json();
        return this.directory;
    }

    get accountUrl(): string | undefined {
        return this.kid;
    }

    private async freshNonce(): Promise<string> {
        const res = await fetch(this.directory.newNonce, { method: 'HEAD' });
        const nonce = res.headers.get('replay-nonce');
        if (!nonce) throw new Error(`no Replay-Nonce from ${this.directory.newNonce} (${res.status})`);
        return nonce;
    }

    /** Signed POST (payload `''` = POST-as-GET) to an ILM protocol URL. Retries once on badNonce. */
    async signedPost<T = any>(url: string, payload: object | '', accept?: string, retried = false): Promise<AcmeResponse<T>> {
        const nonce = this.nonce ?? (await this.freshNonce());
        this.nonce = undefined;
        const header = { alg: 'ES256', nonce, url, ...(this.kid ? { kid: this.kid } : { jwk: this.jwk }) };
        const protectedB64 = base64Url(JSON.stringify(header));
        const payloadB64 = payload === '' ? '' : base64Url(JSON.stringify(payload));
        const signature = crypto.sign('sha256', Buffer.from(`${protectedB64}.${payloadB64}`), { key: this.keys.privateKey, dsaEncoding: 'ieee-p1363' });
        const res = await fetch(allowedRawPost(url, { unauthenticated: true }), {
            method: 'POST',
            headers: { 'content-type': 'application/jose+json', ...(accept ? { accept } : {}) },
            body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature: base64Url(signature) }),
        });
        this.nonce = res.headers.get('replay-nonce') ?? undefined;
        const text = await res.text();
        let body: any = text;
        try {
            body = JSON.parse(text);
        } catch {
            /* PEM or empty */
        }
        if (res.status === 400 && String(body?.type ?? '').endsWith(':badNonce') && !retried) return this.signedPost(url, payload, accept, true);
        logger.debug(`POST ${url} → ${res.status}`);
        return { status: res.status, body, ...acmeHeaders(res) };
    }

    async newAccount(email: string): Promise<AcmeResponse> {
        const res = await this.signedPost(this.directory.newAccount, { termsOfServiceAgreed: true, contact: [`mailto:${email}`] });
        if (res.status >= 300) throw new Error(`newAccount → ${res.status} ${JSON.stringify(res.body)}`);
        this.kid = res.location;
        return res;
    }

    async newOrder(dnsNames: string[]): Promise<AcmeResponse> {
        return this.signedPost(this.directory.newOrder, { identifiers: dnsNames.map((value) => ({ type: 'dns', value })) });
    }

    async get<T = any>(url: string, accept?: string): Promise<AcmeResponse<T>> {
        return this.signedPost<T>(url, '', accept);
    }

    async finalize(finalizeUrl: string, csrDerBase64Url: string): Promise<AcmeResponse> {
        return this.signedPost(finalizeUrl, { csr: csrDerBase64Url });
    }

    /**
     * REG-PROT-01 (RFC 8555 §7.6): `POST revoke-cert` signed with the ACCOUNT key (`kid`), the
     * certificate as base64url DER; `reason` omitted = the server's default (unspecified). No client-side guard: a
     * second revoke of the same certificate is the test (400 `alreadyRevoked`).
     */
    async revokeCert(certificateDerBase64Url: string, reason?: number): Promise<AcmeResponse> {
        return this.signedPost(this.directory.revokeCert, { certificate: certificateDerBase64Url, ...(reason !== undefined ? { reason } : {}) });
    }

    /** Poll an order until it leaves pending/ready/processing. */
    async waitForOrder(orderUrl: string, timeoutMs = 180_000): Promise<Record<string, any>> {
        const order = await pollUntil(
            async () => (await this.get(orderUrl)).body as Record<string, any>,
            (body) => !['pending', 'ready', 'processing'].includes(body.status),
            { timeoutMs, intervalMs: 3000, tolerateErrors: 0, onTimeout: 'return' },
        );
        return order as Record<string, any>;
    }

    async downloadCertificate(certificateUrl: string): Promise<string> {
        const res = await this.downloadCertificateResponse(certificateUrl);
        if (res.status !== 200) throw new Error(`certificate download → ${res.status} ${String(res.body).slice(0, 300)}`);
        return String(res.body);
    }

    /** The download as an AcmeResponse (status, `Content-Type`, the PEM chain as `body`): REG-USE-05.1 checks the headers. */
    async downloadCertificateResponse(certificateUrl: string): Promise<AcmeResponse<string>> {
        const res = await this.get<string>(certificateUrl, 'application/pem-certificate-chain');
        return { ...res, body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body) };
    }
}
