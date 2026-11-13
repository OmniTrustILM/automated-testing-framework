/**
 * types — the provisioning summary of the key onboarding block: `Provisioning`
 * (the setup's objects) and `KeyOnboardingSummary` (`ready` or `unavailable`).
 */

export interface NamedUuid {
    name: string;
    uuid: string;
}

export interface PlantedKeys {
    rsa: string;
    ec: string;
    noIdEc: string;
    idSharingEc: [string, string];
    orphan: string;
    removable: string;
    bulkRemovable: [string, string];
    compromised: string;
    certified: string;
}

export interface Provisioning {
    token: NamedUuid;
    tokenProfile: NamedUuid;
    planted: PlantedKeys;
    /** Base64 DER of a throwaway-issuer certificate for the certified pair's public key (25-merge uploads it). */
    certifiedCertificate: string;
}

export type KeyOnboardingSummary =
    | {
          status: 'ready';
          runId: string;
          provisionedAt: string;
          provisioning: Provisioning;
      }
    | {
          status: 'unavailable';
          runId: string;
          at: string;
          reason: string;
      };
