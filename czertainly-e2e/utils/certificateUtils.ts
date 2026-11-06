/**
 * certificateUtils — helpers of the SMK-004 smoke test: a CSR and a self-signed certificate (node-forge), certificate state polling and
 * cleanup.
 * Issuance itself goes through the UI (CertificatePage).
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
    reason?: string;
}


export function generateCsr(commonName: string): { csr: string; privateKey: string } {
    logger.info(`Generating CSR for CN=${commonName}`);

    const keys = forge.pki.rsa.generateKeyPair(2048);

    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey; // attach our public key to the CSR object (future certificate will prove that key, e.g. CA proves that this owners has this public key )
    csr.setSubject([{ name: 'commonName', value: commonName }]); // to which name issue a digital certificate

    csr.sign(keys.privateKey, forge.md.sha256.create()); // by this signature CA can prove that this request was made by a real owner of the private key

    return {
        csr: forge.pki.certificationRequestToPem(csr),
        privateKey: forge.pki.privateKeyToPem(keys.privateKey),
    };
}

/** A certificate the platform accepts as well-formed, but whose issuer is not trusted. */
export function generateSelfSignedCert(
    commonName: string,
    validityDays: number = 365,
): { pem: string; fingerprint: string } {
    logger.info(`Generating self-signed cert for CN=${commonName}, valid ${validityDays} days`);

    const keys = forge.pki.rsa.generateKeyPair(2048);

    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;

    cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));

    const now = new Date();
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000);

    const attrs = [{ name: 'commonName', value: commonName }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    // The fingerprint is counted from the DER bytes, not from the PEM text.
    const derBytes = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const md = forge.md.sha256.create();
    md.update(derBytes);
    const fingerprint = md.digest().toHex();

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

/** Polls until the certificate reaches `expectedState`; the policy lives in regression/wait/certificateState. */
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

