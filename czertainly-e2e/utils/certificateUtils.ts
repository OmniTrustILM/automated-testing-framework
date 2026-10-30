/**
 * certificateUtils — helpers for the SMK-004 certificate-issuance smoke test.
 *
 * - generateCsr: produces a fresh RSA-2048 keypair and a PKCS#10 CSR (PEM) using
 *   node-forge. Caller pastes the CSR into the UI "Issue New Certificate" form.
 * - waitForCertificateState: polls GET /api/v1/certificates/{uuid} until the
 *   `state` field matches expected (e.g. "issued"). Used after UI submit. Fails
 *   fast on a terminal bad state, a 4xx (a 404 only after a short read-after-write
 *   grace) and three 5xx in a row.
 * - revokeCertificate + deleteCertificate: best-effort cleanup helpers for
 *   the test's afterEach hook.
 *
 * NOTE: certificate issuance itself is done via UI (CertificatePage), not via
 * this module — see SMK-004 design spec.
 */

import { APIRequestContext } from '@playwright/test';
import { Logger } from './Logger';
import * as forge from 'node-forge';
import { waitForCertificateState as waitUntilCertificateState } from './regression/wait/certificateState';
import type { WaitForStateOptions } from './regression/wait/certificateState';

const logger = new Logger('CertificateUtils');

export interface RevokeCertificateOptions {
    authorityUuid: string;
    raProfileUuid: string;
    certUuid: string;
    reason?: string;        // X.509 CRL reason; defaults to "unspecified"
}

/**
 * CSR (Certificate Signing Request)  - a request to CA to issue a digital certificate
 * we provide our public key -> CA checks our identity and sign -> we get a real certificate
 * keypair - it's our digital signiture:
 *  private key - a secret one that only we have, we sign things using it, proving that they are from us
 *  public key - we show to everyone, others use it to check our signiture
 */

export function generateCsr(commonName: string): { csr: string; privateKey: string } {
    logger.info(`Generating CSR for CN=${commonName}`);

    // 1. RSA-2048 keypair (industry-standard for TLS)
    const keys = forge.pki.rsa.generateKeyPair(2048); // a library to work with RSA (one of the most popular crypto algorithm)

    // 2. Build CSR object
    const csr = forge.pki.createCertificationRequest(); // create an empty CSR object
    csr.publicKey = keys.publicKey; // attach our public key to the CSR object (future certificate will prove that key, e.g. CA proves that this owners has this public key )
    // we don't share our private key
    csr.setSubject([{ name: 'commonName', value: commonName }]); // to which name issue a digital certificate
    // X.509 standard subject usually contains a few fields: Common Name (CN), Organization (O), Country (C) etc.
    // we use only CN, CN = usually a domain (www.example.com) for TLS-certificates or a person name for personal-certs
    // format = an array of objects {name, value}

    // 3. Sign the CSR with the private key using SHA-256
    csr.sign(keys.privateKey, forge.md.sha256.create()); // by this signature CA can prove that this request was made by a real owner of the private key
    // how this signature works mathematically:
    //  1. we use SHA-256 hash algorithm for the content of the CSR
    //  2. we encrypt that hash with the private key
    //  3. others can decrypt it with the public key and compare the hashes - if they are equal -> the signature is valid
    //  4. if someone changes the CSR after the signature -> the hash changes -> the signature won't match -> CA will see it

    // 4. Serialize to PEM (text format with -----BEGIN CERTIFICATE REQUEST----- headers)
    // PEM - is a text format for crypto objects, Base64-coded content between the -----BEGIN CERTIFICATE REQUEST----- and -----END CERTIFICATE REQUEST----- lines.
    // we return both parts:
    //  1. CSR - to send to CA
    //  2. private key - we store it for our later use, it is needed for real usage, e.g. TLS-server use it for handshake 
    return {
        csr: forge.pki.certificationRequestToPem(csr),
        privateKey: forge.pki.privateKeyToPem(keys.privateKey),
    };
}

/**
 * self-signed certificate means it was not issued by CA but we issued it by ourselves
 * it has all the formal fields (name, public key, validity, serial number, signature) but the signature is ours, not CA's -> basically noone would accept it as a true official certificate
 * ILM should accept it as a valid structured but the issuer won't be trusted
 */
export function generateSelfSignedCert(
    commonName: string,
    validityDays: number = 365,
): { pem: string; fingerprint: string } {
    logger.info(`Generating self-signed cert for CN=${commonName}, valid ${validityDays} days`);

    // 1. RSA-2048 keypair (same as for CSR)
    const keys = forge.pki.rsa.generateKeyPair(2048);

    // 2. Build certificate object
    const cert = forge.pki.createCertificate(); // not createCertificationRequest() here, CSR is for a request, this one - is for a ready certificate
    // a certificate has more fields: validity, issuer, serial, signature. CSR has only subject + public key + signature.
    cert.publicKey = keys.publicKey;

    // 3. Random 16-byte serial number (must be unique per cert)
    cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));

    // 4. Validity window: now → now + validityDays
    const now = new Date();
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000);

    // 5. Subject = Issuer (that's what "self-signed" means)
    // here we have both subject and issuer
    // Subject = to whom it was issued
    // Issuer = who issued
    // real certificate example: subject = CN=example.com, issuer = CN=Let's Encrypt R3
    const attrs = [{ name: 'commonName', value: commonName }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    // 6. Sign the cert with our own private key
    // in real certificate it should be signed by the private key of CA
    cert.sign(keys.privateKey, forge.md.sha256.create());

    // 7. Compute SHA-256 fingerprint of DER-encoded cert
    //  7.1 forge.pki.certificateToAsn1(cert) — here we convert cert object to ASN.1 (tree-structure, intermediate state), the cert inside is a tree structure, ASN.1 mirrors it
    //  7.2 forge.asn1.toDer(...) — we serialize ASN.1 into DER (Distinguished Encoding Rules — binary format). PEM is de facto base64 wrapper around DER.
    //      Fingerprint is counted from DER bytes, not from PEM text.
    //  7.3 .getBytes() - we get these bytes as a string
    //  7.4 forge.md.sha256.create() + md.update(bytes) — we create SHA-256 hasher using the DER bytes
    //  7.5 md.digest().toHex() — we get the hash result as hex-string = the format of the API response when we upload a certificate
    const derBytes = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const md = forge.md.sha256.create();
    md.update(derBytes);
    const fingerprint = md.digest().toHex();

    // 7. Return PEM + fingerprint
    // here we return only pem and fingerprint, we don't save the private key since we aren't going to use it for TLS etc.
    return {
        pem: forge.pki.certificateToPem(cert),
        fingerprint,
    };
}

export async function uploadCertificate(
    request: APIRequestContext,
    pem: string,
): Promise<{ fingerprint: string }> {
    logger.info(`Uploading certificate to /api/v1/certificates/upload/async`);
    const base64Pem = Buffer.from(pem).toString('base64'); //Node.js approach to convert a string to base64 
    const response = await request.post('/api/v1/certificates/upload/async', {
        data: {
            certificate: base64Pem,
            customAttributes: [],
        },
    });
    if (!response.ok()) {
        const errBody = await response.text();
        throw new Error(`Failed to upload certificate: ${response.status()} - ${errBody}`);
    }
    return await response.json() as { fingerprint: string };
}

export async function findCertificateByFingerprint(
    request: APIRequestContext,
    fingerprint: string,
): Promise<{ uuid: string } | null> {
    logger.info(`Searching for certificate with fingerprint: ${fingerprint}`);
    const response = await request.post('/api/v1/certificates', {
        data: {
            itemsPerPage: 10,
            pageNumber: 1,
            filters: [
                {
                    fieldSource: 'property',
                    fieldIdentifier: 'FINGERPRINT',
                    condition: 'EQUALS',
                    value: fingerprint,
                },
            ],
            includeArchived: false,
        },
    });
    if (!response.ok()) {
        const errBody = await response.text();
        throw new Error(`Failed to search certificates: ${response.status()} - ${errBody}`);
    }
    const body = await response.json() as { certificates: Array<{ uuid: string }> };
    if (body.certificates.length === 0) {
        logger.info(`No certificate found with fingerprint: ${fingerprint}`);
        return null;
    }
    return { uuid: body.certificates[0].uuid };
}

export { NOT_FOUND_GRACE_MS, RETRYABLE_4XX, isTransientStatus } from './regression/wait/certificateState';
export type { WaitForStateOptions } from './regression/wait/certificateState';

/** Polls until the certificate reaches `expectedState`; the policy (fail fast, grace, transient answers) lives in regression/wait/certificateState. */
export const waitForCertificateState = (request: APIRequestContext, certUuid: string, expectedState: string, timeout: number = 60_000, opts: WaitForStateOptions = {}): Promise<void> =>
    waitUntilCertificateState(request, certUuid, expectedState, timeout, opts);

export async function revokeCertificate(
    request: APIRequestContext,
    options: RevokeCertificateOptions,
): Promise<void> {
    const reason = options.reason || 'unspecified';
    logger.info(`Revoking certificate ${options.certUuid} (reason: ${reason})`);

    const url = `/api/v2/operations/authorities/${options.authorityUuid}/raProfiles/${options.raProfileUuid}/certificates/${options.certUuid}/revoke`;
    const resp = await request.post(url, {
        data: { reason, attributes: [] },
    });
    if (!resp.ok() && resp.status() !== 204) {
        const errBody = await resp.text();
        throw new Error(`Failed to revoke certificate ${options.certUuid}: ${resp.status()} - ${errBody}`);
    }
}

export async function deleteCertificate(
    request: APIRequestContext,
    certUuid: string,
): Promise<void> {
    logger.info(`Deleting certificate: ${certUuid}`);
    const resp = await request.delete(`/api/v1/certificates/${certUuid}`);
    if (!resp.ok() && resp.status() !== 204 && resp.status() !== 404) {
        const errBody = await resp.text();
        throw new Error(`Failed to delete certificate ${certUuid}: ${resp.status()} - ${errBody}`);
    }
}

