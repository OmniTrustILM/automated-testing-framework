/**
 * guardProofSpy — the blocking spy of the live guard proof (tests/api/tier-snapshot.setup.ts).
 *
 * The proof hands pre-existing objects of the tier to the guard and expects an OWNERSHIP refusal. The raw context sits behind
 * this spy, which forwards ONLY reads (GET / HEAD); every other call is recorded and refused with GuardSpyBlocked, so even a
 * regressed guard cannot change a real object. `expectOwnershipRefusal` fails unless the refusal is of kind `ownership`.
 */
import type { APIRequestContext } from '@playwright/test';
import { OwnObjectViolation } from './ledger/ownership';

/** What the spy throws instead of forwarding a request: a guard regression shows up as this class. */
export class GuardSpyBlocked extends Error {
    constructor(readonly what: string) {
        super(`guard-proof spy: ${what} reached the raw context and was NOT sent (the guard should have refused it first)`);
        this.name = 'GuardSpyBlocked';
    }
}

const READS = new Set(['GET', 'HEAD']);
/** Context members that send nothing to the tier. */
const LOCAL_ONLY = new Set(['dispose', 'storageState']);

/** The method a call on the context would send: the property name, or for `fetch` the options' / Request's method. */
function methodOfCall(prop: string | symbol, args: unknown[]): string {
    if (prop !== 'fetch') return String(prop).toUpperCase();
    const fromOptions = (args[1] as { method?: string } | undefined)?.method;
    const request = args[0] as { method?: () => string } | string | undefined;
    const fromRequest = typeof request === 'object' && request && typeof request.method === 'function' ? request.method() : undefined;
    return String(fromOptions ?? fromRequest ?? 'GET').toUpperCase();
}

/** The raw context behind a blocking spy; `mutations` lists every request it refused. */
export function readOnlySpy(api: APIRequestContext): { api: APIRequestContext; mutations: string[] } {
    const mutations: string[] = [];
    const wrapped = new Proxy(api, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function') return value;
            if (typeof prop === 'string' && LOCAL_ONLY.has(prop)) return (value as (...a: unknown[]) => unknown).bind(target);
            return (...args: unknown[]) => {
                const method = methodOfCall(prop, args);
                const forwarded = (prop === 'get' || prop === 'head' || prop === 'fetch') && READS.has(method);
                if (!forwarded) {
                    const what = `${method} ${typeof args[0] === 'string' ? args[0] : '(request object)'}`;
                    mutations.push(what);
                    return Promise.reject(new GuardSpyBlocked(what));
                }
                return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
        },
    });
    return { api: wrapped, mutations };
}

/**
 * The OwnObjectViolation a refused call ends with; throws (failing the proof) when the call did not fail, failed with
 * anything else (GuardSpyBlocked: the guard let it through), or was refused for another reason than ownership.
 */
export async function expectOwnershipRefusal(call: Promise<unknown>): Promise<OwnObjectViolation> {
    let error: unknown;
    try {
        await call;
    } catch (e) {
        error = e;
    }
    if (error === undefined) throw new Error('guard proof: the call was not refused');
    if (!(error instanceof OwnObjectViolation)) throw new Error(`guard proof: expected an ownership refusal, got ${String(error).slice(0, 300)}`);
    if (error.kind !== 'ownership') throw new Error(`guard proof: refused for ${error.kind} (${error.reason}), not for ownership`);
    return error;
}
