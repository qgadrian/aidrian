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
      schemaVersion: result.manifest.schemaVersion,
      manifestSha256: result.manifestSha256,
      files: result.manifest.files.map(({ target }) => target).sort(),
      publicPromotionEligible: result.publicPromotionEligible,
    };
  },
});
