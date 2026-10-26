#!/usr/bin/env node
import {
  parseCommandArguments,
  runCommand,
} from './command.mjs';
import { loadAndValidateProvenance } from './provenance.mjs';

await runCommand({
  options: async () => parseCommandArguments(process.argv.slice(2)),
  execute: async (options) => {
    const result = await loadAndValidateProvenance(options);
    return {
      status: 'pass',
      executableFiles: result.manifest.files
        .filter(({ capabilities }) => capabilities.includes('execute'))
        .map(({ target }) => target)
        .sort(),
    };
  },
});
