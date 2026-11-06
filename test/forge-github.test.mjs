import assert from 'node:assert/strict';
import test from 'node:test';

import { runGh } from '../plugins/aidrian/lib/forges/github-cli.mjs';
import { createGithubForge, isTrustedCommenter, MEMBER_ASSOCIATIONS, repoIdentity } from '../plugins/aidrian/lib/forges/github.mjs';
import { forgeFor } from '../plugins/aidrian/lib/forges/index.mjs';
import { MEMBER_ASSOCIATIONS as STATE_MEMBER_ASSOCIATIONS } from '../plugins/aidrian/lib/review/state.mjs';

test('forgeFor gives the GitHub adapter for a checkout, and no caller gets the raw gh it runs', () => {
  const forge = forgeFor('/repo');
  assert.equal(forge.id, 'github');
  assert.equal(forge.cwd, '/repo');
  assert.equal(forge.isTrustedCommenter, isTrustedCommenter);
  assert.equal(forge.repoIdentity, repoIdentity);
  assert.ok(Object.isFrozen(forge));
  const run = () => '';
  for (const each of [forge, createGithubForge({ cwd: '/x', run })]) {
    assert.deepEqual(Object.keys(each).sort(), ['cwd', 'id', 'isTrustedCommenter', 'repoIdentity'], 'the facade\'s own names only');
    assert.ok(!Object.values(each).includes(runGh) && !Object.values(each).includes(run), 'gh stays in the closure, a seam, not a method');
  }
});

test('isTrustedCommenter: only the people GitHub says belong to the repository', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(isTrustedCommenter({ author_association: association }), true, association);
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE', 'owner', '', undefined]) {
    assert.equal(isTrustedCommenter({ author_association: association }), false, String(association));
  }
  for (const comment of [null, undefined, {}, 'OWNER']) assert.equal(isTrustedCommenter(comment), false, String(comment));
  assert.equal(STATE_MEMBER_ASSOCIATIONS, MEMBER_ASSOCIATIONS, 'review/state.mjs re-exports the adapter\'s set, so its users keep working');
});

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
  for (const [value, host, repoPath] of cases) assert.deepEqual(repoIdentity(value), { host, path: repoPath, fork: null }, value);
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
    { host: 'gitlab.com', path: 'a/sub/project', fork: null },
    { host: 'other.host', path: 'b/sub/project', fork: null },
    { host: 'third.host', path: 'c/sub/project', fork: null },
  ]);
  assert.equal(new Set(identities.map(({ host, path }) => `${host}/${path}`)).size, 3, 'three repositories, three identities');
});
