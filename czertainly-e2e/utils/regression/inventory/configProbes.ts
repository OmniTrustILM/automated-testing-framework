/**
 * configProbes — shared steps of the credential, group and RA-profile API specs: refusal shapes of the error contract, the credential
 * connector or a named skip, a valid Basic body and `deleteOwnAndProveGone`.
 */
import { expect, test } from '../../../fixtures/testFixtures';
import { expect422Messages, expectMessageObject } from '../errorContract';
import type { GuardedApi } from '../guard/types';
import { OwnRef } from '../ledger/ledger';
import { runName, ownName } from '../ledger/runState';
import { requiredCustomAttributes } from '../customAttributes';
import { basicAttributes, credentialBody, credentialSetup, randomSecret, readObject } from './credentialsApi';
import type { BasicValues, CredentialConnector } from './credentialsApi';
import { ApiAnswer } from '../apiReads';
import { deleteOwn } from '../ownCrud';
import { JsonObject } from '../json';

export function refused422(p: ApiAnswer): string[] {
    expect(p.status, p.text.slice(0, 300)).toBe(422);
    expect(p.contentType, 'a 422 is application/json').toMatch(/application\/json/);
    return expect422Messages(p.text);
}

export function refusedWith(p: ApiAnswer, status: number): string {
    expect(p.status, p.text.slice(0, 300)).toBe(status);
    expect(p.contentType, `a ${status} is application/json`).toMatch(/application\/json/);
    return expectMessageObject(p.text);
}

export async function credentialConnectorOrSkip(api: GuardedApi): Promise<CredentialConnector> {
    const setup = await credentialSetup(api);
    test.skip(!setup.ok, setup.skip ?? 'no credential connector');
    return setup.ok!;
}

export async function basicBody(api: GuardedApi, c: CredentialConnector, name: unknown, over: JsonObject = {}, values?: BasicValues, opts?: { withUuid?: boolean }): Promise<JsonObject> {
    const given = values ?? { username: ownName('cu'), password: randomSecret() };
    return credentialBody(c, name, basicAttributes(c, given, opts), await requiredCustomAttributes(api, 'credentials', runName('ca')), over);
}

/** DELETE own, expect 204 and an empty body, read back the 404; the `deleted` line is written after the read-back. */
export async function deleteOwnAndProveGone(api: GuardedApi, kind: 'credentials' | 'groups', ref: OwnRef, type: string, spec: string): Promise<void> {
    const del = await deleteOwn(api, kind, ref, spec, { note: 'delete under test: 204, then 404 on read-back', readBack: () => expectGoneWith404(api, kind, ref.uuid, type) });
    expect(del.status, del.text.slice(0, 300)).toBe(204);
    expect(del.text, 'a 204 has no body').toBe('');
}

export async function expectGoneWith404(api: GuardedApi, kind: 'credentials' | 'groups', uuid: string, type: string): Promise<void> {
    const gone = await readObject(api, kind, uuid);
    expect(refusedWith(gone, 404)).toBe(`Object of type '${type}' identified by ${uuid} is not found.`);
}
