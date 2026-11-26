// served-copy.mjs — the app's served modules as the built site carries them: each the file it is, at its
// place, with its comments taken out. Every line stays where it is (a comment's own line breaks are kept,
// and the spaces before a comment that starts its line go with it), so a line in the built file is the
// same line in the source, and its code at the same column: what a stack trace or the browser's tools
// name is found in the source as it is. The code itself is untouched (no renaming, no reprinting), and
// the copy keeps its source's date (a host's "changed since?" answer follows the source, not the build).
import fs from 'node:fs';
import { parseSync } from 'rolldown/utils';

// `code` (a module named `name`, for errors) without its comments, its lines kept.
export function withoutComments(name, code) {
  const { comments, errors } = parseSync(name, code);
  if (errors?.length) throw new Error(`${name}: ${errors[0].message}`);
  let out = '', at = 0;
  for (const comment of comments) {
    out += code.slice(at, comment.start);
    // Its text goes, its line breaks stay. Where code follows it on its last line, that line's part of
    // it is spaces, so the code stays at its column; where none does, the spaces before it go too.
    const text = code.slice(comment.start, comment.end);
    const lineEnd = code.indexOf('\n', comment.end);
    const codeAfter = /\S/.test(code.slice(comment.end, lineEnd < 0 ? code.length : lineEnd));
    const lastLine = text.slice(text.lastIndexOf('\n') + 1);
    if (!codeAfter) out = out.replace(/[ \t]+$/, '');
    out += text.slice(0, text.length - lastLine.length).replace(/[^\n]/g, '') + (codeAfter ? ' '.repeat(lastLine.length) : '');
    at = comment.end;
  }
  return out + code.slice(at);
}

// The copy at `to` of the module at `from`, comments out, its date kept.
export function copyServed(from, to) {
  fs.writeFileSync(to, withoutComments(from, fs.readFileSync(from, 'utf8')));
  const { atimeMs, mtimeMs } = fs.statSync(from);
  fs.utimesSync(to, atimeMs / 1000, mtimeMs / 1000);
}
