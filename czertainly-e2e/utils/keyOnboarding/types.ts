/**
 * types — the provisioning summary of the key onboarding block (the `@dev-tests` port of the developers' suite for
 * ilm#409, "one-time list and onboard of existing token keys").
 *
 * WHAT: the shape the `key-onboarding-setup` project writes and every key onboarding spec reads. `Provisioning` keeps
 * the developers' summary shape (token, token profile, planted labels, the certified pair's certificate), so the specs
 * read the same fields; the objects behind it are created per run and recorded in the ledger.
 * HOW: `KeyOnboardingSummary` wraps it with the outcome of the setup: `ready`, or `unavailable` (a prerequisite is
 * missing; every test skips with the reason).
 */

export interface NamedUuid {
    name: string;
    uuid: string;
}

/** Labels of the key pairs planted on the token for this run; every label starts with the run id. */
export interface PlantedKeys {
    /** An RSA pair with an ID, onboarded under the name the listing suggests. */
    rsa: string;
    /** An EC pair with a short ID. */
    ec: string;
    /** An EC pair planted under its label alone, which the listing reports as `noUniqueId`. */
    noIdEc: string;
    /** Two EC pairs planted under one ID, which the listing reports as `noUniqueId`. */
    idSharingEc: [string, string];
    /** An RSA private key whose public key was deleted. */
    orphan: string;
    /** An RSA pair onboarded and then removed from the inventory. */
    removable: string;
    /** Two EC pairs onboarded and then removed from the inventory in one request. */
    bulkRemovable: [string, string];
    /** An EC pair onboarded and then compromised, which keeps it in the inventory. */
    compromised: string;
    /** An EC pair whose public key a certificate carries, so the inventory holds its public key before it is onboarded. */
    certified: string;
}

export interface Provisioning {
    token: NamedUuid;
    tokenProfile: NamedUuid;
    planted: PlantedKeys;
    /** The certificate carrying the certified pair's public key, base64-encoded DER. */
    certifiedCertificate: string;
}

/** What the `key-onboarding-setup` project leaves for the specs (`config.ts` summaryFile). */
export type KeyOnboardingSummary =
    | {
          status: 'ready';
          runId: string;
          /** The server's clock (Date header) when provisioning started. */
          provisionedAt: string;
          provisioning: Provisioning;
      }
    | {
          status: 'unavailable';
          runId: string;
          at: string;
          /** Why the tier cannot run the block (no PKCS#11 connector with key listing, no token sidecar, no docker). */
          reason: string;
      };
