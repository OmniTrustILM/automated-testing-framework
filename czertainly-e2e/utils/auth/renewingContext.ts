import type { APIRequestContext } from '@playwright/test';

/**
 * renewingContext — an API context that opens a fresh one before its token runs out (one renewal at a time).
 * Superseded contexts are kept until `dispose`, so a request still in flight is never cut off.
 */
export interface RenewingOptions {
  marginMs?: number;
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

  const disposedError = () => new Error('the API context was disposed');
  const fresh = (): Promise<OpenedContext> => {
    const next = open().then(async (c) => {
      if (disposed) {
        // Disposed while this context was opening: close it.
        await c.context.dispose().catch(() => undefined);
        throw disposedError();
      }
      opened.push(c.context);
      return c;
    });
    next.catch(() => {
      if (current === next) current = undefined;
    });
    return next;
  };
  const currentContext = async (): Promise<APIRequestContext> => {
    if (disposed) throw disposedError();
    const seen = (current ??= fresh());
    const known = await seen;
    if (disposed) throw disposedError();
    if (known.expiresAt - now() > margin) return known.context;
    // Expiring: the first request renews; the others wait for the same renewal.
    if (current === seen) current = fresh();
    const renewed = await current;
    if (disposed) throw disposedError();
    return renewed.context;
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
