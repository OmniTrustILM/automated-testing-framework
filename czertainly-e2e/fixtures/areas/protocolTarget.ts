/**
 * protocolTarget — `test` plus the ACME, SCEP and CMP rigs of the REG-PROT specs, each on a dedicated own RA profile.
 * The rigs are test-scoped, cached per worker and recorded in the ledger; a tier without a CA or a crypto provider skips with the reason.
 */
import { test as base, ledgerSpecOf } from '../regressionFixtures';
import type { OwnRef } from '../../utils/regression/ledger/ledger';
import { ensureProtocolCaCertificate, orSkipWithoutProtocolCa, ProtocolCa } from '../../utils/regression/protocols/protocolCa';
import {
    createOwnCmpProfile, createOwnScepProfile, enableOwnCmpProfile, enableOwnScepProfile, ensureCmpActiveOnOwnRaProfile, ensureScepActiveOnOwnRaProfile,
    originOfUrl, pathOfUrl, randomSecret,
} from '../../utils/regression/protocols/protocolProfiles';
import { ensureAcmeOnRaProfile, ensureProtocolRaProfile, orSkipWithoutCa, OwnRaProfile } from '../../utils/regression/ownRaProfiles';
import { ISSUE_MS } from '../../utils/regression/timeouts';

export { expect } from '../regressionFixtures';

/** The ACME prerequisites: the own RA profile, the run's ACME profile and the directory URL. */
export interface AcmeRig {
    raProfile: OwnRaProfile;
    acmeProfile: OwnRef & { identifier: string };
    directoryUrl: string;
}

/** The SCEP prerequisites. */
export interface ScepRig {
    ca: ProtocolCa;
    raProfile: OwnRaProfile;
    scepProfile: OwnRef;
    password: string;
    /** The RA-profile SCEP URL the server reported (`…/protocols/scep/raProfile/<ra>/pkiclient.exe`). */
    url: string;
}

/** The CMP prerequisites. */
export interface CmpRig {
    raProfile: OwnRaProfile;
    cmpProfile: OwnRef;
    secret: string;
    /** `openssl cmp -server`: the origin of the RA-profile CMP URL the server reported. */
    server: string;
    /** `openssl cmp -path`: the path of that URL. */
    path: string;
}

/** What one worker already built. */
interface BuiltRigs {
    scep?: ScepRig;
    cmp?: CmpRig;
}

export interface ProtocolFixtures {
    acmeRig: AcmeRig;
    scepRig: ScepRig;
    cmpRig: CmpRig;
}

export interface ProtocolWorkerFixtures {
    builtRigs: BuiltRigs;
}

export const test = base.extend<ProtocolFixtures, ProtocolWorkerFixtures>({
    builtRigs: [async ({}, use) => use({}), { scope: 'worker' }],

    acmeRig: [async ({ api, declaredNeeds: _declared }, use, testInfo) => {
        await use(await orSkipWithoutCa(ensureAcmeOnRaProfile(api, ledgerSpecOf(testInfo)), (reason) => testInfo.skip(true, reason)));
    }, { timeout: ISSUE_MS }],

    scepRig: [async ({ api, builtRigs, needs, declaredNeeds: _declared }, use, testInfo) => {
        const spec = ledgerSpecOf(testInfo);
        const skip = (reason: string): void => testInfo.skip(true, reason);
        // Decided from reads before the rig writes anything, whenever the platform already reports a protocol URL to read.
        await needs.scepHttps();
        if (!builtRigs.scep) {
            const ca = await orSkipWithoutProtocolCa(orSkipWithoutCa(ensureProtocolCaCertificate(api, spec), skip), skip);
            const raProfile = await ensureProtocolRaProfile(api, spec, 'scep');
            const password = randomSecret();
            const scepProfile = await createOwnScepProfile(api, spec, 'scep', { caCertificateUuid: ca.certificate.uuid, challengePassword: password, note: 'SCEP profile with a challenge password' });
            await enableOwnScepProfile(api, scepProfile);
            const url = await ensureScepActiveOnOwnRaProfile(api, raProfile, scepProfile);
            builtRigs.scep = { ca, raProfile, scepProfile, password, url };
        }
        // Classic sscep speaks plain HTTP (no TLS client): the URL core reports, not BASE_URL, decides (a proxy may rewrite the scheme).
        // The `scep-https` need decides first when a protocol URL can be read before the rig writes; the SCEP URL itself is known only
        // after the activation, so this check stays as the last word (the rig's own objects exist by then: recorded, removed by the
        // teardown).
        if (/^https:/i.test(builtRigs.scep.url)) skip('the SCEP URL the server reports is https: classic sscep speaks plain HTTP only (needs an http endpoint or a TLS-capable sscep build)');
        await use(builtRigs.scep);
    }, { timeout: ISSUE_MS }],

    cmpRig: [async ({ api, builtRigs, declaredNeeds: _declared }, use, testInfo) => {
        if (!builtRigs.cmp) {
            const spec = ledgerSpecOf(testInfo);
            const raProfile = await orSkipWithoutCa(ensureProtocolRaProfile(api, spec, 'cmp'), (reason) => testInfo.skip(true, reason));
            const secret = randomSecret();
            const cmpProfile = await createOwnCmpProfile(api, spec, 'cmp', { variant: 'v2', requestProtectionMethod: 'sharedSecret', responseProtectionMethod: 'sharedSecret', sharedSecret: secret, note: 'CMP profile v2 / sharedSecret / sharedSecret' });
            await enableOwnCmpProfile(api, cmpProfile);
            const url = await ensureCmpActiveOnOwnRaProfile(api, raProfile, cmpProfile);
            builtRigs.cmp = { raProfile, cmpProfile, secret, server: originOfUrl(url), path: pathOfUrl(url) };
        }
        await use(builtRigs.cmp);
    }, { timeout: ISSUE_MS }],
});
