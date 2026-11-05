/**
 * acmeProfiles — the run's own ACME profile: enabled, one exact pre-authorized DNS identifier, activated on an own RA profile only;
 * `ensureAcmeProfile` reuses the run state's profile, else creates and records it before any assertion.
 */
import { apiJson } from '../apiReads';
import { requiredCustomAttributes } from '../customAttributes';
import type { GuardedApi } from '../guard/types';
import { assertOwnLive } from '../ledger/ownership';
import type { OwnRef } from '../ledger/ledger';
import { createOwn } from '../ownCrud';
import { ownName, readRunState, runName, runId, updateRunState } from '../ledger/runState';

/**
 * The platform's documented ACME profile defaults; `validity` is how long an order stays open, not a certificate's lifetime (set short, the
 * order expires before finalize).
 */
const ACME_PROFILE_DEFAULTS = {
    retryInterval: 30,
    validity: 36000,
    requireContact: false,
    requireTermsOfService: false,
    issueCertificateAttributes: [],
    revokeCertificateAttributes: [],
} as const;

export interface AcmeProfileOptions {
    identifier: string;
    name?: string;
    note?: string;
}

/** An own, disabled ACME profile with one pre-authorized DNS identifier; recorded before any assertion. */
async function createOwnAcmeProfile(api: GuardedApi, spec: string, suffix: string, o: AcmeProfileOptions): Promise<OwnRef> {
    const { answer: _answer, ...ref } = await createOwn(api, spec, {
        type: 'acmeProfiles',
        path: '/api/v1/acmeProfiles',
        name: o.name ?? ownName(suffix),
        note: o.note ?? `API prerequisite; pre-authorized ${o.identifier}`,
        body: {
            description: `REG run ${runId()}`,
            ...ACME_PROFILE_DEFAULTS,
            customAttributes: await requiredCustomAttributes(api, 'acmeProfiles', runName('ca')),
            preauthorizedIdentifiers: [{ type: 'dns', value: o.identifier, matchType: 'exact', allowWildcard: false }],
            identifierAuthorizationMode: 'preauthorizedOrChallenge',
        },
    });
    return ref;
}

async function enableOwnAcmeProfile(api: GuardedApi, acmeProfile: OwnRef): Promise<void> {
    await assertOwnLive(api, 'acmeProfiles', acmeProfile, 'enableOwnAcmeProfile');
    await apiJson(api, 'PATCH', `/api/v1/acmeProfiles/${acmeProfile.uuid}/enable`);
}

export async function activateAcmeOnOwnRaProfile(api: GuardedApi, authorityUuid: string, raProfile: OwnRef, acmeProfile: OwnRef): Promise<void> {
    // Never on an issue-only parent or any RA profile the run did not create.
    await assertOwnLive(api, 'raProfiles', raProfile, 'activateAcmeOnOwnRaProfile (RA profile)');
    await assertOwnLive(api, 'acmeProfiles', acmeProfile, 'activateAcmeOnOwnRaProfile (ACME profile)');
    await apiJson(api, 'PATCH', `/api/v1/authorities/${authorityUuid}/raProfiles/${raProfile.uuid}/protocols/acme/activate/${acmeProfile.uuid}`, {
        issueCertificateAttributes: [],
        revokeCertificateAttributes: [],
    });
}

export async function ensureAcmeProfile(api: GuardedApi, spec: string): Promise<OwnRef & { identifier: string }> {
    const state = readRunState();
    if (state.acmeProfile) return state.acmeProfile;
    const identifier = `${runId()}.example.test`;
    const ref = await createOwnAcmeProfile(api, spec, 'acme', { identifier, name: runName('acme') });
    await enableOwnAcmeProfile(api, ref);
    const acme = { ...ref, identifier };
    updateRunState({ acmeProfile: acme });
    return acme;
}
