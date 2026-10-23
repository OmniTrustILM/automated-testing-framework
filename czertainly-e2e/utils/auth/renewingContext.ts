import type { APIRequestContext } from '@playwright/test';

/**
 * renewingContext — an API context that opens a fresh one before its token runs out.
 *
 * WHAT: `renewingContext(open)` returns an APIRequestContext whose requests go to the current context of `open()`; when the current
 * token has less than `marginMs` left, the next request opens a new context first (one renewal at a time, however many requests wait).
 * WHY: a worker-scoped fixture lives for the whole worker (minutes: a hook before a group and a hook after it), longer than the lifetime
 * of one access token; a context built once would send an expired token in its last hook.
 * HOW: a Proxy over the request methods (get, post, put, patch, delete, head, fetch, storageState); `dispose` disposes every context it
 * opened. Superseded contexts are kept until `dispose`, so a request still in flight on one of them is never cut off.
 */
export interface RenewingOptions {
  /** Renew when the token has less than this left (default 120 s). */
  marginMs?: number;
  /** The clock (unit tests). */
  now?: () => number;
}

export const RENEW_MARGIN_MS = 120_000;

export type OpenedContext = { context: APIRequestContext; expiresAt: number };

export function renewingContext(open: () => Promise<OpenedContext>, options: RenewingOptions = {}): APIRequestContext {
  const margin = options.marginMs ?? RENEW_MARGIN_MS;
  const now = options.now ?? Date.now;
  const opened: APIRequestContext[] = [];
  let current: Promise<OpenedContext> | undefined;
  let disposed = false;

  const fresh = (): Promise<OpenedContext> => {
    const next = open().then((c) => {
      opened.push(c.context);
      return c;
    });
    // A failed grant is not kept: the next request tries again.
    next.catch(() => {
      if (current === next) current = undefined;
    });
    return next;
  };
  const currentContext = async (): Promise<APIRequestContext> => {
    if (disposed) throw new Error('the API context was disposed');
    const seen = (current ??= fresh());
    const known = await seen;
    if (known.expiresAt - now() > margin) return known.context;
    // Expiring: the first request that sees it renews; the others wait for the same renewal.
    if (current === seen) current = fresh();
    return (await current).context;
  };

  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch', 'storageState']);
  return new Proxy({} as APIRequestContext, {
    get(_target, property: string) {
      if (property === 'dispose') {
        return async (disposeOptions?: { reason?: string }): Promise<void> => {
          disposed = true;
          const all = opened.splice(0);
          await Promise.all(all.map((c) => c.dispose(disposeOptions).catch(() => undefined)));
        };
      }
      if (!methods.has(property)) return undefined;
      return async (...args: unknown[]) => {
        const context = await currentContext();
        return (context[property as 'get'] as (...a: unknown[]) => Promise<unknown>).apply(context, args);
      };
    },
  });
}
