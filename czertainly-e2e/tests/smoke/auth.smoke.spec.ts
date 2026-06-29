import { Locator } from '@playwright/test';
import { test, expect, loginAsSmokeUser } from '../../fixtures/testFixtures';
import { DashboardPage } from '../../pages/DashboardPage';
import {
  sidebarItems,
  topTilesTitles
} from './smokeData';

const assertHeadingsVisible = async (
  container: Locator,
  titles: readonly string[]
) => {
  for (const title of titles) {
    await expect(
      container.getByRole('heading', { name: title, exact: true })
    ).toBeVisible();
  }
};

test.describe('@smoke auth', () => {
  test('SMK-001: user can log in', async ({ page, env }) => {
    const dashboardPage = new DashboardPage(page);
    const { sidebarNav, topTiles, header, footer } = dashboardPage;


    await test.step('login', async () => {
      await loginAsSmokeUser(page, env);
      await expect(page).toHaveURL(/dashboard/i);
    });

    await test.step('assert sidebar', async () => {
      await expect(sidebarNav).toBeVisible();
    });

    await test.step('assert sidebar items', async () => {
      // Scope to direct-child <a>/<button> of the main <ul>, so nested links inside
      // expanded parent menus (e.g. Dashboard > Certificates) don't collide with
      // top-level items of the same name (e.g. top-level Certificates).
      const topLevelUl = sidebarNav.locator('ul').first();
      for (const item of sidebarItems) {
        const tag = item.role === 'link' ? 'a' : 'button';
        await expect(
          topLevelUl.locator(`:scope > li > ${tag}, :scope > li > div > ${tag}`)
            .filter({ hasText: item.name })
        ).toBeVisible();
      }
    });

    await test.step('assert top tiles', async () => {
      await expect(topTiles).toBeVisible();
      await expect(topTiles.locator('section')).toHaveCount(topTilesTitles.length);
    });

    await test.step('verify top tiles titles', async () => {
      await assertHeadingsVisible(topTiles, topTilesTitles);
    });

    await test.step('verify presence of header and footer', async () => {
      await expect(header).toBeVisible();
      await expect(footer).toBeVisible();
    });
  });
});