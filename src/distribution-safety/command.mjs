import path from 'node:path';

import {
  DistributionSafetyError,
  formatDiagnostics,
} from './diagnostics.mjs';
import { loadPolicy } from './content-policy.mjs';

export function parseCommandArguments(argv, { artifact = false } = {}) {
  const result = {
    rootDir: process.cwd(),
    manifestPath: path.resolve('provenance/distribution-files.json'),
    policyPath: null,
    publicPromotion: false,
    artifactPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--manifest' && argv[index + 1]) {
      result.manifestPath = path.resolve(argv[++index]);
    } else if (argument === '--policy' && argv[index + 1]) {
      result.policyPath = path.resolve(argv[++index]);
    } else if (argument === '--public') {
      result.publicPromotion = true;
    } else if (artifact && argument === '--artifact' && argv[index + 1]) {
      result.artifactPath = path.resolve(argv[++index]);
    } else {
      throw new TypeError('invalid command arguments');
    }
  }
  if (artifact && result.artifactPath === null) {
    throw new TypeError('missing artifact');
  }
  return result;
}

export async function runCommand(action) {
  try {
    const options = await action.options();
    options.policy = await loadPolicy(options.policyPath);
    const result = await action.execute(options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    if (error instanceof DistributionSafetyError) {
      process.stderr.write(formatDiagnostics(error.issues) + '\n');
    } else {
      process.stderr.write('COMMAND_INVALID\t<command>\n');
    }
    process.exitCode = 1;
  }
}
