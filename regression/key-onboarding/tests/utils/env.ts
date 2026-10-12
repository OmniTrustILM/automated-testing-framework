import * as fs from 'fs';
import * as path from 'path';

export interface NamedUuid {
  name: string;
  uuid: string;
}

/** Labels of the key pairs planted on the token for this run. */
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

export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set; set it in config.env and start the suite through run.sh`);
  }
  return value;
}

export const runDir = process.env.RUN_DIR ?? path.join(__dirname, '..', '..', 'runs', 'manual');
export const provisioningFile = path.join(runDir, 'provisioning.json');

export const config = {
  ilmHost: required('ILM_HOST'),
  pkcs11ConnectorUrl: required('PKCS11_CONNECTOR_URL'),
  vaultConnectorUrl: required('VAULT_CONNECTOR_URL'),
  pkcs11Profile: required('PKCS11_PROFILE'),
  pkcs11Token: required('PKCS11_TOKEN'),
  tokenPin: required('TOKEN_PIN'),
  sidecarContainer: required('SIDECAR_CONTAINER'),
};

let cachedProvisioning: Provisioning | undefined;

export function provisioning(): Provisioning {
  if (!cachedProvisioning) {
    cachedProvisioning = JSON.parse(fs.readFileSync(provisioningFile, 'utf8')) as Provisioning;
  }
  return cachedProvisioning;
}

export function adminCertificateHeader(): string {
  const pem = fs.readFileSync(required('ADMIN_CERT_PEM'), 'utf8');
  const match = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!match) {
    throw new Error(`No certificate block found in ${process.env.ADMIN_CERT_PEM}`);
  }
  return encodeURIComponent(match[1].replace(/\s+/g, ''));
}
