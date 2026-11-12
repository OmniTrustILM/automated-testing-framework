/**
 * acmeProfiles — the run's own ACME profile.
 *
 * WHAT: the run's OWN ACME profile: created with one exact, pre-authorized DNS identifier (orders for it
 *       need no challenge), enabled, and activated on an own RA profile only. `ensureAcmeProfile` reuses the run's profile from
 *       the run state, else creates and records it.
 * WHY: Protocol specs need an ACME profile they may change, and a shared tier must never see one of its existing profiles touched.
 * HOW: `createOwnAcmeProfile` records the create before any assertion, `ensureAcmeProfile` reuses the run's profile from the run state, and
 * activation passes the live own-object check on both objects.
 */
import { apiJson } from '../apiReads';
import { requiredCustomAttributes } from '../customAttributes';
import type { GuardedApi } from '../guard/types';
import { assertOwnLive } from '../ledger/ownership';
import type { OwnRef } from '../ledger/ledger';
import { createOwn } from '../ownCrud';
import { ownName, readRunState, runName, runId, updateRunState } from '../ledger/runState';

/**
 * The platform's documented defaults of an ACME profile, the one home of this rule. `validity` is how long an order stays
 * open, not how long a certificate lasts: set short, the order expires between challenge and finalize.
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
    /** The one exact DNS identifier orders may use without a challenge. */
    identifier: string;
    /** A planned name (the run's canonical profile); default `ownName(suffix)`. */
    name?: string;
    note?: string;
}

/**
 * An own ACME profile with one exact, pre-authorized DNS identifier: orders for it need no challenge. Created disabled; recorded before any
 * assertion.
 */
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
    const ref = await createOwnAcmeProfile(api, spec, 'acme', { identifier, name: runName('acme') });
    await enableOwnAcmeProfile(api, ref);
    const acme = { ...ref, identifier };
    updateRunState({ acmeProfile: acme });
    return acme;
}
