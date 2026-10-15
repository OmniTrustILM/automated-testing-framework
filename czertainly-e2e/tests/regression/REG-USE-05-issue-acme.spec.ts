/**
 * REG-USE-05 — Issue certificate using the ACME protocol (release checklist: Usage 5).
 *
 * Flow: the run's ACME profile (one exact, pre-authorized DNS identifier) activated on an own RA profile of the run →
 * RFC 8555 client: directory → account → order → `ready` without a challenge → finalize with a CSR → valid →
 * download → the certificate is in the inventory under that RA profile with protocol ACME; the account is listed in the
 * UI. Second order for a name that is NOT pre-authorized: challenges offered are http-01 / dns-01 only (the order is
 * left pending; nothing is answered).
 *
 * B1: REG-USE-05.1 (order and download details, one test per CSR key type) and REG-USE-05.2 (a second finalize) share
 * ONE ACME account (one client, made by whichever of them runs first), so a run registers one extra account, recorded
 * under a run-prefixed name (accounts go with their ACME profile: FK on delete cascade). Every certificate an order makes
 * is recorded by its run-prefixed common name (`recordingIssued`: after the finalize + wait return AND when they throw —
 * a finalize that errors after the server issued, a wait that times out; ledger before assertion, B1 micro-fix, Fable F2)
 * together with its linked `certKey_` key as a derived object whose `createdAfter` comes from the NEW-ORDER
 * response's Date (server clock, before the key exists; B1 fix pass, Sonnet F4); the run-end teardown revokes and deletes
 * them, deactivates ACME on the own RA profile and deletes the ACME profile. The SAN and chain oracles are CA-aware like
 * REG-USE-04.1 / 07.1 (`sanOracleFor`; a one-block download is a partial chain check unless the issuing CA certificate
 * is in the inventory, then two blocks are required).
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { AcmeAccountPage } from '../../pages/AcmeAccountPage';
import { AcmeClient, AcmeResponse } from '../../utils/regression/acmeClient';
import {
    certificateInfo, chainProblems, csrWithSan, ecCsrWithSan, firstPem, GeneratedCsr, parseCertificate, pemBlocks, publicKeyPemOf, sameSans,
    ecRefusalWording, sha256Fingerprint, sha256FingerprintOfPem,
} from '../../utils/regression/pki';
import {
    apiJson, authorityConnectorName, ensureAcmeOnRaProfile, getCertificate, orSkipWithoutCa, recordAcmeAccount,
    recordingIssued, sanOracleFor, searchCertificates, serverCreatedAfter,
} from '../../utils/regression/regressionApi';
import { GuardedApi } from '../../utils/regression/guardedApi';
import { createdAfterFrom, OwnRef, regName } from '../../utils/regression/regressionRun';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-USE-05';
const skip = (reason: string) => test.skip(true, reason);

test.describe('@regression REG-USE-05 issue via ACME', () => {
    test('pre-authorized order is issued through the RA profile ACME directory', async ({ page, api, env }) => {
        const { raProfile, acmeProfile, directoryUrl } = await test.step('Prerequisite: ACME profile activated on an own RA profile of the run', async () =>
            orSkipWithoutCa(ensureAcmeOnRaProfile(api, SPEC), skip),
        );
        const identifier = acmeProfile.identifier;
        const client = new AcmeClient(directoryUrl);

        await test.step('Directory lists the RFC 8555 resources', async () => {
            const dir = await client.init();
            for (const k of ['newNonce', 'newAccount', 'newOrder', 'revokeCert']) expect(dir[k], k).toBeTruthy();
        });

        const accountUrl = await test.step('New account → valid', async () => {
            const res = await client.newAccount(`${regName('acme')}@example.test`);
            expect(res.location).toBeTruthy();
            // Recorded before the assertion on its state (ledger before assertion).
            await recordAcmeAccount(api, res.location!, acmeProfile, SPEC);
            expect(res.body.status).toBe('valid');
            return res.location!;
        });

        const order = await test.step(`New order for the pre-authorized ${identifier} → ready, no challenge needed`, async () => {
            const res = await client.newOrder([identifier]);
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            expect(res.body.status).toBe('ready');
            const authz = await client.get(res.body.authorizations[0]);
            expect(authz.body.status).toBe('valid');
            return { url: res.location!, body: res.body, date: res.date };
        });

        const csr = csrWithSan(identifier, [identifier]);
        const pem = await test.step('Finalize → valid → download the certificate', async () => {
            const createdAfter = order.date ? createdAfterFrom(order.date) : await serverCreatedAfter(api);
            // Ledger first, also when the finalize throws after the server issued or the wait times out (Fable F2).
            const { result: done } = await recordingIssued(api, identifier, createdAfter, SPEC, 'issued via ACME', async () => {
                const fin = await client.finalize(order.body.finalize, csr.derBase64Url);
                expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
                return client.waitForOrder(order.url);
            });
            expect(done.status, JSON.stringify(done)).toBe('valid');
            return firstPem(await client.downloadCertificate(done.certificate));
        });

        const cert = parseCertificate(pem);
        await test.step('Issued certificate carries the CSR key and the identifier', async () => {
            expect(publicKeyPemOf(cert)).toBe(csr.publicKeyPem);
            expect(cert.subject.getField('CN')?.value).toBe(identifier);
        });

        const certUuid = await test.step('Inventory: found by fingerprint, RA profile = the run RA profile, protocol ACME', async () => {
            const found = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: sha256Fingerprint(cert) }]);
            expect(found.length).toBe(1);
            const detail = await getCertificate(api, found[0].uuid);
            expect(detail.raProfile?.uuid).toBe(raProfile.uuid);
            expect(String(detail.protocolInfo?.protocol ?? '')).toMatch(/acme/i);
            expect(detail.protocolInfo?.protocolProfileUuid).toBe(acmeProfile.uuid);
            return found[0].uuid as string;
        });

        await test.step('ACME account is listed for the run ACME profile', async () => {
            const accounts = await apiJson<Array<Record<string, any>>>(api, 'GET', '/api/v1/acmeAccounts');
            const accountId = accountUrl.split('/').pop();
            expect(accounts.some((a) => String(a.accountId) === accountId && a.acmeProfileUuid === acmeProfile.uuid), `account of ${acmeProfile.name}`).toBe(true);
        });

        await test.step('UI: ACME accounts list shows the account (searched by its account id: the list pages by 10, sorted by ACME profile name)', async () => {
            await loginAsSmokeUser(page, env);
            const accounts = new AcmeAccountPage(page);
            await accounts.goToList();
            await accounts.assertListed(accountUrl.split('/').pop() ?? '', acmeProfile.name);
        });

        await test.step('UI: the certificate detail opens', async () => {
            await page.goto(`administrator/#/certificates/detail/${certUuid}`);
            await expect(page.locator('main')).toContainText(identifier);
        });

        await test.step('Negative: a name that is not pre-authorized gets http-01 / dns-01 challenges only', async () => {
            const other = `other-${identifier}`;
            const res = await client.newOrder([other]);
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            expect(res.body.status).toBe('pending');
            const authz = await client.get(res.body.authorizations[0]);
            const types = (authz.body.challenges ?? []).map((c: { type: string }) => c.type).sort();
            expect(types.length).toBeGreaterThan(0);
            for (const t of types) expect(['dns-01', 'http-01']).toContain(t);
        });
    });

    // ------------------------------------------------------------------ B1: REG-USE-05.1 / 05.2

    interface AcmeRun {
        client: AcmeClient;
        acmeProfile: OwnRef & { identifier: string };
        /** The run ACME profile as the API reads it (`retryInterval`, `validity` in seconds). */
        profile: { retryInterval?: number; validity?: number };
        /** The new-account answer of the shared account (its Retry-After is part of 05.1's oracle). */
        account: AcmeResponse;
        /** The SAN oracle of the CA behind the run RA profile (exact on EJBCA-NG, DNS values elsewhere). */
        sanMode: 'exact' | 'dns';
        connector: string;
    }
    let shared: AcmeRun | undefined;

    /** The ACME profile on an own RA profile, its settings, and ONE account shared by the B1 tests of this file. */
    async function acmeRun(api: GuardedApi): Promise<AcmeRun> {
        if (shared) return shared;
        const { raProfile, acmeProfile, directoryUrl } = await orSkipWithoutCa(ensureAcmeOnRaProfile(api, SPEC), skip);
        const profile = await apiJson<{ retryInterval?: number; validity?: number }>(api, 'GET', `/api/v1/acmeProfiles/${acmeProfile.uuid}`);
        const connector = await authorityConnectorName(api, raProfile.authorityUuid);
        const client = new AcmeClient(directoryUrl);
        await client.init();
        const account = await client.newAccount(`${regName('acme-b1')}@example.test`);
        expect(account.location, 'new-account answers the account URL').toBeTruthy();
        await recordAcmeAccount(api, account.location!, acmeProfile, SPEC);
        shared = { client, acmeProfile, profile, account, sanMode: sanOracleFor(connector), connector };
        return shared;
    }

    /** The inventory certificates of a common name (read-only). */
    async function certificatesNamed(api: GuardedApi, commonName: string): Promise<string[]> {
        const rows = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: commonName }], 100);
        return rows.map((r) => String(r.uuid));
    }

    /**
     * Order → finalize → settle. Ledger first (Sonnet F4): every certificate of the identifier and its linked key (derived,
     * `createdAfter` from the new-order response's Date). `mine` are the certificates THIS order made (not in the inventory
     * before the order).
     */
    async function orderAndFinalize(api: GuardedApi, run: AcmeRun, csr: GeneratedCsr) {
        const identifier = run.acmeProfile.identifier;
        const before = new Set(await certificatesNamed(api, identifier));
        const order = await run.client.newOrder([identifier]);
        expect(order.status, JSON.stringify(order.body)).toBe(201);
        const createdAfter = order.date ? createdAfterFrom(order.date) : await serverCreatedAfter(api);
        // The finalize and the wait run inside the recording (Fable F2): a finalize that throws after the server issued, or a
        // wait that times out, still leaves the certificate and its key in the ledger before the error surfaces.
        const { result: { fin, done }, uuids } = await recordingIssued(api, identifier, createdAfter, SPEC, 'issued via ACME (REG-USE-05.1 / 05.2)', async () => {
            const f = await run.client.finalize(order.body.finalize, csr.derBase64Url);
            const d = f.status < 300 ? await run.client.waitForOrder(order.location!) : undefined;
            return { fin: f, done: d };
        });
        return { order, fin, done, uuids, mine: uuids.filter((u) => !before.has(u)) };
    }

    /**
     * Why THIS order's issuance was refused, in CA-policy words about the key (Sonnet F9): the finalize problem's detail,
     * the order's own `error` and the history of the certificates this order made — never the history of the name.
     */
    async function ecRefusal(api: GuardedApi, fin: AcmeResponse, done: Record<string, any> | undefined, mine: string[]): Promise<string | undefined> {
        const parts: string[] = [];
        if (fin.status >= 300) parts.push(String(fin.body?.detail ?? ''));
        if (done?.error) parts.push(String(done.error.detail ?? ''));
        for (const u of mine) {
            const h = await apiJson<Array<{ message?: string }>>(api, 'GET', `/api/v1/certificates/${u}/history`);
            parts.push(...h.map((x) => String(x.message ?? '')));
        }
        return parts.find((t) => ecRefusalWording(t));
    }

    for (const keyType of ['rsa-2048', 'ec-p256'] as const) {
        test(`REG-USE-05.1[${keyType}]: the order expires per the profile validity, Retry-After is the retry interval, the download is a leaf-first chain with the ordered SAN and the CSR key`,
            meta({
                id: 'REG-USE-05.1', prio: 'P1', issue: 'ilm#430',
                rule: [
                    'protocols §4.2 rule 18 (order expires = now + profile validity; core#2516 when NULL), rule 28 (Retry-After = retry interval on new-account, new-order, finalize)',
                    'protocols §4.2 rule 27 (download: application/pem-certificate-chain, the chain from getCertificateChain) and RFC 8555 §7.4.2 (leaf first, each next certifies the previous)',
                    'protocols §4.2 rules 17, 25, 26 (pre-authorized → ready; CSR names the ordered identifier; valid when ISSUED); RFC 5280 §6 (chain signatures)',
                    'cert-lifecycle §2.2 API-12 (the CA decides the SAN extension: exact set on EJBCA-NG, DNS values elsewhere)',
                ],
            }),
            async ({ api }, testInfo) => {
                // One order: finalize, settle (180 s order wait of the client), download.
                test.setTimeout(300_000);
                const run = await test.step('Prerequisite: ACME on an own RA profile, the profile settings, the shared account', async () => acmeRun(api));
                const identifier = run.acmeProfile.identifier;
                const retry = run.profile.retryInterval;
                const validity = run.profile.validity;
                testInfo.annotations.push({ type: 'san-oracle', description: run.sanMode === 'exact' ? `exact SAN set on ${run.connector}` : `DNS values only on ${run.connector}` });

                await test.step('Precondition: the profile has an explicit retry interval and order validity', async () => {
                    expect(retry, 'retryInterval of the run ACME profile').toBeGreaterThan(0);
                    expect(validity, 'validity of the run ACME profile (none → 36 s orders, core#2516)').toBeGreaterThan(0);
                });

                await test.step('new-account answered Retry-After = the retry interval', async () => {
                    expect(run.account.retryAfter, 'Retry-After on new-account').toBe(String(retry));
                });

                const csr = keyType === 'rsa-2048' ? csrWithSan(identifier, [identifier]) : await ecCsrWithSan(identifier, [identifier]);
                const { order, fin, done, uuids, mine } = await test.step(`new-order for ${identifier} → finalize with a ${keyType} CSR → settled`, async () =>
                    orderAndFinalize(api, run, csr));

                await test.step('new-order: 201, ready, Retry-After, expires = server now + validity (± 300 s)', async () => {
                    expect(order.body.status).toBe('ready');
                    expect(order.retryAfter, 'Retry-After on new-order').toBe(String(retry));
                    const serverNow = order.date?.getTime();
                    if (!serverNow) testInfo.annotations.push({ type: 'clock', description: 'no Date header on new-order: the runner clock is used' });
                    const expiresIn = (Date.parse(order.body.expires) - (serverNow ?? Date.now())) / 1000;
                    expect(Math.abs(expiresIn - validity!), `order expires in ${Math.round(expiresIn)} s, profile validity ${validity} s`).toBeLessThanOrEqual(300);
                });

                if (keyType === 'ec-p256' && (fin.status >= 300 || done?.status === 'invalid')) {
                    // The RA profile's CA may refuse EC keys (a CA policy, ledger row: "EC skipped when the RA profile refuses EC").
                    const refusal = await ecRefusal(api, fin, done, mine);
                    test.skip(!!refusal, `the RA profile refuses EC P-256 keys: ${String(refusal).slice(0, 300)}`);
                }

                await test.step('finalize: accepted with Retry-After; the order is valid', async () => {
                    expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
                    expect(fin.retryAfter, 'Retry-After on finalize').toBe(String(retry));
                    expect(done?.status, JSON.stringify(done)).toBe('valid');
                });

                const chain = await test.step('download: 200, application/pem-certificate-chain', async () => {
                    const dl = await run.client.downloadCertificateResponse(done!.certificate);
                    expect(dl.status).toBe(200);
                    expect(dl.contentType ?? '').toMatch(/^application\/pem-certificate-chain\b/);
                    return dl.body;
                });
                const blocks = pemBlocks(chain);

                const leafUuid = await test.step('inventory: the leaf is the certificate this order made', async () => {
                    expect(blocks.length).toBeGreaterThan(0);
                    const found = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: sha256FingerprintOfPem(blocks[0]) }]);
                    expect(found.length).toBe(1);
                    expect(mine).toContain(found[0].uuid);
                    expect(uuids).toContain(found[0].uuid);
                    return String(found[0].uuid);
                });

                await test.step('chain: the leaf first, each block signed by the next (two blocks at least when the issuing CA is in the inventory)', async () => {
                    const issuerInInventory = !!(await getCertificate(api, leafUuid)).issuerCertificateUuid;
                    if (issuerInInventory) expect(blocks.length, 'the issuing CA certificate is in the inventory, so the chain carries it').toBeGreaterThanOrEqual(2);
                    else if (blocks.length < 2) testInfo.annotations.push({ type: 'chain-check', description: 'partial: one block and the issuing CA certificate is not in the inventory (nothing to verify the leaf against)' });
                    expect(await chainProblems(blocks)).toEqual([]);
                });

                await test.step('leaf: SAN = the ordered identifier (CA-aware), public key = the CSR key', async () => {
                    const leaf = certificateInfo(blocks[0]);
                    if (run.sanMode === 'exact') expect(sameSans(leaf.sans, { dns: [identifier], ip: [] }), `leaf SANs ${JSON.stringify(leaf.sans)}`).toBe(true);
                    else expect(leaf.sans.dns.map((d) => d.toLowerCase()), `leaf SANs ${JSON.stringify(leaf.sans)}`).toContain(identifier.toLowerCase());
                    expect(leaf.spkiBase64, 'leaf public key = CSR key').toBe(csr.spkiBase64);
                });
            });
    }

    test('REG-USE-05.2: a second finalize of a valid order answers 403 problem+json orderNotReady and the order stays valid',
        meta({
            id: 'REG-USE-05.2', prio: 'P1', issue: 'ilm#430',
            rule: ['protocols §4.2 rule 25 / R5b: finalize requires order `ready`, else 403 `orderNotReady` (also a second finalize); §4.3 order state model'],
        }),
        async ({ api }) => {
            // One order to valid (client order wait 180 s) and two short reads.
            test.setTimeout(300_000);
            const run = await test.step('Prerequisite: ACME on an own RA profile and the shared account', async () => acmeRun(api));
            const csr = csrWithSan(run.acmeProfile.identifier, [run.acmeProfile.identifier]);
            const { order, fin, done } = await test.step('An order finalized to valid', async () => orderAndFinalize(api, run, csr));

            await test.step('The first finalize settled the order as valid', async () => {
                expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
                expect(done?.status, JSON.stringify(done)).toBe('valid');
            });

            await test.step('Second finalize on the same order → 403 problem+json …:orderNotReady', async () => {
                const second = await run.client.finalize(order.body.finalize, csr.derBase64Url);
                expect(second.status, JSON.stringify(second.body)).toBe(403);
                expect(second.contentType ?? '').toMatch(/^application\/problem\+json\b/);
                expect(String(second.body?.type ?? '')).toMatch(/:orderNotReady$/);
            });

            await test.step('The order is still valid', async () => {
                const after = await run.client.get(order.location!);
                expect(after.body.status).toBe('valid');
            });
        });
});
