/**
 * config — the TSA_* settings of the timestamping block, the plan of families and where the setup leaves its summary (under REG_STATE_DIR).
 * Playwright lists tests BEFORE the setup runs, so data-driven titles come from the plan, not from the summary.
 */
import * as path from 'path';
import { currentRunId, regressionStateDir } from '../regression/run/runId';

export type CryptoProvider = 'software-v1' | 'software-v2' | 'pkcs11';

export interface PlannedFamily {
    name: string;
    label: string;
    keyAlgorithm: 'RSA' | 'ML-DSA';
    ejbcaCa: string;
}

export interface TimestampingConfig {
    /**
     * Unset: BASE_URL. Behind the dev proxy (AUTH_MODE=header) point it at core itself, or the proxy adds the admin certificate and the
     * authentication negatives prove nothing.
     */
    tspBaseUrl?: string;
    cryptoProvider: CryptoProvider;
    /** Existing; the run creates its RA profiles under it (a parent only, never changed). */
    authorityName: string;
    ejbcaEndEntityProfile: string;
    ejbcaCertificateProfile: string;
    ejbcaCertificateProfileQualified: string;
    /** Existing; the run creates its vault profile under it (a parent only). */
    vaultInstanceName: string;
    ntpServers: string[];
    accuracy: string;
    maxClockDrift: string;
    policyIdNonQualified: string;
    policyIdQualified: string;
    signatureScheme: string;
    signatureDigest: string;
    families: PlannedFamily[];
    /** Opt-in for the specs that stop containers: TSA_ALLOW_DISRUPTION=true. */
    allowDisruption: boolean;
    containers: {
        core: string;
        ntp: string;
        timeQualityMonitor: string;
        cryptographyProvider: string;
        timestampFormatting: string;
        rabbitmq: string;
    };
}

const list = (v: string | undefined, fallback: string[]): string[] =>
    v === undefined || v.trim() === '' ? fallback : v.split(',').map((s) => s.trim()).filter(Boolean);

export function plannedFamilies(env: NodeJS.ProcessEnv = process.env): PlannedFamily[] {
    const known: Record<string, PlannedFamily> = {
        rsa: { name: 'rsa', label: 'RSA', keyAlgorithm: 'RSA', ejbcaCa: env.TSA_EJBCA_CA ?? 'DemoRootCA_2307RSA' },
        mldsa65: { name: 'mldsa65', label: 'ML-DSA', keyAlgorithm: 'ML-DSA', ejbcaCa: env.TSA_MLDSA_EJBCA_CA ?? 'MLDSA' },
    };
    const names = list(env.TSA_FAMILIES, ['rsa', 'mldsa65']);
    const unknown = names.filter((n) => !known[n]);
    if (unknown.length) throw new Error(`TSA_FAMILIES: unknown famil${unknown.length > 1 ? 'ies' : 'y'} ${unknown.join(', ')} (known: ${Object.keys(known).join(', ')})`);
    if (!names.includes('rsa')) throw new Error('TSA_FAMILIES must include rsa: the protocol and canary specs run on the RSA family');
    return names.map((n) => known[n]);
}

export function timestampingConfig(env: NodeJS.ProcessEnv = process.env): TimestampingConfig {
    const provider = (env.TSA_CRYPTO_PROVIDER ?? 'software-v2') as CryptoProvider;
    if (!['software-v1', 'software-v2', 'pkcs11'].includes(provider)) {
        throw new Error(`TSA_CRYPTO_PROVIDER: "${provider}" is not software-v1, software-v2 or pkcs11`);
    }
    return {
        tspBaseUrl: env.TSA_TSP_BASE_URL || undefined,
        cryptoProvider: provider,
        authorityName: env.TSA_AUTHORITY_NAME ?? 'ejbca.3key.company',
        ejbcaEndEntityProfile: env.TSA_EJBCA_EE_PROFILE ?? 'DemoTSAEndEntityProfile',
        ejbcaCertificateProfile: env.TSA_EJBCA_CERT_PROFILE ?? 'DemoTSAEECertificateProfile',
        ejbcaCertificateProfileQualified: env.TSA_EJBCA_CERT_PROFILE_QUALIFIED ?? 'DemoTSAQCEECertificateProfile',
        vaultInstanceName: env.TSA_VAULT_INSTANCE_NAME ?? 'vault',
        ntpServers: list(env.TSA_NTP_SERVERS, ['ntp']),
        accuracy: env.TSA_ACCURACY ?? 'PT1S',
        maxClockDrift: env.TSA_MAX_CLOCK_DRIFT ?? 'PT0.8S',
        policyIdNonQualified: env.TSA_POLICY_ID_NON_QUALIFIED ?? '1.2.3.4.5.6',
        policyIdQualified: env.TSA_POLICY_ID_QUALIFIED ?? '1.2.3.4.5.7',
        signatureScheme: env.TSA_SIGNATURE_SCHEME ?? 'PKCS1-v1_5',
        signatureDigest: env.TSA_SIGNATURE_DIGEST ?? 'SHA-384',
        families: plannedFamilies(env),
        allowDisruption: env.TSA_ALLOW_DISRUPTION === 'true',
        containers: {
            core: env.TSA_CONTAINER_CORE ?? 'core',
            ntp: env.TSA_CONTAINER_NTP ?? 'ntp',
            timeQualityMonitor: env.TSA_CONTAINER_TIME_QUALITY_MONITOR ?? 'time-quality-monitor',
            cryptographyProvider: env.TSA_CONTAINER_CRYPTOGRAPHY_PROVIDER ?? 'software-cryptography-provider',
            timestampFormatting: env.TSA_CONTAINER_TIMESTAMP_FORMATTING ?? 'timestamp-formatting-connector',
            rabbitmq: env.TSA_CONTAINER_RABBITMQ ?? 'rabbitmq',
        },
    };
}

export function summaryFile(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(regressionStateDir(env), `${currentRunId(env)}.timestamping.json`);
}
