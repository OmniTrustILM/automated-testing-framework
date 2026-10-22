/**
 * uploads — the upload rows of the error-contract spec.
 *
 * WHAT: The upload rows of the error-contract spec: the size limit of an upload, the upload routes, the placeholder entry
 *       and garbage bytes, and the size rows with their expected refusals.
 * WHY: Upload size limits and placeholder entries are refused by the platform with exact texts that must stay stable.
 * HOW: Data rows for the size limit, the upload routes, the placeholder entry and garbage bytes, with the expected refusals.
 */
import { ERROR_MESSAGES } from './cases';
import { Answer, Expectation, checkResponse } from './checks';

// ------------------------------------------------------------------ API-GEN-03: the 5 MiB upload limit (guard-refused routes)

/** `UploadedFile.MAXIMUM_LENGTH` (interfaces core/secret/UploadedFile.java). */
export const UPLOAD_LIMIT = 5 * 1024 * 1024;
/** Characters of the base64 text of `bytes` decoded bytes. */
export const encodedLength = (bytes: number): number => Math.ceil(bytes / 3) * 4;

export type UploadRoute = 'inspections' | 'import';
export const UPLOAD_ROUTES: Record<UploadRoute, string> = { inspections: '/api/v1/inspections', import: '/api/v1/certificates/import' };

/** 64 lowercase hex characters: the shape of an entry reference (CertificateImportServiceImpl.java); it names nothing the file holds. */
export const PLACEHOLDER_ENTRY = `${'0'.repeat(63)}1`;

/** Garbage the platform cannot read as any container: `bytes` bytes of the letter A (decodes to a base64 text of zero bytes). */
export const garbageBytes = (bytes: number): Buffer => Buffer.alloc(bytes, 0x41);

/** The JSON body of an upload route whose decoded file is `bytes` long; an import names one placeholder entry. */
export function uploadBody(route: UploadRoute, bytes: number): { file: string; entries?: Array<{ entryReference: string }> } {
    const file = garbageBytes(bytes).toString('base64');
    return route === 'import' ? { file, entries: [{ entryReference: PLACEHOLDER_ENTRY }] } : { file };
}

export interface SizeRow {
    id: string;
    bytes: number;
    /** `format`: the size rule passes and the container reader refuses the garbage; `limit`: the size rule refuses. */
    outcome: 'format' | 'limit';
    rule: string;
}

export const SIZE_ROWS: readonly SizeRow[] = [
    { id: '5242880', bytes: UPLOAD_LIMIT, outcome: 'format', rule: '5 242 880 decoded bytes pass the size rule and answer the format refusal (UploadedFile.MAXIMUM_LENGTH; ContainerRefusal.java)' },
    { id: '5242881', bytes: UPLOAD_LIMIT + 1, outcome: 'limit', rule: '5 242 881 decoded bytes → 422 ["fileWithinLimit file must not exceed 5242880 bytes"] (UploadRequestDto.java)' },
    { id: '6MiB', bytes: 6 * 1024 * 1024, outcome: 'limit', rule: '6 MiB → 422 ["fileWithinLimit file must not exceed 5242880 bytes"]; never 413' },
];

/** The oracle of one upload row: a 422 with the size text or the format text; never 413, never 5xx. */
export function sizeProblems(row: SizeRow, a: Answer): string[] {
    const problems: string[] = [];
    if (a.status === 413) problems.push('413: core has no 413 path; a 413 comes from a proxy in front of it');
    if (a.status >= 500) problems.push(`${a.status}: a refused upload must never be a server error`);
    const expectation: Expectation = row.outcome === 'limit'
        ? { status: 422, messages: [ERROR_MESSAGES.oversize] }
        : { status: 422, messages: [ERROR_MESSAGES.notSupportedFormat] };
    problems.push(...checkResponse(expectation, a));
    return problems;
}
