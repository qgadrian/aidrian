import assert from 'node:assert/strict';
import test from 'node:test';

import { maskSecrets } from '../plugins/aidrian/lib/clean-text.mjs';

// The user part of a remote URL is where git keeps a credential: a password, or a token a forge takes as the user name.
test('maskSecrets masks the credential in a remote URL\'s user part, and leaves a URL with none as it is', () => {
  const masked = {
    'https://user:hunter2@github.com/acme/widgets.git': 'https://user:[redacted]@github.com/acme/widgets.git',
    'https://:hunter2@github.com/acme/widgets.git': 'https://:[redacted]@github.com/acme/widgets.git',
    'https://x-access-token:hunter2@github.com/acme/widgets': 'https://x-access-token:[redacted]@github.com/acme/widgets',
    'https://hunter2@github.com/acme/widgets.git': 'https://[redacted]@github.com/acme/widgets.git',
    'HTTP://hunter2@git.example.com/acme/widgets': 'HTTP://[redacted]@git.example.com/acme/widgets',
    'https://ghp_abcdefghijklmnop@github.com/acme/widgets': 'https://[redacted]@github.com/acme/widgets',
    'one https://a:b@x.example/r, two https://c@y.example/r': 'one https://a:[redacted]@x.example/r, two https://[redacted]@y.example/r',
  };
  for (const [url, want] of Object.entries(masked)) assert.equal(maskSecrets(url), want, url);
  // An SSH user name is no credential, and a URL with no user part has nothing to mask.
  for (const url of ['git@github.com:acme/widgets.git', 'ssh://git@github.com/acme/widgets', 'https://github.com/acme/widgets.git']) {
    assert.equal(maskSecrets(url), url);
  }
});
