/**
 * estEnroll — the CSR operations as the EST specs send them, and what they read back.
 *
 * WHAT: sends a CSR to `/simpleenroll`, `/simplereenroll` or `/serverkeygen`, reads the one
 * certificate of a certs-only answer, checks it carries the CSR's key, finds it in the inventory
 * (by fingerprint, or by common name while it is still pending) and removes it, and builds the
 * `ssl-client-cert` header a TLS proxy forwards. It also names the fixed refusal texts the
 * platform answers with.
 * WHY: every routing and policy check is an enrollment followed by the same reading of the answer,
 * and a refusal is told apart by its status and its fixed text.
 * HOW: the certificate is read with Node's X509Certificate, since the platform's CA signs with EC
 * keys that node-forge cannot read. A certificate an enrollment created is looked up by its
 * SHA-256 fingerprint and deleted through the cleanup ledger; a request answered 202 has no
 * certificate yet, so it is found by its run-unique common name.
 */

import { APIRequestContext } from '@playwright/test';
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { ensureOk } from './estAdminApi';
import { attemptCleanup } from './cleanupLedger';
import { deleteCertificate, findCertificateByFingerprint } from './certificateUtils';
import { Csr, KeyPair, parseCertsOnlyDer, sha256Fingerprint } from './estPki';
import { decodeBase64Body, estRequest, EstRequestOptions, EstResponse } from './estHttp';

export const CERTS_ONLY = 'application/pkcs7-mime; smime-type=certs-only';

/** The fixed bodies of the platform's EST refusals. */
export const EST_REFUSAL = {
  badRequest: 'The request is not a base64-encoded DER PKCS#10 certification request.',
  payloadTooLarge: 'The request is too large.',
  unsupportedMediaType: 'The content type must be application/pkcs10.',
  unauthorized: 'Authentication is required.',
  registrationRejected: 'The request does not match an active certificate registration.',
  certificateRejected: 'The client certificate is not accepted.',
  identityMismatch: 'The request does not match the client certificate.',
  notFound: 'Not found.',
  renewalNotAllowed: 'Renewal with the same key is not allowed.',
  rekeyNotAllowed: 'Renewal with a new key is not allowed.',
  serverKeygenDisabled: 'Server-side key generation is not enabled.',
  serverKeygenUnavailable: 'Server-side key generation is not available for this route.',
};

export type EnrollOptions = Omit<EstRequestOptions, 'op' | 'body' | 'contentType' | 'method'> & { csr: Csr };

export type CsrOperation = 'simpleenroll' | 'simplereenroll' | 'serverkeygen';

/** Posts the CSR as base64 PKCS#10 to one of the operations that take one. */
export function sendCsr(op: CsrOperation, opts: EnrollOptions): Promise<EstResponse> {
  const { csr, ...request } = opts;
  return estRequest({ ...request, op, contentType: 'application/pkcs10', body: csr.base64 });
}

export function simpleEnroll(opts: EnrollOptions): Promise<EstResponse> {
  return sendCsr('simpleenroll', opts);
}

/** DER of the one certificate a successful enrollment answers; throws, naming what is wrong, otherwise. */
export function enrolledCertificate(resp: EstResponse): Buffer {
  if (resp.status !== 200) {
    throw new Error(`Enrollment answered ${resp.status}: ${resp.body.toString('utf8').slice(0, 200)}`);
  }
  if (resp.headers['content-type'] !== CERTS_ONLY) {
    throw new Error(`Enrollment answered content type ${resp.headers['content-type']}`);
  }
  const certificates = parseCertsOnlyDer(decodeBase64Body(resp.body));
  if (certificates.length !== 1) {
    throw new Error(`Enrollment answered ${certificates.length} certificates`);
  }
  return certificates[0];
}

/** Whether the certificate holds the public key of the key pair. */
export function certificateHasKey(der: Buffer, key: KeyPair): boolean {
  const certificateKey = new crypto.X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' });
  const expected = Buffer.from(
    forge.asn1.toDer(forge.pki.publicKeyToAsn1(key.publicKey)).getBytes(),
    'binary',
  );
  return certificateKey.equals(expected);
}

type CsrExtension = { altNames?: Array<{ value: string }> };

/**
 * What the certificate lacks of the CSR's identity: each subject attribute, and each requested DNS
 * name as a complete subjectAltName entry. Empty when the certificate carries all of it.
 */
export function issuedIdentityMismatches(certDer: Buffer, csrDer: Buffer): string[] {
  const request = forge.pki.certificationRequestFromAsn1(forge.asn1.fromDer(csrDer.toString('binary')));
  const issued = new crypto.X509Certificate(certDer);
  const subject = issued.subject.split('\n');
  const altNames = (issued.subjectAltName ?? '').split(', ');
  const extensions = (request.getAttribute({ name: 'extensionRequest' }) as { extensions?: CsrExtension[] } | null)?.extensions ?? [];

  const missing: string[] = [];
  for (const { shortName, value } of request.subject.attributes) {
    if (!subject.includes(`${shortName}=${value}`)) missing.push(`subject ${shortName}=${value} not issued`);
  }
  for (const { value } of extensions.flatMap((extension) => extension.altNames ?? [])) {
    if (!altNames.includes(`DNS:${value}`)) missing.push(`DNS name ${value} not issued`);
  }
  return missing;
}

/** PEM of a DER certificate, for presenting it as a TLS client certificate. */
export function derToPem(der: Buffer): string {
  return new crypto.X509Certificate(der).toString();
}

/** The PEM certificate as a TLS proxy forwards it in `ssl-client-cert`: URL-encoded. */
export function forwardedCertificateHeader(pem: string): Record<string, string> {
  return { 'ssl-client-cert': encodeURIComponent(pem) };
}

export interface InventoryCertificate {
  uuid: string;
  state: string;
  raProfileName?: string;
}

/** The inventory record of a certificate, found by its fingerprint. */
export async function getInventoryCertificate(api: APIRequestContext, der: Buffer): Promise<InventoryCertificate> {
  const fingerprint = sha256Fingerprint(der);
  const found = await findCertificateByFingerprint(api, fingerprint);
  if (!found) throw new Error(`No certificate with fingerprint ${fingerprint} in the inventory`);
  const resp = await api.get(`/api/v1/certificates/${found.uuid}`);
  await ensureOk(resp, `Get certificate ${found.uuid}`);
  const detail = (await resp.json()) as { state: string; raProfile?: { name: string } };
  return { uuid: found.uuid, state: detail.state, raProfileName: detail.raProfile?.name };
}

/** UUIDs of the inventory certificates with the common name, e.g. a request that is still pending. */
export async function findCertificatesByCommonName(api: APIRequestContext, commonName: string): Promise<string[]> {
  const resp = await api.post('/api/v1/certificates', {
    data: {
      itemsPerPage: 100,
      pageNumber: 1,
      filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: commonName }],
    },
  });
  await ensureOk(resp, `Search certificates named ${commonName}`);
  return ((await resp.json()) as { certificates: Array<{ uuid: string }> }).certificates.map((c) => c.uuid);
}

/** Deletes the certificates with the common name, each through the ledger, whatever state they are in. */
export async function cleanupCertificatesByCommonName(api: APIRequestContext, commonName: string): Promise<void> {
  let uuids: string[] = [];
  const found = await attemptCleanup({ resource: 'certificate', uuid: commonName, name: 'EST request' }, async () => {
    uuids = await findCertificatesByCommonName(api, commonName);
  });
  if (!found) return;
  for (const uuid of uuids) {
    await attemptCleanup({ resource: 'certificate', uuid, name: 'EST request' }, () => deleteCertificate(api, uuid));
  }
}

/** Deletes the certificates enrollments created, each through the ledger. */
export async function cleanupEnrolledCertificates(api: APIRequestContext, ders: Buffer[]): Promise<void> {
  for (const der of ders) {
    const fingerprint = sha256Fingerprint(der);
    await attemptCleanup({ resource: 'certificate', uuid: fingerprint, name: 'EST enrollment' }, async () => {
      const found = await findCertificateByFingerprint(api, fingerprint);
      if (found) await deleteCertificate(api, found.uuid);
    });
  }
}
