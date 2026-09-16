/**
 * Playwright config for visual baseline capture (QA: UI branding — OmniTrustILM/ilm#383).
 *
 * WHAT: a second, standalone config used only by tests/visual. It deliberately does NOT load
 * the smoke globalSetup, so running it never provisions connectors or a PKI chain — these tests
 * only look at pages.
 *
 * WHY: Epic ilm#273 AC 14 and fe-administrator#2039 AC 5 require that an instance with no
 * branding configured renders exactly as it did before the branding work. Proving that needs the
 * same screens captured twice, from two frontend commits, against one unchanged backend.
 *
 * HOW: point VISUAL_BASE_URL at a locally running frontend, capture the reference set once from
 * the pre-branding commit with `npm run visual:baseline`, switch the frontend to the commit under
 * test and run `npm run visual:compare`. Playwright's own snapshot comparison reports the diff.
 *
 * The local development stack authenticates through the ssl-client-cert header injected by the
 * frontend's setupProxy.js, so there is no sign-in step here.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests/visual',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 60_000,
    expect: {
        timeout: 15_000,
        toHaveScreenshot: {
            // Anti-aliasing and font rasterisation differ slightly between runs even on one
            // machine. Anything above this ratio is a real layout or colour change worth reading.
            maxDiffPixelRatio: 0.002,
            animations: 'disabled',
            caret: 'hide',
            scale: 'css',
        },
    },
    snapshotPathTemplate: '{testDir}/__baseline__/{arg}{ext}',
    use: {
        baseURL: process.env.VISUAL_BASE_URL ?? 'http://localhost:5173',
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        screenshot: 'off',
        trace: 'off',
        video: 'off',
    },
    reporter: [['list']],
});
