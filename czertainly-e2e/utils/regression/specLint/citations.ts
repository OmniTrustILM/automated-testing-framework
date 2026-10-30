/**
 * specLint/citations — finds `Name.ext:NNN` file-and-line citations in source text.
 *
 * `sourceCitations(text)` returns the lines that cite a source file with a line number or a line range (a file name, a colon
 * and digits). A line number goes stale with the next commit of the product, and a path with a line in a public repository
 * reads like a link into code nobody can open; a component or symbol name stays true and can be searched for.
 *
 * It is a regular expression over the text, comments and strings alike. specGuards.spec.ts applies it to the specs, the page
 * objects and utils/regression / utils/api; the developers' blocks keep their own citations by agreement and are not scanned.
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
