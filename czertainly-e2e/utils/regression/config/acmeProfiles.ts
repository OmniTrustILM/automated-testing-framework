/**
 * config/acmeProfiles — the run's OWN ACME profile: created with one exact, pre-authorized DNS identifier (orders for it
 * need no challenge), enabled, and activated on an own RA profile only. `ensureAcmeProfile` reuses the run's profile from
 * the run state, else creates and records it.
 */
import { apiJson } from '../apiReads';
import { requiredCustomAttributes } from '../customAttributes';
import type { GuardedApi } from '../guard/types';
import { assertOwnLive } from '../ledger/ownership';
import { OwnRef, recordCreated, Ref } from '../ledger/ledger';
import { readRunState, runName, runId, updateRunState } from '../ledger/runState';

/** ACME profile with one exact, pre-authorized DNS identifier: orders for it need no challenge. */
export async function createAcmeProfile(api: GuardedApi, name: string, identifier: string): Promise<Ref> {
    const created = await apiJson<{ uuid: string }>(api, 'POST', '/api/v1/acmeProfiles', {
        name,
        description: `REG run ${runId()}`,
        retryInterval: 30,
        validity: 36000,
        requireContact: false,
        requireTermsOfService: false,
        issueCertificateAttributes: [],
        revokeCertificateAttributes: [],
        customAttributes: await requiredCustomAttributes(api, 'acmeProfiles', runName('ca')),
        preauthorizedIdentifiers: [{ type: 'dns', value: identifier, matchType: 'exact', allowWildcard: false }],
        identifierAuthorizationMode: 'preauthorizedOrChallenge',
    });
    return { uuid: created.uuid, name };
}

export async function enableOwnAcmeProfile(api: GuardedApi, acmeProfile: OwnRef): Promise<void> {
    await assertOwnLive(api, 'acmeProfiles', acmeProfile, 'enableOwnAcmeProfile');
    await apiJson(api, 'PATCH', `/api/v1/acmeProfiles/${acmeProfile.uuid}/enable`);
}

export async function activateAcmeOnOwnRaProfile(api: GuardedApi, authorityUuid: string, raProfile: OwnRef, acmeProfile: OwnRef): Promise<void> {
    // Never on an issue-only parent (REG_RA_PROFILE_NAME) or any other RA profile the run did not create.
    await assertOwnLive(api, 'raProfiles', raProfile, 'activateAcmeOnOwnRaProfile (RA profile)');
    await assertOwnLive(api, 'acmeProfiles', acmeProfile, 'activateAcmeOnOwnRaProfile (ACME profile)');
    await apiJson(api, 'PATCH', `/api/v1/authorities/${authorityUuid}/raProfiles/${raProfile.uuid}/protocols/acme/activate/${acmeProfile.uuid}`, {
        issueCertificateAttributes: [],
        revokeCertificateAttributes: [],
    });
}

/** The run's ACME profile (created + enabled through the API when the run has none). */
export async function ensureAcmeProfile(api: GuardedApi, spec: string): Promise<OwnRef & { identifier: string }> {
    const state = readRunState();
    if (state.acmeProfile) return state.acmeProfile;
    const identifier = `${runId()}.example.test`;
    const ref = recordCreated('acmeProfiles', await createAcmeProfile(api, runName('acme'), identifier), spec, `API prerequisite; pre-authorized ${identifier}`);
    await enableOwnAcmeProfile(api, ref);
    const acme = { ...ref, identifier };
    updateRunState({ acmeProfile: acme });
    return acme;
}
