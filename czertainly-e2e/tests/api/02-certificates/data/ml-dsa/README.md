# ML-DSA fixtures

Public test material of `pqc-key-decoding.api.spec.ts` (core#2642): certificates and PKCS#10 certificate requests only. No
private key is kept anywhere in the repository.

| File | Content |
|---|---|
| `ml-dsa-44|65|87.crt.pem` | self-signed ML-DSA certificate (FIPS 204, pure ML-DSA) |
| `ml-dsa-44|65|87.csr.pem` | PKCS#10 request with the same ML-DSA key |
| `ec-p256.crt.pem`, `ec-p256.csr.pem` | classic control, EC P-256 |
| `rsa-2048.crt.pem`, `rsa-2048.csr.pem` | classic control, RSA 2048 |
| `hybrid-ec-p256-ml-dsa-65.crt.pem` | hybrid certificate: EC P-256 primary key and signature (the key of `ec-p256`), ML-DSA-65 alternative key (the key of `ml-dsa-65`) with a real alternative signature over the preTBSCertificate (X.509 extensions 2.5.29.72, 73, 74) |

The subjects are generic (`CN=pqc-fixture-<name>`); the certificates are valid from 2026-01-01 to 2046-01-01.

To regenerate (new keys, so new fingerprints), with OpenSSL 3.5 or newer (the first release with ML-DSA; LibreSSL has none):

```
OPENSSL=/path/to/openssl node generate.mjs
```

The script builds everything in a temporary folder (keys included), checks the alternative signature with the alternative
public key, and only then copies the public files here; the temporary folder and the keys are removed. A failed run leaves
the fixtures unchanged.

## A fixture certificate is already on the tier (409)

The upload rows record each uploaded fixture as a derived certificate, and the run-end teardown deletes it. When the upload
answers 409, the spec looks the certificate up by fingerprint and checks the shared run ledger: if an older run on the same
tier recorded it as derived (and no `deleted` line follows), the row checks it read-only and passes with an `older run
fixture` annotation. Otherwise the row fails, because the certificate is not a run object. To clean up by hand, find the
certificate by its fingerprint (SHA-256 of the DER, `openssl x509 -in <file> -outform DER | openssl dgst -sha256`), confirm
with the tier owner that it is a leftover test fixture (`CN=pqc-fixture-<name>`), and delete it together with its key.
Regenerating the fixtures (new keys, new fingerprints) also avoids the clash.
