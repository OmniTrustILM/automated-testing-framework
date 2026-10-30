/**
 * summaryFile — the one way a development block stores its setup summary.
 *
 * `writeJsonAtomic(file, data)` writes indented JSON with mode 0600 and returns `file`. The summary may hold generated
 * secrets, and a reader must never see a half-written file: it writes a temp file next to the target, then renames it.
 */
import * as fs from 'fs';
import * as path from 'path';

export function writeJsonAtomic(file: string, data: unknown): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return file;
}
