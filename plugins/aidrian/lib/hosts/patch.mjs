// The `*** Begin Patch` format two hosts' file tools take: Codex's apply_patch and OpenCode's patch. A leaf that imports
// nothing, so each adapter reads a patch the same way. lib/config-guard.mjs patchOperations is a different reader.

// A `*** ... File:` line opens a section of the patch, and `*** Move to:` renames the one above.
export const PATCH_TARGET = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gmu;

// The files a patch adds to or updates, as [{ file, added }], each with the lines it adds; a deleted file adds none.
export function patchFiles(text) {
  const files = [];
  for (const line of text.split(/\r?\n/u)) {
    const header = /^\*\*\* (?:Add|Update) File: (.+)$/u.exec(line);
    const move = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (header) files.push({ file: header[1].trim(), added: [] });
    else if (move && files.at(-1)?.file) files.at(-1).file = move[1].trim();
    else if (/^\*\*\* /u.test(line)) files.push({ file: null, added: [] });
    else if (line.startsWith('+') && files.at(-1)?.file) files.at(-1).added.push(line.slice(1));
  }
  return files.filter(({ file }) => file);
}

// A patch's file edit in the shape lib/hosts/index.mjs fileEditOf reads: { shape: 'patch', text, files, targets }, with
// `targets` every path a section header or a move names, deleted files among them.
export function patchEdit(text) {
  return { shape: 'patch', text, files: patchFiles(text), targets: [...text.matchAll(PATCH_TARGET)].map((match) => match[1].trim()) };
}
