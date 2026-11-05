import type { ChangedFile, PreparedDiff } from '../types/index.js';

const ignored = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|node_modules\/|vendor\/|dist\/)|\.(?:min\.js|map|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|gz)$/i;

/** Parse GitHub unified hunks into explicit old/new line labels, retaining context. */
export function annotatePatch(patch: string): string {
  let oldLine = 0;
  let newLine = 0;
  return patch.split('\n').map(line => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return line;
    }
    if (line.startsWith('+')) return `new:${newLine++} ${line}`;
    if (line.startsWith('-')) return `old:${oldLine++} ${line}`;
    if (line.startsWith(' ')) {
      oldLine++;
      return `new:${newLine++} ${line}`;
    }
    return line;
  }).join('\n');
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit);
  const newline = prefix.lastIndexOf('\n');
  return newline > 0 ? prefix.slice(0, newline) : '';
}

export function prepareDiff(
  files: ChangedFile[],
  limits: { maxChars: number; maxFileChars: number; maxFiles: number },
  totalFiles = files.length,
): PreparedDiff {
  const parts: string[] = [];
  let chars = 0;
  let includedFiles = 0;
  let truncatedFiles = 0;
  for (const file of files) {
    if (includedFiles >= limits.maxFiles) break;
    if (ignored.test(file.filename) || !file.patch) continue;
    const header = `\nFILE ${JSON.stringify(file.filename)} (${file.status})\n`;
    const patch = annotatePatch(file.patch);
    const budget = Math.min(limits.maxFileChars, limits.maxChars - chars - header.length);
    if (budget < 100) continue;
    const body = clip(patch, budget);
    if (!body) continue;
    if (body.length < patch.length) truncatedFiles++;
    const part = header + body;
    parts.push(part);
    chars += part.length;
    includedFiles++;
  }
  return { text: parts.join(''), includedFiles, omittedFiles: Math.max(0, totalFiles - includedFiles), truncatedFiles };
}
