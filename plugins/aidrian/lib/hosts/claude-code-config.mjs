// Claude Code's config folder, which holds its settings and its `projects` folder of transcripts and kept tool results:
// `CLAUDE_CONFIG_DIR` when set, else `.claude` in the home folder, `HOME` first, as Claude Code reads them.

import { homedir } from 'node:os';
import path from 'node:path';

export const configDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(env.HOME || homedir(), '.claude');
