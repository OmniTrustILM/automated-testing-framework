/**
 * API-CERT-64, 65, 68 — Inspection, import and plain upload of certificates. ilm#428.
 *
 * WHAT: 1. Inspection (POST /v1/inspections), one test per input: garbage bytes, an empty file, a DH PARAMETERS block, two private keys in
 *          a PEM, a PKCS#12 without or with a wrong passphrase (the same text), an encrypted PKCS#8 key without or with a wrong
 *          passphrase, a key under another passphrase than its store, 201 certificates and 101 other entries, a malformed or unknown
 *          tokenProfileUuid, a `file` that is not base64 or not a string, no `file` → the fixed refusal (422 array of strings, 400 / 404
 *          {message}); 200 certificates and 100 other entries are accepted; a refused file stores nothing.
 *       2. Plain upload (POST /v1/certificates/upload): PEM, DER, PKCS#7 PEM and DER → 201 {uuid}, state issued, the uploaded
 *          fingerprint and common name; the asynchronous upload → 202 {fingerprint} and the certificate appears.
 *       3. A keystore, a certificate request and garbage uploaded as a certificate → 422 with the fixed text, nothing created.
 *       4. The same certificate twice → 409 and one certificate; the same certificate through /import → 200 `existing` with the
 *          uuid of the uploaded one.
 * WHY: the refusal texts are fixed and the password refusals are non-oracular (a wrong and a missing password give the same text);
 *      the limits are 200 certificates and 100 other entries (core#2137). An import never changes an object that already exists
 *      (core#2414), so the wizard and the plain upload treat an existing certificate alike; the plain upload keeps its 409. PEM, DER
 *      and PKCS#7 uploads must not regress (ilm#248). The published OpenAPI document declares no 409 / 422 for the upload (spec gap).
 * HOW: files are built in memory (importFixtures) with run-prefixed common names and generated passwords; every create is recorded in the
 *      ledger (with its derived key) before the first assertion; required custom attributes of certificates are read first and only
 *      an unfillable one skips. The inspection rows are stored as data and run as a loop.
 */
import { ASYNC_UPLOAD_WAIT_MS, MANY_STEPS_TEST_MS } from '../../../utils/regression/timeouts';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { expectRefused } from '../../../utils/regression/errorContract';
import { isolation, propertyFilter, searchPage, send } from '../../../utils/regression/inventory/searchApi';
import {
    certificate, certificatesInOnePem, csrPem, dhParametersPem, garbageBytes, Identity, importBody, importCn, inspectionBody, LIMITS, pemTwoKeys, pkcs12,
    expectImportRefused, pkcs12TwoPassphrases, pkcs7Der, pkcs7Pem, pkcs8Key, REFUSAL, requestsInOnePem, ROUTES, uploadBody,
} from '../../../utils/regression/inventory/importFixtures';
import { getCertificate, serverCreatedAfter } from '../../../utils/regression/apiReads';
import { recordCertificatesNamed, recordDerivedKeyOf } from '../../../utils/regression/issuedRecords';
import { requiredCustomAttributes, UnfillableAttributeError } from '../../../utils/regression/customAttributes';
import { recordIfAccepted } from '../../../utils/regression/ownCrud';
import { runName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import { randomBytes } from 'node:crypto';
// Run-scoped generated test passwords: no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_2 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_3 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_4 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_5 = `qa-${randomBytes(9).toString('base64url')}`;

type Json = Record<string, any>;

// ------------------------------------------------------------------ API-CERT-65: inspection refusals

const RULE_65 = 'fixed refusal texts; non-oracular password refusals; inspection / import status rows; core#2137';

/** The answer one row expects. */
type Expected =
    | { status: 422; text: string }
    | { status: 400 | 404; message: string }
    | { status: 200; entries: number; kind: string };

interface InspectionRow {
    row: string;
    /** The behaviour, in the title. */
    title: string;
    behaviour: string;
    /**
     * Builds the request body (and the run-prefixed common-name prefix its file carries, for the "nothing stored" check). The
     * tokenProfileUuid of the unknown-profile row is a probe uuid.
     */
    build: (probe: () => string) => { body: Record<string, unknown>; prefix?: string; expected: Expected };
}

const ENTRY_LIMIT_NOTE = 'ContainerAssembler.requireWithinLimits → ContainerLimits';

/**
 * The rows of API-CERT-65 (garbage, empty content, DH-parameters PEM block, two keys in a PEM, PKCS#12 without / with wrong password,
 * encrypted PKCS#8 without / with wrong passphrase, key under another passphrase than its store, 201 certificates, 101 other entries,
 * malformed or unknown `tokenProfileUuid`, non-base64 `file`, missing file) plus the boundary rows 200 certificates / 100 other entries
 * (accepted).
 */
const INSPECTION_ROWS: InspectionRow[] = [
    {
        row: 'garbage',
        title: 'garbage bytes are refused 422 as not in a supported format',
        behaviour: 'garbage bytes → 422 "not in a supported format" (DerFormat)',
        build: () => ({ body: inspectionBody(garbageBytes()), expected: { status: 422, text: REFUSAL.notSupportedFormat } }),
    },
    {
        row: 'empty-content',
        title: 'an empty file is refused 422 as not in a supported format',
        behaviour: 'an empty file (zero decoded bytes) → 422 "not in a supported format" (DerFormat: no structure)',
        build: () => ({ body: inspectionBody(Buffer.alloc(0)), expected: { status: 422, text: REFUSAL.notSupportedFormat } }),
    },
    {
        row: 'dh-parameters',
        title: 'a certificate plus a DH PARAMETERS block is refused 422',
        behaviour: 'a certificate plus a DH PARAMETERS block → 422 "PEM block of type DH PARAMETERS … not supported" (PemFormat)',
        build: () => {
            const cn = importCn('dh');
            return { body: inspectionBody(Buffer.from(`${certificate(cn).pem}${dhParametersPem()}`)), prefix: cn, expected: { status: 422, text: REFUSAL.pemBlockUnsupported('DH PARAMETERS') } };
        },
    },
    {
        row: 'pem-two-keys',
        title: 'a PEM with two private keys is refused 422',
        behaviour: 'a PEM with two private keys → 422 "at most one private key" (PemFormat)',
        build: () => {
            const cn = importCn('two-keys');
            return { body: inspectionBody(Buffer.from(`${certificate(cn).pem}${pemTwoKeys()}`)), prefix: cn, expected: { status: 422, text: REFUSAL.pemTooManyKeys } };
        },
    },
    {
        row: 'pkcs12-missing-password',
        title: 'a protected PKCS#12 without a passphrase is refused 422',
        behaviour: 'a protected PKCS#12 without a passphrase → 422 integrity check failed (Pkcs12Mac)',
        build: () => {
            const cn = importCn('p12-missing');
            return { body: inspectionBody(pkcs12(cn, GEN_PW_1).bytes), prefix: cn, expected: { status: 422, text: REFUSAL.integrityFailed } };
        },
    },
    {
        row: 'pkcs12-wrong-password',
        title: 'the same PKCS#12 with a wrong passphrase gives the same 422 text',
        behaviour: 'the same PKCS#12 with a wrong passphrase → the SAME 422 text (non-oracular)',
        build: () => {
            const cn = importCn('p12-wrong');
            return { body: inspectionBody(pkcs12(cn, GEN_PW_1).bytes, { passphrase: GEN_PW_2 }), prefix: cn, expected: { status: 422, text: REFUSAL.integrityFailed } };
        },
    },
    {
        row: 'pkcs8-missing-passphrase',
        title: 'an encrypted PKCS#8 key without a passphrase is refused 422',
        behaviour: 'an encrypted PKCS#8 key without a passphrase → 422 "key could not be read" (KeyNormalizer)',
        build: () => ({ body: inspectionBody(Buffer.from(pkcs8Key(GEN_PW_1).pem)), expected: { status: 422, text: REFUSAL.keyUnreadable } }),
    },
    {
        row: 'pkcs8-wrong-passphrase',
        title: 'the same key with a wrong passphrase gives the same 422 text',
        behaviour: 'the same kind of key with a wrong passphrase → the SAME 422 text',
        build: () => ({ body: inspectionBody(Buffer.from(pkcs8Key(GEN_PW_1).pem), { passphrase: GEN_PW_2 }), expected: { status: 422, text: REFUSAL.keyUnreadable } }),
    },
    {
        row: 'key-under-other-passphrase',
        title: 'a PKCS#12 key under another passphrase is refused 422',
        behaviour: 'a PKCS#12 whose key is under another passphrase than the file → 422 "different passphrase than the file itself" (ContainerAssembler)',
        build: () => {
            const cn = importCn('p12-two-pass');
            return { body: inspectionBody(pkcs12TwoPassphrases(cn, GEN_PW_3, GEN_PW_4).bytes, { passphrase: GEN_PW_3 }), prefix: cn, expected: { status: 422, text: REFUSAL.twoPassphrases } };
        },
    },
    {
        row: 'certificates-201',
        title: '201 certificates in one PEM are refused 422 (count limit 200)',
        behaviour: `201 certificates in one PEM → 422 "certificate count limit of ${LIMITS.certificates}" (${ENTRY_LIMIT_NOTE})`,
        build: () => {
            const cn = importCn('c201');
            return { body: inspectionBody(Buffer.from(certificatesInOnePem(LIMITS.certificates + 1, cn).pem)), prefix: cn, expected: { status: 422, text: REFUSAL.certificateCount } };
        },
    },
    {
        row: 'certificates-200',
        title: '200 certificates in one PEM are accepted (count limit boundary)',
        behaviour: `200 certificates in one PEM are accepted (boundary of the certificate count limit): 200 entries of kind certificate`,
        build: () => {
            const cn = importCn('c200');
            return { body: inspectionBody(Buffer.from(certificatesInOnePem(LIMITS.certificates, cn).pem)), prefix: cn, expected: { status: 200, entries: LIMITS.certificates, kind: 'certificate' } };
        },
    },
    {
        row: 'entries-101',
        title: '101 other entries in one PEM are refused 422 (entry limit 100)',
        behaviour: `101 other entries (certificate requests) in one PEM → 422 "entry count limit of ${LIMITS.otherEntries}" (${ENTRY_LIMIT_NOTE})`,
        build: () => ({ body: inspectionBody(Buffer.from(requestsInOnePem(LIMITS.otherEntries + 1, importCn('r101')).pem)), expected: { status: 422, text: REFUSAL.entryCount } }),
    },
    {
        row: 'entries-100',
        title: '100 other entries are accepted (entry limit boundary)',
        behaviour: `100 other entries are accepted (boundary of the entry count limit): 100 entries of kind signingRequest`,
        build: () => ({ body: inspectionBody(Buffer.from(requestsInOnePem(LIMITS.otherEntries, importCn('r100')).pem)), expected: { status: 200, entries: LIMITS.otherEntries, kind: 'signingRequest' } }),
    },
    {
        row: 'token-profile-malformed',
        title: 'a malformed tokenProfileUuid is refused 422',
        behaviour: 'a malformed tokenProfileUuid → 422 "tokenProfileUuid must be a UUID" (FileInspectionServiceImpl; checked before the file is read)',
        build: () => ({ body: inspectionBody(Buffer.from(certificate(importCn('tp-bad')).pem), { tokenProfileUuid: 'not-a-uuid' }), expected: { status: 422, text: REFUSAL.tokenProfileNotUuid } }),
    },
    {
        row: 'token-profile-unknown',
        title: 'an unknown tokenProfileUuid is refused 404',
        behaviour: 'an unknown tokenProfileUuid (a well-formed probe uuid) → 404 {message} "Object of type \'TokenProfile\' identified by <uuid> is not found." (KeyImportGates)',
        build: (probe) => {
            const uuid = probe();
            return { body: inspectionBody(Buffer.from(certificate(importCn('tp-none')).pem), { tokenProfileUuid: uuid }), expected: { status: 404, message: REFUSAL.tokenProfileNotFound(uuid) } };
        },
    },
    {
        row: 'file-not-base64',
        title: 'a `file` that is not base64 is refused 400',
        behaviour: 'a `file` that is not base64 → 400 {message: "Unable to read HTTP message"} (UploadedFileDeserializer → ExceptionHandlingAdvice)',
        build: () => ({ body: inspectionBody({ raw: '***not base64***' }), expected: { status: 400, message: REFUSAL.unreadableMessage } }),
    },
    {
        row: 'file-not-a-string',
        title: 'a `file` that is a number is refused 400',
        behaviour: 'a `file` that is a number → 400 {message: "Unable to read HTTP message"} (UploadedFileDeserializer: not a string)',
        build: () => ({ body: inspectionBody({ raw: 12345 }), expected: { status: 400, message: REFUSAL.unreadableMessage } }),
    },
    {
        row: 'file-missing',
        title: 'no `file` member is refused 422',
        behaviour: 'no `file` member → 422 "file file is required" (UploadRequestDto)',
        build: () => ({ body: inspectionBody(undefined), expected: { status: 422, text: REFUSAL.fileRequired } }),
    },
];

/** Nothing stored: no certificate whose common name starts with the file's run-prefixed name. */
async function expectNothingStored(api: GuardedApi, prefix: string): Promise<void> {
    const found = await searchPage(api, { filters: [isolation(prefix)], itemsPerPage: 10, pageNumber: 1, includeArchived: true });
    expect(found.totalItems, `certificates under ${prefix}`).toBe(0);
}

test.describe('inspection refusals', { tag: tags.api }, () => {
    for (const r of INSPECTION_ROWS) {
        test(`${r.title}`,
            testMeta({ id: 'API-CERT-65', row: r.row, prio: 'P1', issue: 'ilm#428', rule: [RULE_65, r.behaviour] }),
            async ({ api }) => {
                const { body, prefix, expected } = r.build(() => api.probeUuid());
                const answer = await send(api, 'POST', ROUTES.inspect, { data: body });

                // Never a 5xx; the status and the body shape of the row (errorContract: 422 = array of strings, 400 / 404 = {message}).
                expect(answer.status, `POST /v1/inspections: ${answer.text.slice(0, 300)}`).toBe(expected.status);
                if (expected.status === 422) {
                    expectImportRefused(answer, expected.text, 'POST /v1/inspections');
                } else if (expected.status === 200) {
                    const entries = (answer.json as Json).entries as Json[];
                    expect(entries).toHaveLength(expected.entries);
                    expect(new Set(entries.map((e) => e.kind))).toEqual(new Set([expected.kind]));
                    expect(new Set(entries.map((e) => e.entryReference)).size, 'entry references are distinct').toBe(expected.entries);
                } else {
                    expectRefused(answer, { status: expected.status, text: expected.message, what: 'POST /v1/inspections' });
                }
                if (prefix) await expectNothingStored(api, prefix);
            });
    }
});

// ------------------------------------------------------------------ API-CERT-68: plain upload

const RULE_68 = 'plain upload: fixed refusal texts; wizard `existing` vs plain-upload 409; core#2137 AC (a keystore uploaded as a single certificate is refused with a pointer to the import; PEM / DER / PKCS#7 behave as before)';
const UPLOAD_SPEC_GAP = 'the published OpenAPI document declares no 409 / 422 for POST /v1/certificates/upload (spec gap; API-GEN-26 owns the schema check)';

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The required custom attributes of certificates (a tier may define some): upload carries them. Only "the suite cannot fill it" skips,
 * with the reason; a failed read of the definitions fails the test. Call it before the first write of a test.
 */
async function certificateAttributes(api: GuardedApi): Promise<Json[]> {
    return requiredCustomAttributes(api, 'certificates', runName('ca')).catch((e: Error) => {
        if (!(e instanceof UnfillableAttributeError)) throw e;
        test.skip(true, `a required custom attribute of certificates cannot be filled by the suite (${e.message.slice(0, 120)})`);
        return [] as Json[];
    });
}

/** The certificates the search finds under a common name (the authoritative read). */
async function certificatesNamed(api: GuardedApi, commonName: string): Promise<Json[]> {
    return (await searchPage(api, { filters: [propertyFilter('COMMON_NAME', 'EQUALS', commonName)], itemsPerPage: 10, pageNumber: 1, includeArchived: true })).rows;
}

/**
 * A plain upload that must create a certificate: ledger (and derived key) right after the call, then the 201 contract and the read-back.
 * `attributes` are the required custom attributes when the caller already read them (a test with more than one upload reads them first).
 */
async function uploadCreating(api: GuardedApi, spec: string, identity: Identity, file: Buffer, note: string, attributes?: Json[]): Promise<{ uuid: string }> {
    const filled = attributes ?? await certificateAttributes(api);
    const createdAfter = await serverCreatedAfter(api);
    const answer = await send(api, 'POST', ROUTES.upload, { data: uploadBody(file, filled) });
    const uuid = (answer.json as Json | undefined)?.uuid as string | undefined;
    // Ledger before assertion: a 201 created an object whatever the rest of the test finds.
    recordIfAccepted('certificates', answer, identity.cn, spec, note);
    if (answer.status === 201 && uuid) await recordDerivedKeyOf(api, uuid, createdAfter, spec);
    expect(answer.status, `POST /v1/certificates/upload: ${answer.text.slice(0, 300)}`).toBe(201);
    expect(uuid, 'the 201 answers {uuid}').toMatch(canonicalUuid);
    return { uuid: uuid! };
}

/** A refused plain upload: status 422 and exactly one message, and nothing created under the certificate's name. */
async function uploadRefused(api: GuardedApi, spec: string, file: Buffer, text: string, prefix: string): Promise<void> {
    const answer = await send(api, 'POST', ROUTES.upload, { data: uploadBody(file, []) });
    // Ledger first: a refusal that wrongly succeeds created an own certificate (found by its run-prefixed name).
    if (answer.status < 300) await recordCertificatesNamed(api, prefix, spec, 'accepted although the upload should have been refused');
    expectImportRefused(answer, text, 'POST /v1/certificates/upload');
    expect(await certificatesNamed(api, prefix), `certificates named ${prefix}`).toHaveLength(0);
}

interface UploadRow {
    row: string;
    title: string;
    behaviour: string;
    /** The file the row uploads, from the identity built for it. */
    file: (identity: Identity) => Buffer;
}

/** A certificate of the run, as the file formats the plain upload takes. */
const UPLOAD_CREATING: UploadRow[] = [
    { row: 'pem', title: 'a PEM certificate', behaviour: 'a PEM certificate → 201 {uuid}, state issued', file: (i) => Buffer.from(i.pem) },
    { row: 'der', title: 'a DER certificate', behaviour: 'a DER certificate → 201 {uuid}, state issued', file: (i) => i.der },
    { row: 'pkcs7-pem', title: 'a PKCS#7 PEM', behaviour: 'a PKCS#7 PEM (degenerate SignedData holding the certificate) → 201 {uuid}, state issued', file: (i) => Buffer.from(pkcs7Pem([i])) },
    { row: 'pkcs7-der', title: 'a PKCS#7 DER', behaviour: 'a PKCS#7 DER → 201 {uuid}, state issued', file: (i) => pkcs7Der([i]) },
];

test.describe('plain upload', { tag: tags.api }, () => {
    for (const r of UPLOAD_CREATING) {
        test(`${r.title} gives 201 and reads back with the uploaded fingerprint`,
            testMeta({ id: 'API-CERT-68', row: r.row, prio: 'P1', issue: 'ilm#428', rule: [RULE_68, 'core#2137 AC / ilm#248 Regression Risk: plain PEM / DER / PKCS#7 uploads must not regress', r.behaviour] }),
            async ({ api, own }, testInfo) => {
                testInfo.annotations.push({ type: 'spec-gap', description: UPLOAD_SPEC_GAP });
                const identity = certificate(importCn(`up-${r.row}`));
                const { uuid } = await uploadCreating(api, own.spec, identity, r.file(identity), `plain upload (${r.row})`);

                const detail = await getCertificate(api, uuid);
                expect(detail.state, 'state of the uploaded certificate').toBe('issued');
                expect(detail.fingerprint, 'fingerprint = SHA-256 of the uploaded DER').toBe(identity.fingerprint);
                expect(detail.commonName).toBe(identity.cn);
                expect(await certificatesNamed(api, identity.cn), 'one certificate with that name').toHaveLength(1);
            });
    }

    test('the asynchronous upload answers 202 and the certificate appears',
        testMeta({ id: 'API-CERT-68', row: 'async', prio: 'P1', issue: 'ilm#428', rule: [RULE_68, '`/upload/async` answers 202 `{fingerprint}`', 'the certificate appears (found by a poll) with that fingerprint'] }),
        async ({ api, own }, testInfo) => {
            test.setTimeout(MANY_STEPS_TEST_MS);
            testInfo.annotations.push({ type: 'spec-gap', description: UPLOAD_SPEC_GAP });
            const identity = certificate(importCn('up-async'));
            const attributes = await certificateAttributes(api);
            const createdAfter = await serverCreatedAfter(api);

            const answer = await send(api, 'POST', ROUTES.uploadAsync, { data: uploadBody(Buffer.from(identity.pem), attributes) });
            // Ledger before assertion: whatever the answer was, a certificate that already exists under the name is recorded now.
            let uuids: string[] = await recordCertificatesNamed(api, identity.cn, own.spec, 'async upload (before the check)').catch(() => []);
            try {
                expect(answer.status, `POST /v1/certificates/upload/async: ${answer.text.slice(0, 300)}`).toBe(202);
                expect((answer.json as Json).fingerprint, 'the 202 answers {fingerprint}').toBe(identity.fingerprint);
                // Ledger from the poll: the certificate is recorded the moment it exists (it is found by its run-prefixed name).
                await expect
                    .poll(async () => (uuids = await recordCertificatesNamed(api, identity.cn, own.spec, 'async upload')).length, { timeout: ASYNC_UPLOAD_WAIT_MS, message: 'the async upload became a certificate' })
                    .toBe(1);
            } finally {
                // A late arrival after a failed poll must not leak.
                if (!uuids.length) uuids = await recordCertificatesNamed(api, identity.cn, own.spec, 'async upload (late)').catch(() => []);
            }
            await recordDerivedKeyOf(api, uuids[0], createdAfter, own.spec);
            const detail = await getCertificate(api, uuids[0]);
            expect(detail.fingerprint).toBe(identity.fingerprint);
            expect(detail.state).toBe('issued');
        });

    test('a PKCS#12 sent as a single certificate is refused 422 as a keystore',
        testMeta({ id: 'API-CERT-68', row: 'keystore', prio: 'P1', issue: 'ilm#428', rule: [RULE_68, 'CertificateUtil (KeystoreDetection.isKeystore)', '422 "The file is a keystore. Import it with the certificate import operation."', 'nothing is created'] }),
        async ({ api, own }, testInfo) => {
            testInfo.annotations.push({ type: 'spec-gap', description: UPLOAD_SPEC_GAP });
            const cn = importCn('up-keystore');
            await uploadRefused(api, own.spec, pkcs12(cn, GEN_PW_5).bytes, REFUSAL.uploadKeystore, cn);
        });

    test('a PEM certificate request is refused 422 as not a certificate, and nothing is created',
        testMeta({ id: 'API-CERT-68', row: 'csr', prio: 'P1', issue: 'ilm#428', rule: [RULE_68, 'CertificateUtil', '422 "Uploaded PEM encoded content is not certificate. Uploaded PEM type: CERTIFICATE REQUEST"'] }),
        async ({ api, own }, testInfo) => {
            testInfo.annotations.push({ type: 'spec-gap', description: UPLOAD_SPEC_GAP });
            const cn = importCn('up-csr');
            await uploadRefused(api, own.spec, Buffer.from(csrPem(cn).pem), REFUSAL.uploadNotCertificate('CERTIFICATE REQUEST'), cn);
        });

    test('bytes that are no certificate are refused 422 as an unsupported format',
        testMeta({ id: 'API-CERT-68', row: 'garbage', prio: 'P1', issue: 'ilm#428', rule: [RULE_68, 'CertificateUtil', '422 "Uploaded certificate content has invalid or unsupported format."', 'nothing is created'] }),
        async ({ api, own }, testInfo) => {
            testInfo.annotations.push({ type: 'spec-gap', description: UPLOAD_SPEC_GAP });
            // A garbage file carries no common name, so a companion certificate cannot be looked up: the refusal itself is the oracle
            // and the unchanged certificate count of the run's name prefix is checked on a name the file never held.
            await uploadRefused(api, own.spec, garbageBytes(), REFUSAL.uploadInvalid, importCn('up-garbage'));
        });

    test('the same certificate twice is refused 409 and still one certificate exists',
        testMeta({ id: 'API-CERT-68', row: 'duplicate', prio: 'P1', issue: 'ilm#428', rule: [RULE_68, 'CertificateUploadServiceImpl → AlreadyExistException → 409 (ExceptionHandlingAdvice)', '409 {message} "Certificate already exists with fingerprint <fp>"'] }),
        async ({ api, own }, testInfo) => {
            testInfo.annotations.push({ type: 'spec-gap', description: UPLOAD_SPEC_GAP });
            const identity = certificate(importCn('up-dup'));
            // Read before the first write: an unfillable required attribute skips the test before anything is uploaded.
            const attributes = await certificateAttributes(api);
            await uploadCreating(api, own.spec, identity, Buffer.from(identity.pem), 'plain upload (first of a duplicate pair)', attributes);

            const second = await send(api, 'POST', ROUTES.upload, { data: uploadBody(Buffer.from(identity.pem), attributes) });
            // A second 201 would be a second object: ledger first.
            recordIfAccepted('certificates', second, identity.cn, own.spec, 'a duplicate upload accepted');
            expectRefused(second, { status: 409, text: REFUSAL.uploadDuplicate(identity.fingerprint), what: 'second POST /v1/certificates/upload' });
            const byFingerprint = await searchPage(api, { filters: [propertyFilter('FINGERPRINT', 'EQUALS', identity.fingerprint)], itemsPerPage: 10, pageNumber: 1, includeArchived: true });
            expect(byFingerprint.totalItems, 'certificates with that fingerprint').toBe(1);
        });

    test(`the same certificate through /import answers 200 \`existing\``,
        testMeta({ id: 'API-CERT-68', row: 'existing-through-import', prio: 'P1', issue: 'ilm#428', rule: [RULE_68, 'core#2414: "An import never changes an object that already exists"; an existing certificate behaves the same in the wizard and in a plain upload', 'the intended difference to the plain upload\'s 409', 'still one certificate'] }),
        async ({ api, own }, testInfo) => {
            testInfo.annotations.push({ type: 'spec-gap', description: UPLOAD_SPEC_GAP });
            const identity = certificate(importCn('up-existing'));
            const first = await uploadCreating(api, own.spec, identity, Buffer.from(identity.pem), 'plain upload (then imported again)');

            const file = Buffer.from(identity.pem);
            const answer = await send(api, 'POST', ROUTES.import, { data: importBody(file, [identity.fingerprint]) });
            // A result that says `created` would be a second object: record it before asserting.
            for (const result of ((answer.json as Json | undefined)?.results as Json[] | undefined) ?? []) {
                if (result.certificateOutcome !== 'created') continue;
                if (typeof result.certificateUuid === 'string') {
                    own.record('certificates', { status: answer.status, uuid: result.certificateUuid, text: answer.text }, { name: identity.cn, note: 'import created a certificate the upload had already stored' });
                } else {
                    // A created result without a uuid: found and recorded by its run-prefixed name.
                    await own.recordNamed(identity.cn, 'import created a certificate the upload had already stored (no uuid in the result)');
                }
            }
            expect(answer.status, `POST /v1/certificates/import: ${answer.text.slice(0, 300)}`).toBe(200);
            const results = (answer.json as Json).results as Json[];
            expect(results).toHaveLength(1);
            expect(results[0].entryReference).toBe(identity.fingerprint);
            expect(results[0].kind).toBe('certificate');
            expect(results[0].imported).toBe(true);
            expect(results[0].certificateOutcome).toBe('existing');
            expect(results[0].certificateUuid, 'the caller may see it in detail: the uuid of the uploaded certificate').toBe(first.uuid);
            const byFingerprint = await searchPage(api, { filters: [propertyFilter('FINGERPRINT', 'EQUALS', identity.fingerprint)], itemsPerPage: 10, pageNumber: 1, includeArchived: true });
            expect(byFingerprint.totalItems, 'certificates with that fingerprint').toBe(1);
        });
});
