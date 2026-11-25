/**
 * estHttp — raw EST (RFC 7030) client on Node's https module.
 *
 * WHAT: builds and sends EST requests under `<base>/.well-known/est[/<label>]/<op>` and returns
 * status, lowercased headers and the raw body.
 * WHY: the specs must control what goes on the wire — a forged `ssl-client-cert` header, a
 * client certificate, a malformed body, a query string — which Playwright's request context and
 * real EST clients do not allow.
 * HOW: `buildEstRequest` is pure and returns the `https.RequestOptions` and the body; `estRequest`
 * sends it. The edge's certificate is verified against `EST_EDGE_CA_CERT` when it is set, else against the
 * system trust store, and the SNI name is the URL's host (none for an IP address). EST bodies are base64 text;
 * `decodeBase64Body` turns them back into DER.
 */

import * as fs from 'fs';
import * as https from 'https';
import { isIP } from 'net';

export interface EstRequestOptions {
  baseUrl: string;
  op: string;
  label?: string;
  method?: string;
  query?: Record<string, string>;
  /** Sent as `Content-Type`, e.g. `application/pkcs10`. */
  contentType?: string;
  body?: Buffer | string;
  basicAuth?: { username: string; password: string };
  headers?: Record<string, string>;
  /** PEM client certificate and key for mutual TLS. */
  clientCert?: { cert: string; key: string };
  /** PEM CA the edge's certificate chains to; defaults to the file `EST_EDGE_CA_CERT` names. */
  ca?: string;
  /** Milliseconds after which the request is destroyed and rejected; defaults to 30 seconds. */
  timeoutMs?: number;
}

export interface EstResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const DEFAULT_TIMEOUT_MS = 30_000;

let edgeCaFromEnv: string | undefined;

/** The CA in the file `EST_EDGE_CA_CERT` names, read once; undefined when the variable is unset. */
function edgeCa(): string | undefined {
  const file = process.env.EST_EDGE_CA_CERT;
  if (!file) return undefined;
  edgeCaFromEnv ??= fs.readFileSync(file, 'utf8');
  return edgeCaFromEnv;
}

/** `/.well-known/est/<op>` or `/.well-known/est/<label>/<op>`. */
export function estPath(label: string | undefined, op: string): string {
  return label ? `/.well-known/est/${label}/${op}` : `/.well-known/est/${op}`;
}

export function buildEstRequest(opts: EstRequestOptions): { options: https.RequestOptions; body: Buffer } {
  const url = new URL(opts.baseUrl);
  // WHATWG keeps the brackets of an IPv6 literal; https and isIP take the bare address.
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const query = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
  const body = Buffer.from(opts.body ?? '');

  const headers: Record<string, string | number> = { ...opts.headers };
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  if (opts.basicAuth) {
    const token = Buffer.from(`${opts.basicAuth.username}:${opts.basicAuth.password}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }
  if (body.length > 0) headers['Content-Length'] = body.length;

  const options: https.RequestOptions = {
    method: opts.method ?? (body.length > 0 ? 'POST' : 'GET'),
    hostname,
    port: url.port || 443,
    path: estPath(opts.label, opts.op) + query,
    headers,
    // SNI carries a name, never an address.
    servername: isIP(hostname) ? undefined : hostname,
  };
  const ca = opts.ca ?? edgeCa();
  if (ca) options.ca = ca;
  if (opts.clientCert) {
    options.cert = opts.clientCert.cert;
    options.key = opts.clientCert.key;
  }
  return { options, body };
}

export function estRequest(opts: EstRequestOptions): Promise<EstResponse> {
  const { options, body } = buildEstRequest(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
        }
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    // A deadline on the whole request, not an idle timeout: a server that trickles bytes must not hold the suite.
    const deadline = setTimeout(() => {
      req.destroy(new Error(`EST request ${options.method} ${options.path} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    req.on('close', () => clearTimeout(deadline));
    req.end(body);
  });
}

const BASE64_TEXT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes base64 text (RFC 4648 section 4) after removing whitespace, which RFC 8951 allows between
 * lines. Any other character, or bad padding, throws; the text is not echoed in the error.
 */
export function decodeBase64Text(text: string): Buffer {
  const compact = text.replace(/\s+/g, '');
  if (!BASE64_TEXT.test(compact)) throw new Error(`Invalid base64: ${compact.length} characters`);
  return Buffer.from(compact, 'base64');
}

/** EST bodies are base64 of DER, possibly wrapped in lines; tolerates CRLF and whitespace. */
export function decodeBase64Body(body: Buffer | string): Buffer {
  return decodeBase64Text(body.toString('latin1'));
}
