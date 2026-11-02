import { readFile } from 'node:fs/promises';
import { containsFullJwt } from './helpers.mjs';

const files = process.argv.slice(2);
if (!files.length) {
    console.error('Provide local UTF-8 log/report files to scan'); process.exitCode = 1;
} else {
    let failures = 0;
    for (const file of files) {
        try { if (containsFullJwt(await readFile(file, 'utf8'))) failures++; }
        catch { console.error('Artifact could not be read (path/details withheld)'); process.exitCode = 1; }
    }
    if (failures) { console.error(`FAIL: complete JWT found in ${failures} artifact(s); values withheld`); process.exitCode = 1; }
    else if (!process.exitCode) console.log(`PASS: no complete JWT in ${files.length} artifact(s)`);
}
