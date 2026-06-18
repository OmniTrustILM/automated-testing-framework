/**
 * certificateUtils — helpers for the SMK-004 certificate-issuance smoke test.
 *
 * - generateCsr: produces a fresh RSA-2048 keypair and a PKCS#10 CSR (PEM) using
 *   node-forge. Caller pastes the CSR into the UI "Issue New Certificate" form.
 * - waitForCertificateState: polls GET /api/v1/certificates/{uuid} until the
 *   `state` field matches expected (e.g. "issued"). Used after UI submit.
 * - revokeCertificate + deleteCertificate: best-effort cleanup helpers for
 *   the test's afterEach hook.
 *
 * NOTE: certificate issuance itself is done via UI (CertificatePage), not via
 * this module — see SMK-004 design spec.
 */

import { APIRequestContext, expect } from '@playwright/test';
import { Logger } from './Logger';
import * as forge from 'node-forge';

const logger = new Logger('CertificateUtils');

export interface RevokeCertificateOptions {
    authorityUuid: string;
    raProfileUuid: string;
    certUuid: string;
    reason?: string;        // X.509 CRL reason; defaults to "unspecified"
}

export function generateCsr(commonName: string): { csr: string; privateKey: string } {
    logger.info(`Generating CSR for CN=${commonName}`);

    // 1. RSA-2048 keypair (industry-standard for TLS)
    const keys = forge.pki.rsa.generateKeyPair(2048);

    // 2. Build CSR object
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject([{ name: 'commonName', value: commonName }]);

    // 3. Sign the CSR with the private key using SHA-256
    csr.sign(keys.privateKey, forge.md.sha256.create());

    // 4. Serialize to PEM (text format with -----BEGIN CERTIFICATE REQUEST----- headers)
    return {
        csr: forge.pki.certificationRequestToPem(csr),
        privateKey: forge.pki.privateKeyToPem(keys.privateKey),
    };
}

export async function waitForCertificateState(
    request: APIRequestContext,
    certUuid: string,
    expectedState: string,
    timeout: number = 60_000,
): Promise<void> {
    logger.info(`Waiting for certificate ${certUuid} to reach state "${expectedState}" (timeout ${timeout}ms)`);

    await expect.poll(async () => {
        const resp = await request.get(`/api/v1/certificates/${certUuid}`);
        if (!resp.ok()) {
            logger.warn(`Cert ${certUuid} state poll got status ${resp.status()}`);
            return null;
        }
        const cert = await resp.json();
        return cert.state as string;
    }, {
        message: `Certificate ${certUuid} did not reach state "${expectedState}" within ${timeout}ms`,
        timeout,
        intervals: [1000, 2000, 3000],
    }).toBe(expectedState);

    logger.info(`Certificate ${certUuid} reached state "${expectedState}"`);
}

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

