import assert from 'node:assert/strict';
import test from 'node:test';

import { maskSecrets } from '../plugins/aidrian/lib/clean-text.mjs';

// The user part of a remote URL is where git keeps a credential: a password, or a token a forge takes as the user name.
test('maskSecrets masks the whole user part of an HTTP URL, whatever it holds, and keeps an SSH user name', () => {
  const masked = {
    'https://user@github.com/acme/widgets.git': 'https://***@github.com/acme/widgets.git',
    'https://user:hunter2@github.com/acme/widgets.git': 'https://***@github.com/acme/widgets.git',
    'https://user:@github.com/acme/widgets.git': 'https://***@github.com/acme/widgets.git',
    'https://:hunter2@github.com/acme/widgets.git': 'https://***@github.com/acme/widgets.git',
    'https://ghp_abcdefghijklmnop@github.com/acme/widgets': 'https://***@github.com/acme/widgets',
    // A password with a bare `@` in it: the user part runs to the last `@` before the path.
    'https://user:hun@ter2@github.com/acme/widgets': 'https://***@github.com/acme/widgets',
    'HTTP://hunter2@git.example.com/acme/widgets': 'HTTP://***@git.example.com/acme/widgets',
    'one https://a:b@x.example/r, two http://c@y.example/r': 'one https://***@x.example/r, two http://***@y.example/r',
    // Another scheme keeps its user name and masks its password.
    'ssh://git:hunter2@github.com/acme/widgets': 'ssh://git:[redacted]@github.com/acme/widgets',
  };
  for (const [url, want] of Object.entries(masked)) assert.equal(maskSecrets(url), want, url);
  // An SSH user name is no credential, and a URL with no user part has nothing to mask, an `@` in its query included.
  for (const url of ['git@github.com:acme/widgets.git', 'ssh://git@github.com/acme/widgets', 'https://github.com/acme/widgets.git', 'https://github.com/acme/widgets?by=a@b']) {
    assert.equal(maskSecrets(url), url);
  }
});
