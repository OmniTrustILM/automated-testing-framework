/**
 * guardProof — the blocking spy of the live guard proof (tests/api/_run-setup.setup.ts, reviews Q1, B0 fix pass 3).
 *
 * The proof hands pre-existing objects of the target tier to the guard and to a guarded helper and expects an
 * OWNERSHIP refusal. The raw context underneath sits behind this spy, which forwards ONLY reads: `get`, `head`, `fetch`
 * with GET / HEAD (from the options or a Request object), plus the two local helpers `dispose` / `storageState` that
 * send nothing to the tier. Every other call — `post` / `put` / `patch` / `delete`, `fetch` with any other method,
 * and any method the spy does not know — is recorded and REFUSED with SpyBlockedRequest, never forwarded. So even a
 * regressed guard cannot disable or delete a real object during the proof: the proof fails on the error class and on
 * the recorded list.
 *
 * `ownershipRefusal(promise)` resolves to the OwnObjectViolation of a refused call and fails unless its kind is
 * `ownership`: a refusal for another reason (the runtime brand of a raw context, a path rule) would hide a broken
 * ownership check, so the proof asserts the specific reason (fix pass 3).
 */
import type { APIRequestContext } from '@playwright/test';
import { OwnObjectViolation } from './ownObjects';

/** What the spy throws instead of forwarding a request: a guard regression shows up as this class. */
export class SpyBlockedRequest extends Error {
    constructor(readonly what: string) {
        super(`guard-proof spy: ${what} reached the raw context and was NOT sent (the guard should have refused it first)`);
        this.name = 'SpyBlockedRequest';
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
export function blockingSpy(api: APIRequestContext): { api: APIRequestContext; mutations: string[] } {
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
                    return Promise.reject(new SpyBlockedRequest(what));
                }
                return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
        },
    });
    return { api: wrapped, mutations };
}

/**
 * The OwnObjectViolation a refused call ends with; throws (failing the proof) when the call did not fail, failed with
 * anything else (SpyBlockedRequest: the guard let it through), or was refused for another reason than ownership.
 */
export async function ownershipRefusal(call: Promise<unknown>): Promise<OwnObjectViolation> {
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
