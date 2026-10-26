#!/usr/bin/env node
import {
  parseCommandArguments,
  runCommand,
} from './command.mjs';
import { checkArtifact } from './artifact.mjs';

await runCommand({
  options: async () =>
    parseCommandArguments(process.argv.slice(2), { artifact: true }),
  execute: async (options) => {
    const result = await checkArtifact(options);
    return {
      status: 'pass',
      artifactSha256: result.artifactSha256,
      manifestSha256: result.manifestSha256,
      files: result.files,
    };
  },
});
