/**
 * The REAL playwright.regression.config.ts with every project pointed at this fixture folder.
 */
import * as path from 'path';
import base from '../../../../playwright.regression.config';

export default {
    ...base,
    testDir: __dirname,
    globalTeardown: undefined,
    reporter: [['list']],
    outputDir: path.join(__dirname, '..', '..', '..', '..', 'test-results', 'list-filter'),
    projects: (base.projects ?? []).map((p) => ({ ...p, testDir: __dirname, testMatch: /filters\.fixture\.ts$/, testIgnore: [] })),
};
