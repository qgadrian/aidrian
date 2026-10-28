import { appendFileSync } from 'node:fs';

if (!process.env.AIDRIAN_FIXTURE_CANARY) throw new Error('missing fixture canary path');
appendFileSync(process.env.AIDRIAN_FIXTURE_CANARY, 'codex-hook\n');
