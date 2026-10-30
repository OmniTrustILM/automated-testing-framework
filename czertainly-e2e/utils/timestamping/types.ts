/**
 * types — the provisioning summary of the timestamping block (automated-testing-framework#41 / #113).
 *
 * `Provisioning` is the shape the `timestamping-setup` project writes and every timestamping spec reads: the summary
 * shape of development-environment `scripts/timestamping-setup.sh --json-summary` (sets keyed by set name).
 * `TimestampingSummary` wraps it with the outcome of the setup: `ready` (the run's sets exist) or `unavailable` (the tier
 * lacks a prerequisite; every timestamping test skips with the reason).
 */

export interface NamedUuid {
    name: string;
    uuid: string;
}

/** What the summary keeps of a Basic credential: no password (it is derived, utils/timestamping/secrets.ts). */
export interface StoredBasicCredential {
    username: string;
    uuid: string;
}

/** A Basic credential as a spec uses it: the stored part and the password derived from the run secret. */
export interface BasicCredential extends StoredBasicCredential {
    password: string;
}

/** One half of a family: the non-qualified or the qualified profile pair with everything it signs with. */
export interface TsaSet {
    qualified: boolean;
    /** KeyAlgorithm code of the signing key, such as `RSA` or `ML-DSA`, taken from its family. */
    keyAlgorithm: string;
    policyOid: string;
    key: NamedUuid;
    raProfile: NamedUuid;
    certificate: { commonName: string; uuid: string };
    tspProfile: NamedUuid;
    basicCredential: BasicCredential;
    signingProfile: NamedUuid;
}

/** A half as the summary stores it. */
export interface StoredTsaSet extends Omit<TsaSet, 'keyAlgorithm' | 'basicCredential'> {
    basicCredential: StoredBasicCredential;
}

/** One named set of the summary: a qualified / non-qualified pair on one token. */
export interface SummarySet {
    cryptoProvider: string;
    connector: NamedUuid;
    token: NamedUuid;
    tokenProfile: NamedUuid;
    keyAlgorithm: string;
    /** The family's name in test titles (e.g. `ML-DSA`); without it the specs use the key algorithm. */
    label?: string;
    nonQualified: StoredTsaSet;
    qualified: StoredTsaSet;
}

export interface Provisioning {
    ilmHost: string;
    connectorHost: string;
    connectors: {
        credentialProvider: NamedUuid;
        ejbca: NamedUuid;
        timestampFormatting: NamedUuid;
        vault: NamedUuid;
    };
    credential: NamedUuid;
    authority: NamedUuid;
    vaultInstance: NamedUuid;
    vaultProfile: NamedUuid;
    mappedUser: { username: string; uuid: string };
    role: NamedUuid;
    timeQuality: {
        name: string;
        uuid: string;
        accuracy: string;
        ntpServers: string[];
        maxClockDrift: string;
    };
    /** Keyed by set name (`config.ts` FAMILY_PLAN names). */
    sets: Record<string, SummarySet>;
}

/** What the `timestamping-setup` project leaves for the specs (`config.ts` summaryFile). */
export type TimestampingSummary =
    | {
          status: 'ready';
          runId: string;
          /** The server's clock (Date header) when provisioning started: the lower bound of this run's signing records. */
          provisionedAt: string;
          provisioning: Provisioning;
          /** Families of the plan that could not be provisioned, with the reason (their tests skip). */
          missingFamilies: Record<string, string>;
      }
    | {
          status: 'unavailable';
          runId: string;
          at: string;
          /** Why the tier cannot run the block (a missing connector, authority, profile, an untrusted issuing CA). */
          reason: string;
      };
