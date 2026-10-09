import { AttributeDefinition, AttributeValue } from './adminApi';
import { ECDSA, RSA } from './env';
import { RSASSA_PSS, TokenSignature } from './openssl';

const V2_DIGESTS = ['SHA-256', 'SHA-384', 'SHA-512'];

/** What a v2 provider offers per key algorithm. */
export const V2_OFFER: Record<string, Record<string, string[]>> = {
  [RSA]: { data_rsaSigScheme: ['PKCS1-v1_5', 'PSS'], data_sigDigest: V2_DIGESTS },
  [ECDSA]: { data_sigDigest: V2_DIGESTS },
};

/** A post-quantum key offers the one signature algorithm its parameter set fixes, such as ML-DSA-65. */
export function postQuantumOffer(keyAlgorithm: string): RegExp {
  return new RegExp(`^${keyAlgorithm}-\\d+$`);
}

const DIGEST_OIDS: Record<string, string> = {
  'SHA-256': '2.16.840.1.101.3.4.2.1',
  'SHA-384': '2.16.840.1.101.3.4.2.2',
  'SHA-512': '2.16.840.1.101.3.4.2.3',
};
const RSA_PKCS1_OIDS: Record<string, string> = {
  'SHA-256': '1.2.840.113549.1.1.11',
  'SHA-384': '1.2.840.113549.1.1.12',
  'SHA-512': '1.2.840.113549.1.1.13',
};
const ECDSA_OIDS: Record<string, string> = {
  'SHA-256': '1.2.840.10045.4.3.2',
  'SHA-384': '1.2.840.10045.4.3.3',
  'SHA-512': '1.2.840.10045.4.3.4',
};

/** The signature of a token from a profile with these options, on a key of this algorithm and OID. */
export function expectedSignature(
  keyAlgorithm: string,
  options: Record<string, string[]>,
  keyOid: string,
): TokenSignature {
  const digest = options.data_sigDigest?.[0] ?? '';
  switch (keyAlgorithm) {
    case RSA:
      return options.data_rsaSigScheme?.[0] === 'PSS'
        ? { algorithm: RSASSA_PSS, pssHash: DIGEST_OIDS[digest] }
        : { algorithm: RSA_PKCS1_OIDS[digest] };
    case ECDSA:
      return { algorithm: ECDSA_OIDS[digest] };
    default:
      // A post-quantum signature carries the OID of its key.
      return { algorithm: keyOid };
  }
}

/** A signing operation attribute for VALUE, built on the first definition of NAME. */
export function signatureField(definitions: AttributeDefinition[], name: string, value: string): AttributeValue {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`no certificate here offers ${name}`);
  const offered = definition.content?.find((item) => item.data === value);
  return {
    name,
    uuid: definition.uuid,
    contentType: definition.contentType,
    version: 'v2',
    // A value outside the offer still travels, so Core is the one to refuse it.
    content: [offered ? { data: offered.data, reference: offered.reference } : { data: value }],
  };
}
