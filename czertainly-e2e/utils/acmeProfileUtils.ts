/**
 * acmeProfileUtils — wrapper around the platform's ACME Profile endpoints, for SMK-005.
 *
 * WHAT: creates an ACME Profile bound to an RA Profile, enables it, activates ACME on that RA
 * Profile, and undoes all three in reverse.
 *
 * WHY: an ACME client (cert-manager, in SMK-005) needs a directory URL to talk to, and the
 * platform only serves one for an enabled ACME Profile that has an RA Profile to issue through.
 *
 * HOW: four REST calls on the way in — create (POST /v1/acmeProfiles, with raProfileUuid as the
 * profile's default RA Profile), enable, activate ACME on the RA Profile, then GET the profile to
 * read `directoryUrl`, which the platform builds itself so we never guess its shape. On the way
 * out: deactivate on the RA Profile, disable, delete — an enabled profile refuses to be deleted.
 * Deletes tolerate 404 so a cleanup that runs twice does not fail the second time.
 */

import { APIRequestContext } from '@playwright/test';
import { Logger } from './Logger';

const logger = new Logger('AcmeProfileUtils');

export interface AcmeProfileDto {
    uuid: string;
    name: string;
    /** e.g. https://<host>/api/v1/protocols/acme/<name>/directory — as the platform reports it. */
    directoryUrl: string;
}

export interface CreateAcmeProfileOptions {
    name: string;
    authorityUuid: string;
    raProfileUuid: string;
    /**
     * Where the platform resolves the names it validates. Left unset, it uses the resolver of its
     * own pod, which is what the in-cluster HTTP-01 solver needs.
     */
    dnsResolverIp?: string;
    dnsResolverPort?: string;
}

async function ensureOk(resp: { ok(): boolean; status(): number; text(): Promise<string> }, what: string, allow: number[] = []) {
    if (resp.ok() || allow.includes(resp.status())) return;
    throw new Error(`${what} failed: ${resp.status()} - ${await resp.text()}`);
}

export async function createAcmeProfile(
    request: APIRequestContext,
    options: CreateAcmeProfileOptions,
): Promise<AcmeProfileDto> {
    logger.info(`Creating ACME Profile: ${options.name}`);

    const createResp = await request.post('/api/v1/acmeProfiles', {
        data: {
            name: options.name,
            description: 'SMK-005 smoke — created and removed by the run',
            raProfileUuid: options.raProfileUuid,
            dnsResolverIp: options.dnsResolverIp,
            dnsResolverPort: options.dnsResolverPort,
            retryInterval: 30,
            validity: 30,
            requireContact: false,
            requireTermsOfService: false,
            issueCertificateAttributes: [],
            revokeCertificateAttributes: [],
            customAttributes: [],
        },
    });
    await ensureOk(createResp, 'Create ACME Profile');
    const { uuid } = await createResp.json() as { uuid: string };

    await ensureOk(await request.patch(`/api/v1/acmeProfiles/${uuid}/enable`), `Enable ACME Profile ${uuid}`);

    const activateUrl =
        `/api/v1/authorities/${options.authorityUuid}/raProfiles/${options.raProfileUuid}/protocols/acme/activate/${uuid}`;
    await ensureOk(
        await request.patch(activateUrl, { data: { issueCertificateAttributes: [], revokeCertificateAttributes: [] } }),
        `Activate ACME on RA Profile ${options.raProfileUuid}`,
    );

    const getResp = await request.get(`/api/v1/acmeProfiles/${uuid}`);
    await ensureOk(getResp, `Get ACME Profile ${uuid}`);
    const { directoryUrl } = await getResp.json() as { directoryUrl?: string };
    if (!directoryUrl) {
        throw new Error(`ACME Profile ${uuid} is enabled but reports no directoryUrl`);
    }

    logger.info(`ACME Profile ready: ${options.name} (uuid: ${uuid}), directory ${directoryUrl}`);
    return { uuid, name: options.name, directoryUrl };
}

export async function deleteAcmeProfile(
    request: APIRequestContext,
    options: { uuid: string; authorityUuid: string; raProfileUuid: string },
): Promise<void> {
    logger.info(`Deleting ACME Profile: ${options.uuid}`);

    // 404: the RA Profile is already gone, and with it the activation.
    const deactivateUrl =
        `/api/v1/authorities/${options.authorityUuid}/raProfiles/${options.raProfileUuid}/protocols/acme/deactivate`;
    await ensureOk(await request.patch(deactivateUrl), `Deactivate ACME on RA Profile ${options.raProfileUuid}`, [404]);

    await ensureOk(await request.patch(`/api/v1/acmeProfiles/${options.uuid}/disable`), `Disable ACME Profile ${options.uuid}`, [404]);
    await ensureOk(await request.delete(`/api/v1/acmeProfiles/${options.uuid}`), `Delete ACME Profile ${options.uuid}`, [404]);
}
