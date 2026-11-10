import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { repoIdentity } from '../plugins/aidrian/lib/forges/identity.mjs';

// repoIdentity is the facade's own helper: it reads a remote or a `-R` value before any forge is chosen.
test('repoIdentity reads every form of a repository to its host and full path', () => {
  const cases = [
    ['acme/notes', 'github.com', 'acme/notes'],
    ['Acme/Notes', 'github.com', 'acme/notes'],
    ['github.com/Acme/notes', 'github.com', 'acme/notes'],
    ['ghe.example.com/acme/notes', 'ghe.example.com', 'acme/notes'],
    // Longer than gh's host/owner/repo: a namespaced forge's path, accepted here though gh itself refuses it.
    ['gitlab.com/a/sub/project', 'gitlab.com', 'a/sub/project'],
    ['https://github.com/acme/notes.git', 'github.com', 'acme/notes'],
    ['https://GitHub.com/Acme/notes/', 'github.com', 'acme/notes'],
    ['https://user:token@ghe.example.com:8443/acme/notes.git/', 'ghe.example.com', 'acme/notes'],
    ['http://gitlab.com/a/sub/project', 'gitlab.com', 'a/sub/project'],
    ['ssh://git@github.com/acme/notes/', 'github.com', 'acme/notes'],
    ['ssh://git@github.com:22/acme/notes.git', 'github.com', 'acme/notes'],
    ['git+ssh://git@gitlab.com/a/sub/project.git', 'gitlab.com', 'a/sub/project'],
    ['git@github.com:acme/notes.git', 'github.com', 'acme/notes'],
    ['git@GitLab.com:A/Sub/Project.git', 'gitlab.com', 'a/sub/project'],
    ['github.com:acme/notes', 'github.com', 'acme/notes'],
    ['  acme/notes\n', 'github.com', 'acme/notes'],
  ];
  for (const [value, host, repoPath] of cases) assert.deepEqual(repoIdentity(value), { host, path: repoPath }, value);
});

test('repoIdentity is null for what names no repository, a local remote included', () => {
  const local = ['/srv/git/acme/notes.git', './acme/notes', '../notes', '~/repos/acme/notes', 'C:/repos/acme/notes', 'c:\\repos\\acme\\notes', 'file:///srv/git/acme/notes.git'];
  for (const value of [...local, '', 'notes', '/', 'acme//notes', 'https://github.com/', 'https://github.com/notes', 'git@github.com:notes.git', 'ssh://[bad', null, undefined, 42, {}]) {
    assert.equal(repoIdentity(value), null, String(value));
  }
});

test('repoIdentity keeps the namespace that the last-two-parts key threw away', () => {
  const values = ['https://gitlab.com/a/sub/project.git', 'git@other.host:b/sub/project.git', 'ssh://git@third.host/c/sub/project'];
  const identities = values.map(repoIdentity);
  assert.deepEqual(identities, [
    { host: 'gitlab.com', path: 'a/sub/project' },
    { host: 'other.host', path: 'b/sub/project' },
    { host: 'third.host', path: 'c/sub/project' },
  ]);
  assert.equal(new Set(identities.map(({ host, path }) => `${host}/${path}`)).size, 3, 'three repositories, three identities');
});

test('repoIdentity reads ssh.github.com, GitHub\'s SSH endpoint on port 443, as github.com on any port', () => {
  for (const value of ['ssh://git@ssh.github.com:443/acme/notes.git', 'ssh://git@ssh.github.com/Acme/notes', 'git@ssh.github.com:acme/notes.git', 'ssh.github.com/acme/notes']) {
    assert.deepEqual(repoIdentity(value), { host: 'github.com', path: 'acme/notes' }, value);
  }
  assert.deepEqual(repoIdentity('ssh://git@ssh.ghe.acme.io:443/acme/notes'), { host: 'ssh.ghe.acme.io', path: 'acme/notes' }, 'only the alias it knows');
});
