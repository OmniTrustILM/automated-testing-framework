// Regenerates the public ML-DSA fixtures of pqc-key-decoding.api.spec.ts (certificates and certificate requests only).
//
// Usage: OPENSSL=<path to OpenSSL 3.5 or newer> node generate.mjs
// (OpenSSL 3.5 is the first release with ML-DSA; LibreSSL has none.) Everything is built in a temporary folder; only when every
// file is made (and the hybrid's alternative signature verified) are the public files copied here, so a failed run leaves the
// fixtures unchanged. The keys are removed with the temporary folder: no private key is ever written next to the fixtures.
// Every run makes new keys, so the fingerprints change.
//
// What it writes into this folder:
// - ml-dsa-{44,65,87}.crt.pem / .csr.pem  self-signed ML-DSA certificate and PKCS#10 request (pure ML-DSA, FIPS 204)
// - ec-p256.crt.pem / .csr.pem, rsa-2048.crt.pem / .csr.pem  the classic controls
// - hybrid-ec-p256-ml-dsa-65.crt.pem  a self-signed hybrid certificate (X.509 2019 alternative key and signature): EC P-256
//   primary key and signature (the key of ec-p256), ML-DSA-65 key (the key of ml-dsa-65) in subjectAltPublicKeyInfo (2.5.29.72), altSignatureAlgorithm (2.5.29.73) and
//   a real altSignatureValue (2.5.29.74) made by the ML-DSA-65 key over the preTBSCertificate (the TBSCertificate without
//   its signature field and without the altSignatureValue extension).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const OPENSSL = process.env.OPENSSL || 'openssl';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-dsa-fixtures-'));
const NOT_BEFORE = '20260101000000Z';
const NOT_AFTER = '20460101000000Z';
const CNF = path.join(TMP, 'base.cnf');
fs.writeFileSync(CNF, ['[req]', 'distinguished_name = dn', '[dn]', '[v3]', 'basicConstraints = critical,CA:FALSE', 'keyUsage = critical,digitalSignature', 'subjectKeyIdentifier = hash', ''].join('\n'));

const ossl = (args, cnf = CNF) => execFileSync(OPENSSL, args, { cwd: TMP, env: { ...process.env, OPENSSL_CONF: cnf } });
const tmp = (f) => path.join(TMP, f);
/** The public files this script delivers: built under TMP, copied into OUT at the end. */
const OUTPUTS = [];
const out = (f) => {
    OUTPUTS.push(f);
    return tmp(f);
};
const subject = (name) => `/CN=pqc-fixture-${name}`;

function key(file, algorithm, opts = []) {
    ossl(['genpkey', '-algorithm', algorithm, ...opts, '-out', tmp(file)]);
}

function certAndCsr(name, keyFile, serial) {
    ossl(['req', '-new', '-x509', '-config', CNF, '-extensions', 'v3', '-key', tmp(keyFile), '-subj', subject(name), '-set_serial', serial,
        '-not_before', NOT_BEFORE, '-not_after', NOT_AFTER, '-out', out(`${name}.crt.pem`)]);
    ossl(['req', '-new', '-config', CNF, '-key', tmp(keyFile), '-subj', subject(name), '-out', out(`${name}.csr.pem`)]);
}

// ---- DER walking (enough for a TBSCertificate)
const hex = (b) => Buffer.from(b).toString('hex');
function tlv(buf, off) {
    let len = buf[off + 1];
    let hdr = 2;
    if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
        hdr = 2 + n;
    }
    return { tag: buf[off], start: off, hdr, end: off + hdr + len };
}
function children(buf, t) {
    const list = [];
    for (let p = t.start + t.hdr; p < t.end;) { const c = tlv(buf, p); list.push(c); p = c.end; }
    return list;
}
function encLen(n) {
    if (n < 128) return Buffer.from([n]);
    const b = [];
    while (n) { b.unshift(n & 255); n >>= 8; }
    return Buffer.from([0x80 | b.length, ...b]);
}
const wrap = (tag, body) => Buffer.concat([Buffer.from([tag]), encLen(body.length), body]);
const slice = (buf, t) => buf.subarray(t.start, t.end);
const ALT_SIGNATURE_VALUE_OID = '0603551d4a'; // 2.5.29.74

/** preTBSCertificate: the TBSCertificate without its `signature` AlgorithmIdentifier and without the altSignatureValue extension. */
function preTbs(certDer) {
    const [tbs] = children(certDer, tlv(certDer, 0));
    const fields = children(certDer, tbs); // [0] version, serial, signature, issuer, validity, subject, spki, [3] extensions
    const extsSeq = children(certDer, fields.find((c) => c.tag === 0xa3))[0];
    const exts = children(certDer, extsSeq).filter((e) => hex(slice(certDer, children(certDer, e)[0])) !== ALT_SIGNATURE_VALUE_OID);
    const kept = fields.filter((c, i) => i !== 2 && c.tag !== 0xa3).map((c) => slice(certDer, c));
    return wrap(0x30, Buffer.concat([...kept, wrap(0xa3, wrap(0x30, Buffer.concat(exts.map((e) => slice(certDer, e)))))]));
}

function hybrid(name, primaryKey, altKey, serial) {
    const altSpki = ossl(['pkey', '-in', tmp(altKey), '-pubout', '-outform', 'DER']);
    const altAlgorithm = Buffer.from('300b0609608648016503040312', 'hex'); // AlgorithmIdentifier id-ml-dsa-65 (2.16.840.1.101.3.4.3.18)
    const make = (file, altSignature) => {
        const cnf = tmp('hybrid.cnf');
        const lines = [
            '[hy]', 'basicConstraints = critical,CA:FALSE', 'keyUsage = critical,digitalSignature', 'subjectKeyIdentifier = hash',
            `2.5.29.72 = DER:${hex(altSpki)}`, `2.5.29.73 = DER:${hex(altAlgorithm)}`,
            ...(altSignature ? [`2.5.29.74 = DER:${hex(altSignature)}`] : []),
        ];
        fs.writeFileSync(cnf, fs.readFileSync(CNF, 'utf8') + lines.join('\n') + '\n');
        ossl(['req', '-new', '-x509', '-config', cnf, '-extensions', 'hy', '-key', tmp(primaryKey), '-subj', subject(name), '-set_serial', serial,
            '-not_before', NOT_BEFORE, '-not_after', NOT_AFTER, '-outform', 'DER', '-out', tmp(file)], cnf);
        return fs.readFileSync(tmp(file));
    };
    const draft = make('draft.der');
    fs.writeFileSync(tmp('pretbs.der'), preTbs(draft));
    const signature = ossl(['pkeyutl', '-sign', '-inkey', tmp(altKey), '-rawin', '-in', tmp('pretbs.der')]);
    const final = make('final.der', wrap(0x03, Buffer.concat([Buffer.from([0]), signature])));
    if (!preTbs(final).equals(preTbs(draft))) throw new Error('the preTBSCertificate changed when the altSignatureValue was added');
    fs.writeFileSync(tmp('pretbs-final.der'), preTbs(final));
    fs.writeFileSync(tmp('alt.sig'), signature);
    fs.writeFileSync(tmp('alt.pub'), ossl(['pkey', '-in', tmp(altKey), '-pubout']));
    // The alternative signature must verify with the alternative public key, or the fixture proves nothing.
    ossl(['pkeyutl', '-verify', '-pubin', '-inkey', tmp('alt.pub'), '-rawin', '-in', tmp('pretbs-final.der'), '-sigfile', tmp('alt.sig')]);
    ossl(['x509', '-inform', 'DER', '-in', tmp('final.der'), '-out', out(`${name}.crt.pem`)]);
}

try {
    for (const level of ['44', '65', '87']) key(`ml-dsa-${level}.key`, `ML-DSA-${level}`);
    key('ec-p256.key', 'EC', ['-pkeyopt', 'ec_paramgen_curve:P-256']);
    key('rsa-2048.key', 'RSA', ['-pkeyopt', 'rsa_keygen_bits:2048']);

    certAndCsr('ml-dsa-44', 'ml-dsa-44.key', '0x4401');
    certAndCsr('ml-dsa-65', 'ml-dsa-65.key', '0x6501');
    certAndCsr('ml-dsa-87', 'ml-dsa-87.key', '0x8701');
    certAndCsr('ec-p256', 'ec-p256.key', '0x2561');
    certAndCsr('rsa-2048', 'rsa-2048.key', '0x2048');
    // The hybrid reuses the EC P-256 and ML-DSA-65 keys: the platform links a certificate to the key of the same public key, so the
    // hybrid brings no new key when the EC P-256 and ML-DSA-65 certificates were uploaded first.
    hybrid('hybrid-ec-p256-ml-dsa-65', 'ec-p256.key', 'ml-dsa-65.key', '0x6565');
    for (const f of OUTPUTS) fs.copyFileSync(tmp(f), path.join(OUT, f));
    console.log(`${OUTPUTS.length} fixtures written to ${OUT}`);
} finally {
    fs.rmSync(TMP, { recursive: true, force: true });
}
