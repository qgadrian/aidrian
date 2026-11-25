// Claude Code's config folder, which holds its settings and its `projects` folder of transcripts and kept tool results:
// `CLAUDE_CONFIG_DIR` when set, else `.claude` in the home folder, `HOME` first, as Claude Code reads them;
// and the models and efforts the adapter's modules take.

import { homedir } from 'node:os';
import path from 'node:path';

// The models and efforts config.json may name for Claude Code (the adapter's `modelChoices`).
export const MODEL_CHOICES = Object.freeze({ model: ['sonnet', 'opus', 'haiku', 'fable'], effort: ['low', 'medium', 'high', 'xhigh', 'max'] });

export const configDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(env.HOME || homedir(), '.claude');
