import { test, expect, loginAsSmokeUser } from '../../fixtures/testFixtures';
import { Navigation } from '../../pages/Navigation';
import { navigableSidebarItems } from './smokeData';
import type { Page, Request, Response } from '@playwright/test';
function createTagged5xxCollector(page: Page) {
  const requestToPageTag = new Map<Request, string>();

  const errorsByTag = new Map<string, string[]>();

  const pendingByTag = new Map<string, number>();

  let currentTag = '';

  const baseHost = (() => {
    try {
      return new URL(process.env.BASE_URL ?? '').host;
    } catch {
      return '';
    }
  })();

  const onRequest = (req: Request) => {
    const rt = req.resourceType();

    if (rt !== 'xhr' && rt !== 'fetch') return;

    const url = req.url();
    if (url.includes('/api/v1/notifications')) return;

    if (baseHost && new URL(url).host !== baseHost) return;

    if (!url.includes('/api/')) return;

    requestToPageTag.set(req, currentTag);

    const pending = pendingByTag.get(currentTag) ?? 0;
    pendingByTag.set(currentTag, pending + 1);
  };

  const onResponse = (res: Response) => {
    const req = res.request();
    const status = res.status();

    if (status < 500) return;

    const tag = requestToPageTag.get(req);

    if (!tag) return;

    const line = `Error ${status} on ${req.method()} ${res.url()}`;

    const bucket = errorsByTag.get(tag) ?? [];

    bucket.push(line);

    errorsByTag.set(tag, bucket);
  };

  const decrementPending = (req: Request) => {
    const tag = requestToPageTag.get(req);
    if (!tag) return;

    const pending = pendingByTag.get(tag) ?? 0;
    pendingByTag.set(tag, Math.max(0, pending - 1));
  };

  const onRequestFinished = (req: Request) => {
    decrementPending(req);
  };

  const onRequestFailed = (req: Request) => {
    decrementPending(req);
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onRequestFinished);
  page.on('requestfailed', onRequestFailed);

  return {
    setTag(tag: string) {
      currentTag = tag;
    },

    resetTag(tag: string) {
      errorsByTag.set(tag, []);
      pendingByTag.set(tag, 0);
    },

    getErrors(tag: string) {
      return errorsByTag.get(tag) ?? [];
    },

    async waitForIdle(tag: string, options?: { timeoutMs?: number; idleMs?: number }) {
      const timeoutMs = options?.timeoutMs ?? 5000;
      const idleMs = options?.idleMs ?? 250;
      const pollMs = 50;

      const start = Date.now();
      let idleStart: number | null = null;

      try {
        await expect
          .poll(
            () => {
              const pending = pendingByTag.get(tag) ?? 0;

              if (pending === 0) {
                if (idleStart === null) idleStart = Date.now();
                if (Date.now() - idleStart >= idleMs) return true;
              } else {
                idleStart = null;
              }

              if (Date.now() - start >= timeoutMs) return true;
              return false;
            },
            { timeout: timeoutMs, intervals: [pollMs] }
          )
          .toBeTruthy();
      } catch {
        return;
      }
    },

    dispose() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFailed);
      requestToPageTag.clear();
      errorsByTag.clear();
      pendingByTag.clear();
    },
  };
}

test.describe('@smoke navigation', () => {
  test('SMK-002: key pages load without critical crashes', async ({ page, env }) => {
    // Walks every sidebar page (~50) in one test: the default 30 s is not enough.
    // On the shared dev environment it took 29.4 s on 2026-11-03 and ran out of time on 2026-11-04.
    test.setTimeout(120_000);
    await loginAsSmokeUser(page, env);

    const collector = createTagged5xxCollector(page);

    const nav = new Navigation(page);

    const main = page.locator('main');

    for (const item of navigableSidebarItems) {
      collector.setTag(item.name);

      collector.resetTag(item.name);

      await nav.openViaSidebar(item.name, item.urlHint, item.parentButtonName);

      await expect(main, `Main content visible for ${item.name}`).toBeVisible();

      await expect(
        main.getByText(/something went wrong/i),
        `Error state detected on ${item.name}`
      ).toHaveCount(0);

      await expect(
        main.getByText(/internal server error/i),
        `Internal server error message detected on ${item.name}`
      ).toHaveCount(0);

      await expect(main, `Main content has text for ${item.name}`).toContainText(/\S/);

      await collector.waitForIdle(item.name);

      const errors = collector.getErrors(item.name);

      expect(
        errors,
        `5xx API responses detected for "${item.name}":\n${errors.join('\n')}`
      ).toEqual([]);
    }

    collector.dispose();
  });
});