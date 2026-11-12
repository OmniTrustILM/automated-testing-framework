/**
 * The REAL playwright.regression.config.ts with every project pointed at this fixture folder. Its tier
 * rules (grep / grepInvert per project, folded in by withTierFilters at load) are what `--list` exercises.
 */
import * as path from 'path';
import base from '../../../../playwright.regression.config';

export default {
    ...base,
    testDir: __dirname,
    globalTeardown: undefined,
    // Listing only: no report and no output inside the source tree.
    reporter: [['list']],
    outputDir: path.join(__dirname, '..', '..', '..', '..', 'test-results', 'list-filter'),
    projects: (base.projects ?? []).map((p) => ({ ...p, testDir: __dirname, testMatch: /filters\.fixture\.ts$/, testIgnore: [] })),
};
