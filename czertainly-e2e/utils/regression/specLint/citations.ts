/**
 * specLint/citations — finds `Name.ext:NNN` file-and-line citations in source text (they go stale and read like links into code nobody can
 * open).
 * A plain regular expression over comments and strings alike; the developers' blocks keep their own citations and are not scanned.
 */
const EXTENSIONS = 'java|kt|tsx?|jsx?|mjs|cjs|py|go|ya?ml|json|xml|md|sh|properties|sql|html|css';
const CITATION = new RegExp(`\\b[A-Za-z][A-Za-z0-9_-]*\\.(?:${EXTENSIONS}):\\d+`);

export interface SourceCitation {
    line: number;
    text: string;
}

export function sourceCitations(text: string): SourceCitation[] {
    return text.split('\n').flatMap((l, i) => (CITATION.test(l) ? [{ line: i + 1, text: l.trim().slice(0, 120) }] : []));
}
