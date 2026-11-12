/**
 * ownKeys — the keys a test makes on the run's token chain, deleted after the test.
 *
 * WHAT: `test` is the spec-facing `test` plus one fixture, `ownKeys`, for the specs that make keys:
 *   - `ownKeys.chain(options?)`: the run's token, enabled token profile and key (`ensureKeyChain`); the test is skipped with the named
 *     reason when the tier has no software cryptography connector of the wanted interface version.
 *   - `ownKeys.connector(version)`: the software cryptography connector of that version, or the same named skip.
 *   - `ownKeys.make(suffix, { chain, family, … })`: an own key pair (`createOwnKey`, recorded from the answer), deleted after the test.
 *   - `ownKeys.record(answer, { name, note, parents })`: the ledger line of a key a probe made although a refusal was expected, written
 *     from the answer before any assertion; it returns the own reference, or undefined when the answer was not a success. The key is
 *     deleted after the test only with `track: true`.
 *   - `ownKeys.track(...keys)`: marks own keys (made or recorded in the test) for deletion after it; a key is deleted once.
 *   - `ownKeys.runToken()` / `ownKeys.shareAsRunChain(chain)`: the run's shared token if a spec made one already, and the way a spec that
 *     made its own token, profile and key hands them to the later specs as the run's chain when none exists yet.
 * WHY: the provider and core slow down and refuse past about fourteen keys on one token (software-cryptography-provider#137), so a spec
 *      that makes several keys removes them at the end of each test. The list of keys lives in the fixture, per test, not in a module
 *      variable that every test of a worker would share.
 * HOW: a test-scoped fixture built on `api` and `own`; its teardown, which also runs after a failed or timed-out test, deletes every
 *      tracked key with `deleteOwnKey` (own hard delete, a `deleted` ledger line, read-back of the 404).
 */
import { test as base } from '../regressionFixtures';
import type { OwnRef } from '../../utils/regression/ledger/ledger';
import type { RecordOptions } from '../../utils/regression/ownObjects';
import { ensureKeyChain, isSkip, type ChainOptions } from '../../utils/regression/platform/keyChain';
import { readRunState, updateRunState } from '../../utils/regression/ledger/runState';
import { createOwnKey, deleteOwnKey, type KeyChain, type KeyOptions } from '../../utils/regression/platform/keys';
import { findCryptoConnector, type CryptoConnector } from '../../utils/regression/platform/tokens';

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
    connector(version: 1 | 2): Promise<CryptoConnector>;
    make(suffix: string, options: KeyOptions & { chain: Pick<KeyChain, 'token' | 'tokenProfile'> }): Promise<OwnKeyMade>;
    record(answer: KeyCreateAnswer, details: { name: string; note: string; parents: RecordOptions['parents']; track?: boolean }): OwnRef | undefined;
    track<T extends OwnRef>(...keys: T[]): void;
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
                if (answer.status < 200 || answer.status >= 300 || typeof answer.uuid !== 'string') return undefined;
                const ref = own.record('keys', { status: answer.status, uuid: answer.uuid, text: answer.text }, {
                    name: details.name,
                    note: details.note,
                    parents: details.parents,
                });
                if (details.track) keys.track(ref);
                return ref;
            },
            track: (...made) => {
                // A key already tracked (an import that answers the key it already holds) is deleted once.
                for (const key of made) if (!tracked.some((t) => t.uuid === key.uuid)) tracked.push(key);
            },
            runToken: () => readRunState().token,
            shareAsRunChain: (chain) => {
                if (!readRunState().token) updateRunState({ token: chain.token, tokenProfile: chain.tokenProfile, key: chain.key });
            },
        };
        try {
            await use(keys);
        } finally {
            for (const key of tracked.splice(0)) await deleteOwnKey(api, key, own.spec);
        }
    },
});
