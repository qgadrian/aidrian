import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  makeFixture,
  readJson,
  validateFixture,
  writeJson,
} from './helpers.mjs';

test('rejects traversal in a declared authority path', async (t) => {
  const root = await makeFixture(t);
  const project = await readJson(root, 'project.json');
  project.knowledge.catalog.path = '../catalog.json';
  await writeJson(root, 'project.json', project);

  await assert.rejects(validateFixture(root), /KNOWLEDGE_PROJECT_SCHEMA/u);
});

test('rejects a catalog authority reached through a symlink', async (t) => {
  const root = await makeFixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'aidrian-knowledge-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'catalog.json'), '[]\n');
  await unlink(path.join(root, 'catalog.json'));
  await symlink(path.join(outside, 'catalog.json'), path.join(root, 'catalog.json'));

  await assert.rejects(validateFixture(root), /symbolic links are not allowed/u);
});

test('rejects a knowledge document reached through a symlink escape', async (t) => {
  const root = await makeFixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'aidrian-knowledge-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'intro.md');
  await writeFile(target, '# Outside\n');
  const source = path.join(root, 'docs/shared-guides/intro.md');
  await unlink(source);
  await symlink(target, source);

  await assert.rejects(validateFixture(root), /KNOWLEDGE_CATALOG_STALE/u);
});

test('rejects an undeclared cross-root knowledge link', async (t) => {
  const root = await makeFixture(t);
  const privateDescriptorPath = 'docs/project-notes/harness-knowledge.json';
  const privateDescriptor = await readJson(root, privateDescriptorPath);
  privateDescriptor.visibility = 'shared';
  await writeJson(root, privateDescriptorPath, privateDescriptor);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[Operations](../project-notes/operations.md)\n',
  );

  await assert.rejects(validateFixture(root), /KNOWLEDGE_CROSS_ROOT_LINK/u);
});

test('rejects shared knowledge linking to project-private knowledge', async (t) => {
  const root = await makeFixture(t);
  const sharedDescriptorPath = 'docs/shared-guides/harness-knowledge.json';
  const sharedDescriptor = await readJson(root, sharedDescriptorPath);
  sharedDescriptor.allowedLinkRoots = ['docs/project-notes'];
  await writeJson(root, sharedDescriptorPath, sharedDescriptor);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[Operations](../project-notes/operations.md)\n',
  );

  await assert.rejects(validateFixture(root), /KNOWLEDGE_SHARED_PRIVATE_LINK/u);
});

test('rejects a relative markdown link that escapes the project root', async (t) => {
  const root = await makeFixture(t);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[Outside](../../../outside.md)\n',
  );

  await assert.rejects(validateFixture(root), /KNOWLEDGE_LINK_TRAVERSAL/u);
});

test('rejects a root-relative Markdown destination', async (t) => {
  const root = await makeFixture(t);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[Operations](/docs/project-notes/operations.md)\n',
  );

  await assert.rejects(validateFixture(root), /KNOWLEDGE_LINK_ROOT_RELATIVE/u);
});

test('rejects a file-scheme Markdown destination', async (t) => {
  const root = await makeFixture(t);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[Operations](file:../project-notes/operations.md)\n',
  );

  await assert.rejects(validateFixture(root), /KNOWLEDGE_LINK_FILE_SCHEME/u);
});

test('rejects a file-scheme Markdown autolink', async (t) => {
  const root = await makeFixture(t);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n<file:///project-private/operations.md>\n',
  );

  await assert.rejects(validateFixture(root), /KNOWLEDGE_LINK_FILE_SCHEME/u);
});

test('ignores link-shaped placeholders inside fenced code', async (t) => {
  const root = await makeFixture(t);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n```yaml\nlocation: <file:line>\n```\n',
  );

  await assert.doesNotReject(validateFixture(root));
});

test('ignores link-shaped placeholders inside inline code', async (t) => {
  const root = await makeFixture(t);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n`[placeholder](file:///project-private/note.md)`\n',
  );

  await assert.doesNotReject(validateFixture(root));
});

test('rejects character references in inline Markdown destinations', async (t) => {
  const root = await makeFixture(t);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[Operations](f&#105;le:///project-private/note.md)\n',
  );

  await assert.rejects(
    validateFixture(root),
    /KNOWLEDGE_LINK_CHARACTER_REFERENCE/u,
  );
});

test('rejects character references in reference destinations', async (t) => {
  const root = await makeFixture(t);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[Operations][private]\n\n'
      + '[private]: ../project-notes/oper&#97;tions.md\n',
  );

  await assert.rejects(
    validateFixture(root),
    /KNOWLEDGE_LINK_CHARACTER_REFERENCE/u,
  );
});

test('rejects character references in raw HTML destinations', async (t) => {
  const root = await makeFixture(t);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n<a href="f&#105;le:///project-private/note.md">Note</a>\n',
  );

  await assert.rejects(
    validateFixture(root),
    /KNOWLEDGE_LINK_CHARACTER_REFERENCE/u,
  );
});

test('rejects ASCII whitespace anywhere in raw HTML destinations', async (t) => {
  const destinations = [
    'f\tile:///project-private/note.md',
    'fi\nle:///project-private/note.md',
    '../project-\tnotes/operations.md',
    '../project-\nnotes/operations.md',
  ];
  for (const destination of destinations) {
    const root = await makeFixture(t);
    await writeFile(
      path.join(root, 'docs/shared-guides/intro.md'),
      `# Introduction\n\n<a href="${destination}">Note</a>\n`,
    );
    await assert.rejects(
      validateFixture(root),
      /KNOWLEDGE_RAW_HTML_LINK_WHITESPACE/u,
    );
  }
});

test('rejects percent-encoded forbidden schemes after decoding', async (t) => {
  const root = await makeFixture(t);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[Operations](file%3A///project-private/note.md)\n',
  );

  await assert.rejects(validateFixture(root), /KNOWLEDGE_LINK_FILE_SCHEME/u);
});

test('rejects an unrecognized destination scheme', async (t) => {
  const root = await makeFixture(t);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[Operations](editor:../project-notes/operations.md)\n',
  );

  await assert.rejects(
    validateFixture(root),
    /KNOWLEDGE_LINK_UNSUPPORTED_SCHEME/u,
  );
});

test('applies visibility policy to Markdown reference links', async (t) => {
  const root = await makeFixture(t);
  const sharedDescriptorPath = 'docs/shared-guides/harness-knowledge.json';
  const sharedDescriptor = await readJson(root, sharedDescriptorPath);
  sharedDescriptor.allowedLinkRoots = ['docs/project-notes'];
  await writeJson(root, sharedDescriptorPath, sharedDescriptor);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[Operations][private-operations]\n\n'
      + '[private-operations]: ../project-notes/operations.md\n',
  );

  await assert.rejects(validateFixture(root), /KNOWLEDGE_SHARED_PRIVATE_LINK/u);
});

test('applies visibility policy to collapsed reference links', async (t) => {
  const root = await makeFixture(t);
  const sharedDescriptorPath = 'docs/shared-guides/harness-knowledge.json';
  const sharedDescriptor = await readJson(root, sharedDescriptorPath);
  sharedDescriptor.allowedLinkRoots = ['docs/project-notes'];
  await writeJson(root, sharedDescriptorPath, sharedDescriptor);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[private-operations][]\n\n'
      + '[private-operations]: ../project-notes/operations.md\n',
  );

  await assert.rejects(validateFixture(root), /KNOWLEDGE_SHARED_PRIVATE_LINK/u);
});

test('applies visibility policy to shortcut reference links', async (t) => {
  const root = await makeFixture(t);
  const sharedDescriptorPath = 'docs/shared-guides/harness-knowledge.json';
  const sharedDescriptor = await readJson(root, sharedDescriptorPath);
  sharedDescriptor.allowedLinkRoots = ['docs/project-notes'];
  await writeJson(root, sharedDescriptorPath, sharedDescriptor);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[private-operations]\n\n'
      + '[private-operations]: ../project-notes/operations.md\n',
  );

  await assert.rejects(validateFixture(root), /KNOWLEDGE_SHARED_PRIVATE_LINK/u);
});

test('rejects duplicate normalized reference labels in either order', async (t) => {
  const definitionOrders = [
    [
      '[target]: https://example.invalid/safe',
      '[TARGET]: ../project-notes/operations.md',
    ],
    [
      '[target]: ../project-notes/operations.md',
      '[TARGET]: https://example.invalid/safe',
    ],
  ];
  for (const definitions of definitionOrders) {
    const root = await makeFixture(t);
    await writeFile(
      path.join(root, 'docs/shared-guides/intro.md'),
      `# Introduction\n\n[Target][target]\n\n${definitions.join('\n')}\n`,
    );
    await assert.rejects(
      validateFixture(root),
      /KNOWLEDGE_REFERENCE_DUPLICATE/u,
    );
  }
});

test('rejects character references in reference labels', async (t) => {
  const root = await makeFixture(t);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[target]\n\n'
      + '[&#116;arget]: ../project-notes/operations.md\n'
      + '[target]: https://example.invalid/safe\n',
  );

  await assert.rejects(
    validateFixture(root),
    /KNOWLEDGE_REFERENCE_LABEL_UNSUPPORTED/u,
  );
});

test('rejects escaped closing brackets in reference definitions and usages', async (t) => {
  const definitionOnlyRoot = await makeFixture(t);
  await writeFile(
    path.join(definitionOnlyRoot, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n[private\\]]: ../project-notes/operations.md\n',
  );
  await assert.rejects(
    validateFixture(definitionOnlyRoot),
    /KNOWLEDGE_REFERENCE_LABEL_UNSUPPORTED/u,
  );

  const usages = [
    '[Operations][private\\]]',
    '[private\\]][]',
    '[private\\]]',
  ];
  for (const usage of usages) {
    const root = await makeFixture(t);
    await writeFile(
      path.join(root, 'docs/shared-guides/intro.md'),
      `# Introduction\n\n${usage}\n\n`
        + '[private\\]]: ../project-notes/operations.md\n',
    );
    await assert.rejects(
      validateFixture(root),
      /KNOWLEDGE_REFERENCE_LABEL_UNSUPPORTED/u,
    );
  }
});

test('rejects unsupported and continuation reference definitions', async (t) => {
  const unsupportedForms = [
    '[private]:\n  ../project-notes/operations.md',
    '[private]: ../project-notes/operations.md\n  "Private title"',
    '[private] : ../project-notes/operations.md',
  ];
  for (const definition of unsupportedForms) {
    const root = await makeFixture(t);
    await writeFile(
      path.join(root, 'docs/shared-guides/intro.md'),
      `# Introduction\n\n[Operations][private]\n\n${definition}\n`,
    );
    await assert.rejects(
      validateFixture(root),
      /KNOWLEDGE_REFERENCE_DEFINITION_UNSUPPORTED/u,
    );
  }
});

test('applies visibility policy to link-bearing raw HTML', async (t) => {
  const root = await makeFixture(t);
  const sharedDescriptorPath = 'docs/shared-guides/harness-knowledge.json';
  const sharedDescriptor = await readJson(root, sharedDescriptorPath);
  sharedDescriptor.allowedLinkRoots = ['docs/project-notes'];
  await writeJson(root, sharedDescriptorPath, sharedDescriptor);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n<a href="../project-notes/operations.md">Operations</a>\n',
  );

  await assert.rejects(validateFixture(root), /KNOWLEDGE_SHARED_PRIVATE_LINK/u);
});

test('rejects malformed link-bearing raw HTML', async (t) => {
  const root = await makeFixture(t);
  await writeFile(
    path.join(root, 'docs/shared-guides/intro.md'),
    '# Introduction\n\n<a href=>Broken link</a>\n',
  );

  await assert.rejects(validateFixture(root), /KNOWLEDGE_RAW_HTML_LINK_INVALID/u);
});
