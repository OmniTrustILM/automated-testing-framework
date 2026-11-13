/**
 * summaryFile — `writeJsonAtomic(file, data)`: indented JSON, mode 0600 (it may hold secrets), via a temp file and a rename so a reader
 * never sees a half-written file.
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
