/**
 * ownKeys — the keys a test makes on the run's token chain, deleted after the test (software-cryptography-provider#137: key cap per token).
 */
import { test as base } from '../regressionFixtures';
import type { OwnRef } from '../../utils/regression/ledger/ledger';
import type { RecordOptions } from '../../utils/regression/ownObjects';
import { ensureKeyChain, isSkip, type ChainOptions } from '../../utils/regression/platform/keyChain';
import { readRunState, updateRunState } from '../../utils/regression/ledger/runState';
import { createOwnKey, deleteEachKey, deleteOwnKey, isDestroyedKey, type KeyChain, type KeyOptions } from '../../utils/regression/platform/keys';
import { createOwnToken, createOwnTokenProfile, enableOwnTokenProfile, findCryptoConnector, type CryptoConnector } from '../../utils/regression/platform/tokens';

export { expect } from '../regressionFixtures';

/** What `ownKeys.record` reads of a key create answer. */
export interface KeyCreateAnswer {
    status: number;
    uuid?: unknown;
    text: string;
}

export type OwnKeyMade = Awaited<ReturnType<typeof createOwnKey>>;

export interface OwnKeys {
    chain(options?: ChainOptions): Promise<KeyChain>;
    /** An own SOFT token and enabled profile on the v1 connector, made for this test; the run-end teardown removes them. */
    v1Chain(suffix: string): Promise<Pick<KeyChain, 'token' | 'tokenProfile'>>;
    connector(version: 1 | 2): Promise<CryptoConnector>;
    make(suffix: string, options: KeyOptions & { chain: Pick<KeyChain, 'token' | 'tokenProfile'> }): Promise<OwnKeyMade>;
    record(answer: KeyCreateAnswer, details: { name: string; note: string; parents: RecordOptions['parents']; track?: boolean }): OwnRef | undefined;
    track<T extends OwnRef>(...keys: T[]): void;
    remove(key: OwnRef): Promise<void>;
    runToken(): OwnRef | undefined;
    shareAsRunChain(chain: Pick<KeyChain, 'token' | 'tokenProfile' | 'key'>): void;
}

export const test = base.extend<{ ownKeys: OwnKeys }>({
    ownKeys: async ({ api, own }, use, testInfo) => {
        const tracked: OwnRef[] = [];
        const skipWith = (reason: string): never => {
            testInfo.skip(true, reason);
            throw new Error(reason);
        };
        const keys: OwnKeys = {
            v1Chain: async (suffix) => {
                const token = await createOwnToken(api, own.spec, `tok${suffix}`, { connector: await keys.connector(1), kind: 'SOFT' });
                const tokenProfile = await createOwnTokenProfile(api, own.spec, `tp${suffix}`, { token });
                await enableOwnTokenProfile(api, token, tokenProfile);
                return { token, tokenProfile };
            },
            chain: async (options) => {
                const chain = await ensureKeyChain(api, own.spec, options);
                return isSkip(chain) ? skipWith(chain.skip) : chain;
            },
            connector: async (version) => {
                const connector = await findCryptoConnector(api, version);
                return connector ?? skipWith(`no connected software cryptography connector of interface v${version} is registered on this tier (REG_CRYPTO_CONNECTOR_V${version})`);
            },
            make: async (suffix, options) => {
                const key = await createOwnKey(api, own.spec, suffix, options);
                keys.track(key);
                return key;
            },
            record: (answer, details) => {
                const ref = own.probe('keys', { status: answer.status, json: { uuid: answer.uuid }, text: answer.text }, details);
                if (ref && details.track) keys.track(ref);
                return ref;
            },
            track: (...made) => {
                // A key already tracked (an import that answers the key it already holds) is deleted once.
                for (const key of made) if (!tracked.some((t) => t.uuid === key.uuid)) tracked.push(key);
            },
            remove: async (key) => {
                await deleteOwnKey(api, key, own.spec);
                const at = tracked.findIndex((t) => t.uuid === key.uuid);
                if (at >= 0) tracked.splice(at, 1);
            },
            runToken: () => readRunState().token,
            shareAsRunChain: (chain) => {
                if (!readRunState().token) updateRunState({ token: chain.token, tokenProfile: chain.tokenProfile, key: chain.key });
            },
        };
        try {
            await use(keys);
        } finally {
            await deleteEachKey(tracked.splice(0), {
                remove: (key) => deleteOwnKey(api, key, own.spec),
                isDestroyed: (key) => isDestroyedKey(api, key),
                warn: (description) => testInfo.annotations.push({ type: 'warning', description }),
            });
        }
    },
});
