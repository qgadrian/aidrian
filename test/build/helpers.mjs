import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const writeTree = async (root, files, filter = () => true) => {
  for (const [relative, file] of files) {
    if (!filter(relative)) continue;
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { mode: file.mode });
  }
};
