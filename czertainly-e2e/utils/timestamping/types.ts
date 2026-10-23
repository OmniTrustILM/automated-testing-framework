/**
 * types — the provisioning summary of the timestamping block (the `@dev-tests` port of the developers' suite,
 * automated-testing-framework#41 / #113).
 *
 * WHAT: the shape the `timestamping-setup` project writes and every timestamping spec reads. `Provisioning` is the
 * summary shape of development-environment `scripts/timestamping-setup.sh --json-summary` (sets keyed by set name), so
 * the ported specs read the same fields as on the developers' branch.
 * WHY: the specs were written against that summary; keeping it lets them move almost unchanged, while the objects
 * behind it are now created per run (run-prefixed names, ledger lines) instead of reused by fixed names.
 * HOW: `TimestampingSummary` wraps it with the outcome of the setup: `ready` (the run's sets exist) or `unavailable`
 * (the tier lacks a prerequisite; every timestamping test skips with the reason).
 */

export interface NamedUuid {
    name: string;
    uuid: string;
}

export interface BasicCredential {
    username: string;
    password: string;
    uuid: string;
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

/** One named set of the summary: a qualified / non-qualified pair on one token. */
export interface SummarySet {
    cryptoProvider: string;
    connector: NamedUuid;
    token: NamedUuid;
    tokenProfile: NamedUuid;
    keyAlgorithm: string;
    /** The family's name in test titles (e.g. `ML-DSA`); without it the specs use the key algorithm. */
    label?: string;
    nonQualified: Omit<TsaSet, 'keyAlgorithm'>;
    qualified: Omit<TsaSet, 'keyAlgorithm'>;
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
          /** Why the tier cannot run the block (a missing connector, authority, profile, a shared tier). */
          reason: string;
      };
