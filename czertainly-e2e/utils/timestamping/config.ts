/**
 * config — the environment contract of the timestamping block.
 *
 * The TSA_* settings the block reads, with the defaults of development-environment `scripts/timestamping-setup.sh`, the plan
 * of families (which sets the setup creates), and where the setup leaves its summary (under REG_STATE_DIR, never in the clone).
 * Playwright lists tests BEFORE the setup runs, so data-driven titles come from the plan, not from the summary. A test skips
 * when the setup could not provision its set.
 */
import * as path from 'path';
import { currentRunId, regressionStateDir } from '../regression/run/runId';

export type CryptoProvider = 'software-v1' | 'software-v2' | 'pkcs11';

/** A family the setup provisions: one non-qualified and one qualified set on one key algorithm. */
export interface PlannedFamily {
    /** The set name in the summary (`Provisioning.sets` key) and in object names. */
    name: string;
    /** The family's name in test titles; the primary RSA family's titles carry no prefix. */
    label: string;
    /** KeyAlgorithm code as the cryptography provider names it. */
    keyAlgorithm: 'RSA' | 'ML-DSA';
    /** The EJBCA CA that issues the family's TSA certificates. */
    ejbcaCa: string;
}

export interface TimestampingConfig {
    /** Base URL of the TSP requests. Unset: BASE_URL. On AUTH_MODE=header behind the dev proxy, point it at core itself
     * (the proxy would add the admin certificate to every request and the authentication negatives would prove nothing). */
    tspBaseUrl?: string;
    cryptoProvider: CryptoProvider;
    /** Existing EJBCA authority instance the run creates its RA profiles under (a parent only, never changed). */
    authorityName: string;
    ejbcaEndEntityProfile: string;
    ejbcaCertificateProfile: string;
    ejbcaCertificateProfileQualified: string;
    /** Existing vault instance the run creates its vault profile under (a parent only). */
    vaultInstanceName: string;
    /** Time-quality configuration of the qualified sets (created per run). */
    ntpServers: string[];
    accuracy: string;
    maxClockDrift: string;
    policyIdNonQualified: string;
    policyIdQualified: string;
    signatureScheme: string;
    signatureDigest: string;
    families: PlannedFamily[];
    /** Opt-in for the specs that stop containers (NTP, monitor, connectors): TSA_ALLOW_DISRUPTION=true. */
    allowDisruption: boolean;
    /** Container names the environment and outage specs inspect or stop. */
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

/** The families TSA_FAMILIES names (default `rsa,mldsa65`): `rsa` and `mldsa65` are known; anything else is an error. */
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

/** The run's summary: `<REG_STATE_DIR>/<run id>.timestamping.json`. */
export function summaryFile(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(regressionStateDir(env), `${currentRunId(env)}.timestamping.json`);
}
