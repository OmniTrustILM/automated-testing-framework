/**
 * API-CERT-69 — The platform decodes and measures ML-DSA public keys (core#2642, fix core#2641): uploaded certificates, inspected requests
 * and a hybrid certificate's alternative key; the EC P-256 and RSA 2048 rows are classic controls.
 * The fixtures are public static files with fixed names (data/ml-dsa), so uploads are derived objects; the hybrid row reuses the keys of
 * the EC P-256 and ML-DSA-65 uploads of the same run.
 */
import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { send } from '../../../utils/regression/inventory/searchApi';
import { certificateFingerprint, inspectionBody, ROUTES, uploadBody } from '../../../utils/regression/inventory/importFixtures';
import { getCertificate, pollCertificateByFingerprint, serverCreatedAfter, type ApiAnswer } from '../../../utils/regression/apiReads';
import { requiredCustomAttributes } from '../../../utils/regression/customAttributes';
import { readLedger, recordDerived } from '../../../utils/regression/ledger/ledger';
import { checkOwnership } from '../../../utils/regression/ledger/ownership';
import { runId, runName } from '../../../utils/regression/ledger/runState';
import { tierIdentity } from '../../../utils/regression/tier/kind';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import type { OwnObjects } from '../../../utils/regression/ownObjects';

type Json = Record<string, any>;

const ID = 'API-CERT-69';
const ISSUE = ['ilm#428', 'core#2642'];
const RULE = 'core#2642 expected behaviour / core#2641: ML-DSA public keys are decoded with Bouncy Castle, so KeySizeUtil measures them (ML-DSA-44 10496, ML-DSA-65 15616, ML-DSA-87 20736 bits) and the alternative key of a hybrid certificate is measured and its signature verified; classic keys are unchanged';

const DATA = path.join(__dirname, 'data', 'ml-dsa');
const fixture = (file: string): Buffer => fs.readFileSync(path.join(DATA, file));

interface KeyCase {
    row: string;
    /** File stem under data/ml-dsa. */
    file: string;
    algorithm: string;
    bits: number;
    signatureAlgorithm: string;
    control?: boolean;
}

const CASES: KeyCase[] = [
    { row: 'ml-dsa-44', file: 'ml-dsa-44', algorithm: 'ML-DSA', bits: 10496, signatureAlgorithm: 'ML-DSA-44' },
    { row: 'ml-dsa-65', file: 'ml-dsa-65', algorithm: 'ML-DSA', bits: 15616, signatureAlgorithm: 'ML-DSA-65' },
    { row: 'ml-dsa-87', file: 'ml-dsa-87', algorithm: 'ML-DSA', bits: 20736, signatureAlgorithm: 'ML-DSA-87' },
    { row: 'ec-p256-control', file: 'ec-p256', algorithm: 'ECDSA', bits: 256, signatureAlgorithm: 'SHA256withECDSA', control: true },
    { row: 'rsa-2048-control', file: 'rsa-2048', algorithm: 'RSA', bits: 2048, signatureAlgorithm: 'SHA256withRSA', control: true },
];

/** File stems this worker uploaded (201) in this run: the hybrid row needs the EC P-256 and ML-DSA-65 ones. */
const uploadedThisRun = new Set<string>();

/**
 * The older ledger line of THIS tier that records `uuid` as a derived certificate of another run (and no `deleted` line for it), or
 * undefined. Such a fixture is a leftover of an earlier run of this spec, not someone else's object.
 */
function olderRunLine(uuid: string) {
    const tier = tierIdentity();
    if (!tier) return undefined;
    const lines = readLedger().filter((l) => l.type === 'certificates' && l.uuid === uuid && l.tier === tier);
    if (lines.some((l) => l.event === 'deleted')) return undefined;
    return lines.find((l) => l.event === 'created' && l.derived && l.runId && l.runId !== runId());
}

/**
 * Uploads one fixture certificate. Ledger before assertion: a 201 is recorded at once as a derived certificate (fixed common name),
 * with the key and the alternative key the platform linked to it, all bound by the server time read before the upload.
 */
async function uploadFixture(api: GuardedApi, own: OwnObjects, file: string): Promise<{ uuid: string; detail: Json; uploaded: boolean }> {
    const pem = fixture(file);
    const attributes = await requiredCustomAttributes(api, 'certificates', runName('ca'));
    const createdAfter = await serverCreatedAfter(api);
    const answer: ApiAnswer = await send(api, 'POST', ROUTES.upload, { data: uploadBody(pem, attributes) });
    const uuid = (answer.json as Json | undefined)?.uuid as string | undefined;
    if (answer.status < 300 && uuid) {
        const name = `fixture ${file}`;
        if (!checkOwnership({ uuid }).own) {
            recordDerived('certificates', { uuid, name }, { spec: own.spec, createdAfter, note: 'uploaded static fixture (fixed common name): derived, deleted only when made during the run' });
        }
        await own.derivedKey(uuid, createdAfter);
    }
    if (answer.status === 409) {
        // Already on the tier: a leftover of an older run of this spec (ledger, this tier) is checked read-only; anything else fails below.
        const existing = await pollCertificateByFingerprint(api, certificateFingerprint(pem.toString('utf8')), 10_000);
        const older = existing?.uuid ? olderRunLine(String(existing.uuid)) : undefined;
        if (older) {
            test.info().annotations.push({ type: 'older run fixture', description: `${file} is on the tier from an earlier run (ledger line ${older.at}); its detail is checked read-only` });
            const detail = await getCertificate(api, String(existing!.uuid));
            expect(detail.fingerprint, 'the existing certificate').toBe(certificateFingerprint(pem.toString('utf8')));
            return { uuid: String(existing!.uuid), detail, uploaded: false };
        }
    }
    expect(answer.status, answer.status === 409
        ? `the fixture ${file} is already on the tier (uploaded before this run, not this run's object, no older ledger line of this tier): remove it by hand (data/ml-dsa/README.md) or regenerate the fixtures`
        : `POST /v1/certificates/upload ${file}: ${answer.text.slice(0, 300)}`).toBe(201);
    const detail = await getCertificate(api, uuid!);
    expect(detail.fingerprint, 'the uploaded certificate').toBe(certificateFingerprint(pem.toString('utf8')));
    uploadedThisRun.add(file.replace(/\.crt\.pem$/, ''));
    return { uuid: uuid!, detail, uploaded: true };
}

/** The items of a linked key: exactly one public item, with its algorithm and length. */
async function publicItemOf(api: GuardedApi, keyUuid: string | undefined, what: string): Promise<Json> {
    expect(keyUuid, `${what}: the platform linked a key`).toBeTruthy();
    const answer = await send(api, 'GET', `/api/v1/keys/${keyUuid}`);
    expect(answer.status, `GET /v1/keys (${what}): ${answer.text.slice(0, 200)}`).toBe(200);
    const items = ((answer.json as Json).items ?? []) as Json[];
    expect(items.map((i) => i.type), `${what}: the key holds one public item`).toEqual(['Public']);
    return items[0];
}

test.describe('ML-DSA key decoding (core#2642)', { tag: tags.api }, () => {
    // The upload rows and the hybrid row run in order in one worker: the hybrid reuses the keys the EC P-256 and ML-DSA-65 uploads bring.
    test.describe.serial('upload (controls) and the hybrid certificate', () => {
        for (const c of CASES) {
            test(`upload: a ${c.row} certificate reports ${c.algorithm} ${c.bits} bits on the certificate and its key`,
                testMeta({ id: ID, row: `upload-${c.row}`, prio: 'P2', issue: ISSUE, rule: [RULE, `control (not revert-sensitive: the primary key of an uploaded certificate was never on the bug's path): ${c.file} certificate → ${c.algorithm} ${c.bits}, signature ${c.signatureAlgorithm}${c.control ? ' (classic key)' : ''}`] }),
                async ({ api, own, needs }) => {
                    await needs.requiredAttributesFillable('certificates');
                    const { detail } = await uploadFixture(api, own, `${c.file}.crt.pem`);

                    expect(detail.publicKeyAlgorithm, 'public key algorithm').toBe(c.algorithm);
                    expect(detail.keySize, 'key size in bits').toBe(c.bits);
                    expect(detail.signatureAlgorithm, 'signature algorithm').toBe(c.signatureAlgorithm);
                    expect(detail.hybridCertificate, 'not a hybrid certificate').toBe(false);

                    const item = await publicItemOf(api, (detail.key as Json | undefined)?.uuid, 'key');
                    expect(item.keyAlgorithm, 'key item algorithm').toBe(c.algorithm);
                    expect(item.length, 'key item length').toBe(c.bits);
                });
        }

        test('upload: a hybrid certificate reports its ML-DSA-65 alternative key with 15616 bits',
            testMeta({ id: ID, row: 'upload-hybrid-ec-p256-ml-dsa-65', prio: 'P2', issue: ISSUE, rule: [RULE, 'the original report: the ML-DSA alternative key of a hybrid certificate had altKeySize -1', 'X.509 alternative key and signature (2.5.29.72 / 73 / 74): primary EC P-256 256, alternative ML-DSA-65 15616'] }),
            async ({ api, own, needs }) => {
                const missing = ['ec-p256', 'ml-dsa-65'].filter((f) => !uploadedThisRun.has(f));
                test.skip(missing.length > 0, `the hybrid reuses the keys of ${missing.join(' and ')}, which were not uploaded in this run (failed, skipped or an older run's fixture): it would bring keys of its own`);
                await needs.requiredAttributesFillable('certificates');
                const { detail } = await uploadFixture(api, own, 'hybrid-ec-p256-ml-dsa-65.crt.pem');

                expect(detail.hybridCertificate, 'a hybrid certificate').toBe(true);
                expect(detail.publicKeyAlgorithm, 'primary key algorithm').toBe('ECDSA');
                expect(detail.keySize, 'primary key size').toBe(256);
                expect(detail.altPublicKeyAlgorithm, 'alternative key algorithm').toBe('ML-DSA');
                expect(detail.altKeySize, 'alternative key size (-1 before the fix)').toBe(15616);
                expect(detail.altSignatureAlgorithm, 'alternative signature algorithm').toBe('ML-DSA-65');

                const primary = await publicItemOf(api, (detail.key as Json | undefined)?.uuid, 'primary key');
                expect([primary.keyAlgorithm, primary.length], 'primary key item').toEqual(['ECDSA', 256]);
                const alternative = await publicItemOf(api, (detail.altKey as Json | undefined)?.uuid, 'alternative key');
                expect([alternative.keyAlgorithm, alternative.length], 'alternative key item').toEqual(['ML-DSA', 15616]);
            });
    });

    for (const c of CASES) {
        test(`inspection: a ${c.row} request reports ${c.algorithm} ${c.bits} bits`,
            testMeta({ id: ID, row: `inspect-csr-${c.row}`, prio: 'P2', issue: ISSUE, rule: [RULE, 'InspectedEntryMapper: a PKCS#10 entry reports its key algorithm and length; POST /v1/inspections stores nothing', `${c.file} request → signingRequest ${c.algorithm} ${c.bits}${c.control ? ' (classic control)' : ' (revert-sensitive)'}`] }),
            async ({ api }) => {
                const answer = await send(api, 'POST', ROUTES.inspect, { data: inspectionBody(fixture(`${c.file}.csr.pem`)) });
                expect(answer.status, `POST /v1/inspections: ${answer.text.slice(0, 300)}`).toBe(200);
                const entries = ((answer.json as Json).entries ?? []) as Json[];
                expect(entries.map((e) => ({ kind: e.kind, keyAlgorithm: e.keyAlgorithm, keyLength: e.keyLength })), 'one request entry')
                    .toEqual([{ kind: 'signingRequest', keyAlgorithm: c.algorithm, keyLength: c.bits }]);
            });
    }

    // The reason is the `parked` annotation of the declaration: it reaches the report (a fixme body never runs).
    test.fixme('validation: the ML-DSA signatures and the alternative signature of the hybrid verify',
        testMeta({
            id: ID, row: 'validate-signatures', prio: 'P2', issue: ISSUE,
            rule: [RULE, 'GET /v1/certificates/{uuid}/validate: signature check valid; for the hybrid "Self-signed alternative signature verification successful."'],
            parked: 'GET …/validate stores its result, so the guard sends it for run-prefixed own objects only; the fixtures have a fixed name (no ML-DSA signer at run time) and are derived objects (verified by hand 2026-10-29: valid)',
        }),
        async () => {});
});
