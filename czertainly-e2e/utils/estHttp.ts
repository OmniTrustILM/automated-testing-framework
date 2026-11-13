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
}

export interface EstResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

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
    hostname: url.hostname,
    port: url.port || 443,
    path: estPath(opts.label, opts.op) + query,
    headers,
    // SNI carries a name, never an address.
    servername: isIP(url.hostname) ? undefined : url.hostname,
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
    req.end(body);
  });
}

/** EST bodies are base64 of DER, possibly wrapped in lines; tolerates CRLF and whitespace. */
export function decodeBase64Body(body: Buffer | string): Buffer {
  return Buffer.from(body.toString('latin1').replace(/\s+/g, ''), 'base64');
}
