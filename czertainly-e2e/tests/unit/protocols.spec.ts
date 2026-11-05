/**
 * protocols — unit tests of the pure protocol helpers.
 *
 * Checks the sscep and openssl cmp output parsers, the CMP PKIMessage reader, the degenerate PKCS#7 and GetCACaps readers,
 * the ACME problem and stack-text readers, fixed garbage, and the protocol CA fixture's pure decisions. The protocol specs
 * judge what a client tool or a server printed; a reader that misparses an answer would turn a refusal into a pass or the
 * reverse, so each is pinned on known good and bad output. Pure calls on literal output; no network, client or file.
 */
import { expect, test } from '@playwright/test';
import * as crypto from 'crypto';
import { cmpArgs, CMP_SECRET_ENV, describeCmp, parseOpensslCmpOutput } from '../../utils/regression/protocols/cmpClient';
import { buildErrorPkiMessage, errorRejectionProblems, parsePkiMessage, PKI_FAILURE_INFO } from '../../utils/regression/protocols/cmpMessageParser';
import { selfSignedPem, challengePasswordOf, csrWithChallengePassword, pemToDer } from '../../utils/regression/pkiBuilders';
import { connectorsOfKind, keyItemProblems, pickOption, providerTokenName, schemaRequestAttribute, signatureAttributesFrom, SOFT_PROVIDER_GROUP } from '../../utils/regression/protocols/protocolCa';
import { acmeErrorType, acmeProblem, fixedGarbage, isProblemJson, stackTextIn } from '../../utils/regression/protocols/protocolHttp';
import { caChainProblems, certificateFacts, degeneratePkcs7Of, parseDegeneratePkcs7, parseGetCaCaps, scepCaSetProblems } from '../../utils/regression/protocols/protocolResponseReaders';
import { randomSecret } from '../../utils/regression/protocols/protocolProfiles';
import { parseSscepOutput } from '../../utils/regression/protocols/sscepClient';
import { childEnv, toolCommand } from '../../utils/regression/protocols/externalToolRunner';
import { acmeHeaders } from '../../utils/regression/protocols/acmeClient';

/** A self-signed EC P-256 certificate (PEM) through @peculiar/x509 (forge cannot make or read one). */
async function selfSignedEcPem(commonName: string): Promise<string> {
    require('reflect-metadata');
    const x509 = require('@peculiar/x509') as typeof import('@peculiar/x509');
    x509.cryptoProvider.set(crypto.webcrypto as unknown as Crypto);
    const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const keys = (await crypto.webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
    const cert = await x509.X509CertificateGenerator.createSelfSigned({ serialNumber: '02', name: `CN=${commonName}`, notBefore: new Date(), notAfter: new Date(Date.now() + 86_400_000), signingAlgorithm: alg, keys });
    return cert.toString('pem');
}

test.describe('sscep output', () => {
    test('pkistatus and failinfo are read by name or number (RFC 8894 numbers 0–4), any case', () => {
        expect(parseSscepOutput('sscep: pkistatus: SUCCESS\nsscep: certificate written as cert.pem')).toEqual({ pkiStatus: 'SUCCESS' });
        expect(parseSscepOutput('sscep: pkistatus: FAILURE\nsscep: failinfo: badMessageCheck')).toEqual({ pkiStatus: 'FAILURE', failInfo: 'badMessageCheck' });
        expect(parseSscepOutput('pkistatus: failure\nfailInfo: 1')).toEqual({ pkiStatus: 'FAILURE', failInfo: 'badMessageCheck' });
        expect(parseSscepOutput('pkistatus: FAILURE\nfailinfo: 2').failInfo).toBe('badRequest');
        expect(parseSscepOutput('pkistatus: FAILURE\nfailinfo: 3').failInfo).toBe('badTime');
        expect(parseSscepOutput('pkistatus: FAILURE\nfailinfo: 4').failInfo).toBe('badCertId');
        expect(parseSscepOutput('pkistatus: FAILURE\nfailinfo: 0').failInfo).toBe('badAlg');
        expect(parseSscepOutput('sscep: pkistatus: PENDING')).toEqual({ pkiStatus: 'PENDING' });
        expect(parseSscepOutput('nothing useful')).toEqual({});
    });
});

test.describe('openssl cmp output and arguments', () => {
    test('the OpenSSL 3 status line is read: PKIStatus, the PKIFailureInfo list and the quoted StatusString(s)', () => {
        // crypto/cmp/cmp_status.c OSSL_CMP_CTX_snprint_PKIStatus: "PKIStatus: %s; PKIFailureInfo: a, b; StatusStrings: "x", "y""
        const two = 'CMP error: received error:PKIStatus: rejection; PKIFailureInfo: certRevoked, badCertId; StatusStrings: "CMPSRV100: pki message request cannot be parsed", "second"\nCMP error: ...';
        expect(parseOpensslCmpOutput(two)).toEqual({ pkiStatus: 'rejection', failInfo: ['certRevoked', 'badCertId'], statusStrings: ['CMPSRV100: pki message request cannot be parsed', 'second'] });
        const one = 'PKIStatus: rejection; PKIFailureInfo: badRequest; StatusString: "unsupported"';
        expect(parseOpensslCmpOutput(one)).toEqual({ pkiStatus: 'rejection', failInfo: ['badRequest'], statusStrings: ['unsupported'] });
        const none = 'PKIStatus: accepted; <no failure info>';
        expect(parseOpensslCmpOutput(none)).toEqual({ pkiStatus: 'accepted', failInfo: [], statusStrings: [] });
        // The old lower-case `failInfo:` label is NOT the OpenSSL format and must not be read as one.
        expect(parseOpensslCmpOutput('failInfo: certRevoked').failInfo).toEqual([]);
        expect(parseOpensslCmpOutput('received IP\nCERTCONF sent')).toEqual({ failInfo: [], statusStrings: [] });
    });

    test('the argument list carries the command, the endpoint, the secret by environment reference and only the given optionals', () => {
        const args = cmpArgs({ command: 'ir', server: 'https://ilm.example', path: '/api/v1/protocols/cmp/raProfile/x', secret: 's3', ref: 'r', newKey: 'k.pem', subject: '/CN=a', certOut: 'c.pem', cwd: '/tmp' });
        expect(args.slice(0, 7)).toEqual(['cmp', '-cmd', 'ir', '-server', 'https://ilm.example', '-path', '/api/v1/protocols/cmp/raProfile/x']);
        expect(args).toEqual(expect.arrayContaining(['-secret', `env:${CMP_SECRET_ENV}`, '-ref', 'r', '-recipient', '/CN=ILM', '-unprotected_errors', '-newkey', 'k.pem', '-subject', '/CN=a', '-certout', 'c.pem']));
        expect(args.join(' ')).not.toContain('s3');
        expect(args).not.toContain('-oldcert');
        const rr = cmpArgs({ command: 'rr', server: 'https://ilm.example', path: '/p', secret: 's3', oldCert: 'c.pem', revReason: 1, cwd: '/tmp' });
        expect(rr).toEqual(expect.arrayContaining(['-cmd', 'rr', '-oldcert', 'c.pem', '-revreason', '1']));
        expect(rr).not.toContain('-newkey');
    });

    test('a failure description never shows a secret', () => {
        const secret = randomSecret();
        const run = { command: 'openssl', args: [...cmpArgs({ command: 'ir', server: 'https://x', path: '/p', secret, cwd: '/tmp' }), '-x', `pass:${secret}`], exitCode: 1, stdout: '', stderr: 'PKIStatus: rejection; PKIFailureInfo: badRequest', output: 'PKIStatus: rejection; PKIFailureInfo: badRequest', timedOut: false, failInfo: ['badRequest'], statusStrings: [], pkiStatus: 'rejection' };
        const text = describeCmp(run);
        expect(text).not.toContain(secret);
        expect(text).toContain('pass:***');
        expect(text).toContain('failInfo=badRequest');
    });

    test('the tool command follows the REG_<TOOL>_BIN override requireTool probes; the child environment is minimal', () => {
        expect(toolCommand('sscep', {})).toBe('sscep');
        expect(toolCommand('openssl', { REG_OPENSSL_BIN: '/opt/ossl3/bin/openssl' })).toBe('/opt/ossl3/bin/openssl');
        const env = childEnv({ [CMP_SECRET_ENV]: 'x' }, { PATH: '/bin', HOME: '/h', REG_RUN_ID: 'qa-reg-x', SMOKE_CLIENT_SECRET: 'nope', AUTHORIZATION: 'Bearer y', LANG: 'C' });
        expect(env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C', [CMP_SECRET_ENV]: 'x' });
    });
});

test.describe('CMP PKIMessage reader', () => {
    test('an unprotected error message round-trips: body error, status rejection, failInfo names, status text', () => {
        const der = buildErrorPkiMessage({ failInfoBits: [2], statusString: 'CMPSRV100: pki message request cannot be parsed' });
        const m = parsePkiMessage(der);
        expect(m.pvno).toBe(2);
        expect(m.bodyType).toBe(23);
        expect(m.bodyName).toBe('error');
        expect(m.protected).toBe(false);
        expect(m.error).toMatchObject({ status: 2, statusLabel: 'rejection', failInfo: ['badRequest'], statusStrings: ['CMPSRV100: pki message request cannot be parsed'], errorDetails: [] });
        expect(errorRejectionProblems(m)).toEqual([]);
    });

    test('every single bit, every pair and 3-byte sets of failInfo bits round-trip (decodeBitStrings off)', () => {
        const check = (bits: number[]) => {
            const m = parsePkiMessage(buildErrorPkiMessage({ failInfoBits: bits, statusString: 'x' }));
            expect(m.error!.failInfo, `bits ${bits}`).toEqual([...bits].sort((a, b) => a - b).map((b) => PKI_FAILURE_INFO[b]));
        };
        for (let a = 0; a < 27; a++) check([a]);
        for (let a = 0; a < 27; a++) for (let b = a + 1; b < 27; b++) check([a, b]);
        for (const triple of [[2, 10, 19], [1, 9, 17], [0, 8, 16], [2, 9, 25], [5, 13, 21], [3, 11, 26]]) check(triple);
    });

    test('a non-rejection status and error details are read', () => {
        const m = parsePkiMessage(buildErrorPkiMessage({ failInfoBits: [1, 10, 25], status: 3, errorDetails: 'details' }));
        expect(m.error!.failInfo).toEqual(['badMessageCheck', 'certRevoked', 'systemFailure']);
        expect(m.error!.statusLabel).toBe('waiting');
        expect(m.error!.errorDetails).toEqual(['details']);
        expect(errorRejectionProblems(m)).toEqual(['status is waiting (3), not rejection (2)']);
        expect(PKI_FAILURE_INFO[26]).toBe('duplicateCertReq');
    });

    test('garbage, a bare SEQUENCE and a truncated message are refused with a reason', () => {
        expect(() => parsePkiMessage(Buffer.from('not der at all'))).toThrow(/not DER|SEQUENCE/);
        expect(() => parsePkiMessage(Buffer.from('3000', 'hex'))).toThrow(/no header/);
        const whole = buildErrorPkiMessage({ failInfoBits: [2], statusString: 'x' });
        expect(() => parsePkiMessage(whole.subarray(0, Math.floor(whole.length * 0.6)))).toThrow();
    });
});

/** The eight keywords the SCEP service advertises (SCEP overview in the platform documentation). */
const SCEP_CA_CAPS: readonly string[] = ['POSTPKIOperation', 'SHA-1', 'SHA-256', 'SHA-512', 'DES3', 'AES', 'Renewal', 'SCEPStandard'];

test.describe('SCEP helpers', () => {
    test('GetCACaps keywords parse with either line ending and match the eight the server advertises', () => {
        expect(parseGetCaCaps('POSTPKIOperation\r\nSHA-1\r\nSHA-256\r\nSHA-512\r\nDES3\r\nAES\r\nRenewal\r\nSCEPStandard\r\n')).toEqual([...SCEP_CA_CAPS]);
        expect(parseGetCaCaps('AES\nSHA-256\n\n')).toEqual(['AES', 'SHA-256']);
    });

    test('a degenerate PKCS#7 round-trips (RSA and EC certificates): fingerprints, subjects, the CA-presence and set checks', async () => {
        const a = selfSignedPem('qa-unit-ca-a');
        const ec = await selfSignedEcPem('qa-unit-ca-ec');
        const der = degeneratePkcs7Of([a.pem, ec]);
        const certs = parseDegeneratePkcs7(der);
        expect(certs.map((c) => c.subject)).toEqual(['CN=qa-unit-ca-a', 'CN=qa-unit-ca-ec']);
        expect(certs[0].fingerprint).toBe(certificateFacts(a.pem).fingerprint);
        expect(certs[1].fingerprint).toBe(crypto.createHash('sha256').update(pemToDer(ec)).digest('hex'));
        expect(certificateFacts(ec).commonName).toBe('qa-unit-ca-ec');
        expect(caChainProblems(certs, certs[0].fingerprint.toUpperCase())).toEqual([]);
        expect(caChainProblems(certs, 'ff'.repeat(32))).toEqual([`the CA certificate ${'ff'.repeat(32)} is not in the message`]);
        expect(scepCaSetProblems(certs, [certs[0].fingerprint, certs[1].fingerprint])).toEqual([]);
        expect(scepCaSetProblems(certs, [certs[0].fingerprint])).toEqual([`unexpected ${certs[1].fingerprint}`]);
        expect(scepCaSetProblems(certs, [certs[0].fingerprint, certs[1].fingerprint, 'ee'.repeat(32)])).toEqual([`missing ${'ee'.repeat(32)}`]);
        expect(() => parseDegeneratePkcs7(Buffer.from('3003020100', 'hex'))).toThrow(/not a PKCS#7/);
        expect(() => parseDegeneratePkcs7(pemToDer(a.pem))).toThrow(/not a PKCS#7/);
    });

    test('a CSR carries the challenge password only when one is given; the key and CN are what the facts read', () => {
        const pw = randomSecret();
        const withPw = csrWithChallengePassword('qa-unit-scep', pw);
        expect(challengePasswordOf(withPw.pem)).toBe(pw);
        expect(withPw.privateKeyPem).toMatch(/-----BEGIN RSA PRIVATE KEY-----/);
        expect(withPw.spkiBase64.length).toBeGreaterThan(300);
        const without = csrWithChallengePassword('qa-unit-scep', undefined, { dns: ['qa-unit-scep.example.test'] });
        expect(challengePasswordOf(without.pem)).toBeUndefined();
        expect(without.challengePassword).toBeUndefined();
        // The SPKI a certificate for that key would carry equals the CSR's (node:crypto export vs forge encoding).
        const key = crypto.createPublicKey(withPw.publicKeyPem);
        expect(Buffer.from(key.export({ type: 'spki', format: 'der' })).toString('base64')).toBe(withPw.spkiBase64);
    });
});

test.describe('ACME / HTTP readers', () => {
    const res = (text: string, contentType?: string) => ({ status: 400, headers: {}, contentType, body: Buffer.from(text), text });

    test('a problem document is read; anything else is undefined', () => {
        expect(acmeProblem(res('{"type":"urn:ietf:params:acme:error:malformed","detail":"x","status":400}'))).toEqual({ type: acmeErrorType('malformed'), detail: 'x', status: 400 });
        expect(acmeProblem(res('{"message":"x"}'))).toBeUndefined();
        expect(acmeProblem(res('not json'))).toBeUndefined();
        expect(isProblemJson('application/problem+json;charset=UTF-8')).toBe(true);
        expect(isProblemJson('application/json')).toBe(false);
    });

    test('stack and class text is found; ordinary messages are clean', () => {
        expect(stackTextIn('{"message":"java.lang.NullPointerException: x"}')).toBe('java.lang.NullPointerException');
        expect(stackTextIn('\tat com.otilm.core.service.Foo.bar(Foo.java:12)')).toMatch(/^at com\.otilm/);
        expect(stackTextIn('{"message":"SCEP error occurred: Failed to parse the SCEP request, failInfo=badMessageCheck"}')).toBeUndefined();
        expect(stackTextIn('{"type":"urn:ietf:params:acme:error:malformed","detail":"Malformed request"}')).toBeUndefined();
    });

    test('fixed garbage is deterministic per seed and length', () => {
        expect(fixedGarbage('a', 200).equals(fixedGarbage('a', 200))).toBe(true);
        expect(fixedGarbage('a', 200).length).toBe(200);
        expect(fixedGarbage('a', 200).equals(fixedGarbage('b', 200))).toBe(false);
        expect(fixedGarbage('a', 40).equals(fixedGarbage('a', 200).subarray(0, 40))).toBe(true);
    });
});

test.describe('protocol CA fixture decisions', () => {
    test('the provider token name follows the provider alphabet; a shared secret is URL-safe', () => {
        for (let i = 0; i < 20; i++) expect(providerTokenName()).toMatch(/^[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)*$/);
        expect(randomSecret()).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    });

    test('connectorsOfKind: the software provider is the connected connector whose cryptographyProvider group declares SOFT; the kind is read from the row', () => {
        const fg = (functionGroupCode: string, kinds: unknown) => ({ functionGroupCode, kinds });
        const rows = [
            { uuid: 'v1', name: 'Software-Cryptography-Provider', status: 'connected', functionGroups: [fg('cryptographyProvider', ['SOFT'])] },
            { uuid: 'v2', name: 'Software-Cryptography-Provider-v2', status: 'connected', functionGroups: [] },
            { uuid: 'hsm', name: 'Hsm', status: 'connected', functionGroups: [fg('cryptographyProvider', ['PKCS11'])] },
            { uuid: 'cred', name: 'Credentials', status: 'connected', functionGroups: [fg('credentialProvider', ['SOFT', 'Basic'])] },
            { uuid: 'down', name: 'Soft-offline', status: 'offline', functionGroups: [fg('cryptographyProvider', ['SOFT'])] },
            { uuid: 'nostatus', name: 'Soft-nostatus', functionGroups: [{ code: 'cryptographyProvider', kinds: ['PKCS11', 'SOFT'] }] },
            { uuid: 'nokinds', name: 'Soft-nokinds', status: 'connected', functionGroups: [fg('cryptographyProvider', null)] },
            { uuid: 'case', name: 'Soft-case', status: 'connected', functionGroups: [fg('cryptographyProvider', ['soft'])] },
        ];
        const { functionGroup, kind } = SOFT_PROVIDER_GROUP;
        expect(connectorsOfKind(rows, functionGroup, kind)).toEqual([
            { uuid: 'v1', name: 'Software-Cryptography-Provider', kind: 'SOFT' },
            { uuid: 'nostatus', name: 'Soft-nostatus', kind: 'SOFT' },
        ]);
        expect(connectorsOfKind(rows, functionGroup, 'PKCS11').map((r) => r.uuid)).toEqual(['hsm', 'nostatus']);
        expect(connectorsOfKind([], functionGroup, kind)).toEqual([]);
    });

    test('schemaRequestAttribute: the definition\'s version (v2 when absent), its uuid over the fallback; v3 items carry contentType, v2 items do not', () => {
        const fb = { name: 'data_keyAlias', uuid: 'fallback-uuid' };
        expect(schemaRequestAttribute(undefined, fb, 'string', [{ data: 'x' }])).toEqual({ name: 'data_keyAlias', uuid: 'fallback-uuid', version: 'v2', contentType: 'string', content: [{ data: 'x' }] });
        expect(schemaRequestAttribute({ uuid: 'u2', version: 2 }, fb, 'integer', [{ data: 2048, reference: 'RSA_2048' }])).toEqual({ name: 'data_keyAlias', uuid: 'u2', version: 'v2', contentType: 'integer', content: [{ data: 2048, reference: 'RSA_2048' }] });
        expect(schemaRequestAttribute({ uuid: 'u3', version: 3 }, fb, 'secret', [{ data: { secret: 's' } }])).toEqual({ name: 'data_keyAlias', uuid: 'u3', version: 'v3', contentType: 'secret', content: [{ data: { secret: 's' }, contentType: 'secret' }] });
        expect(schemaRequestAttribute({ uuid: 'u3', version: 'v3' }, fb, 'string', [{ data: 'a', contentType: 'text' }]).content).toEqual([{ data: 'a', contentType: 'text' }]);
        expect(signatureAttributesFrom([{ name: 'data_sigDigest', uuid: 'd', version: 3, contentType: 'string', content: [{ reference: 'SHA-256', data: 'SHA-256' }] }]))
            .toEqual([{ name: 'data_sigDigest', uuid: 'd', version: 'v3', contentType: 'string', content: [{ data: 'SHA-256', reference: 'SHA-256', contentType: 'string' }] }]);
    });

    test('key items are judged on algorithm, state and usages', () => {
        const ok = { items: [{ uuid: 'p', type: 'Private', keyAlgorithm: 'RSA', state: 'active', usage: ['sign', 'decrypt'] }, { uuid: 'q', type: 'Public', keyAlgorithm: 'RSA', state: 'active', usage: ['verify', 'encrypt'] }] };
        expect(keyItemProblems(ok)).toEqual({ privateUuid: 'p', publicUuid: 'q', problems: [] });
        const bad = { items: [{ uuid: 'p', type: 'Private', keyAlgorithm: 'RSA', state: 'pre-active', usage: ['sign'] }, { uuid: 'q', type: 'Public', keyAlgorithm: 'ECDSA', state: 'active', usage: ['verify'] }] };
        const problems = keyItemProblems(bad).problems;
        expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/not RSA/), expect.stringMatching(/pre-active/), expect.stringMatching(/lack decrypt \+ sign/), expect.stringMatching(/lack encrypt \+ verify/)]));
        expect(keyItemProblems({ items: [] }).problems).toEqual(['no private key item', 'no public key item']);
    });

    test('signature attributes prefer PKCS#1 v1.5 and SHA-256, fall back to the first option, and refuse a required attribute without options', () => {
        const schema = [
            { name: 'data_rsaSigScheme', uuid: 'u1', contentType: 'string', content: [{ reference: 'PSS', data: 'PSS' }, { reference: 'PKCS1-v1_5', data: 'PKCS1v15' }] },
            { name: 'data_sigDigest', uuid: 'u2', contentType: 'string', content: [{ reference: 'SHA-512', data: 'SHA-512' }, { reference: 'SHA-256', data: 'SHA-256' }] },
            { name: 'info_note', uuid: 'u3', type: 'info', content: [{ data: 'ignored' }] },
            { name: 'data_other', uuid: 'u4', contentType: 'string', content: [{ data: 'first' }, { data: 'second' }] },
        ];
        expect(signatureAttributesFrom(schema)).toEqual([
            { name: 'data_rsaSigScheme', uuid: 'u1', version: 'v2', contentType: 'string', content: [{ data: 'PKCS1v15', reference: 'PKCS1-v1_5' }] },
            { name: 'data_sigDigest', uuid: 'u2', version: 'v2', contentType: 'string', content: [{ data: 'SHA-256', reference: 'SHA-256' }] },
            { name: 'data_other', uuid: 'u4', version: 'v2', contentType: 'string', content: [{ data: 'first' }] },
        ]);
        expect(signatureAttributesFrom([{ name: 'data_empty', uuid: 'u5', content: [] }])).toEqual([]);
        expect(() => signatureAttributesFrom([{ name: 'data_empty', uuid: 'u5', content: [], properties: { required: true } }])).toThrow(/required/);
        expect(pickOption({ content: [] }, /x/)).toBeUndefined();
    });
});

// ------------------------------------------------------------------ acmeClient response headers

test('acmeHeaders: lower-case names, Retry-After, Replay-Nonce, Content-Type, Location and the server Date', () => {
    const h = new Headers({ 'Retry-After': '30', 'Replay-Nonce': 'n1', 'Content-Type': 'application/json', Location: 'https://acme.example.test/order/1', Date: 'Tue, 13 Oct 2026 10:00:00 GMT' });
    const r = acmeHeaders({ headers: h });
    expect(r.retryAfter).toBe('30');
    expect(r.replayNonce).toBe('n1');
    expect(r.contentType).toBe('application/json');
    expect(r.location).toBe('https://acme.example.test/order/1');
    expect(r.date?.toISOString()).toBe('2026-10-13T10:00:00.000Z');
    expect(r.headers['retry-after']).toBe('30');
    expect(acmeHeaders({ headers: new Headers({ Date: 'not a date' }) }).date).toBeUndefined();
});
