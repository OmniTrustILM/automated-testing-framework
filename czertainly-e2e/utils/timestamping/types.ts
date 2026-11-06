/**
 * types — the provisioning summary of the timestamping block: `Provisioning`
 * (sets keyed by set name) and `TimestampingSummary` (`ready` or `unavailable`).
 */

export interface NamedUuid {
    name: string;
    uuid: string;
}

/** No password: it is derived (utils/timestamping/secrets.ts). */
export interface StoredBasicCredential {
    username: string;
    uuid: string;
}

export interface BasicCredential extends StoredBasicCredential {
    password: string;
}

export interface TsaSet {
    qualified: boolean;
    keyAlgorithm: string;
    policyOid: string;
    key: NamedUuid;
    raProfile: NamedUuid;
    certificate: { commonName: string; uuid: string };
    tspProfile: NamedUuid;
    basicCredential: BasicCredential;
    signingProfile: NamedUuid;
}

export interface StoredTsaSet extends Omit<TsaSet, 'keyAlgorithm' | 'basicCredential'> {
    basicCredential: StoredBasicCredential;
}

export interface SummarySet {
    cryptoProvider: string;
    connector: NamedUuid;
    token: NamedUuid;
    tokenProfile: NamedUuid;
    keyAlgorithm: string;
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
    sets: Record<string, SummarySet>;
}

export type TimestampingSummary =
    | {
          status: 'ready';
          runId: string;
          provisionedAt: string;
          provisioning: Provisioning;
          missingFamilies: Record<string, string>;
      }
    | {
          status: 'unavailable';
          runId: string;
          at: string;
          reason: string;
      };
