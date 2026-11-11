// Faults injected into node:fs for one path, for the body reader tests: the rules import fs by name, so each change is
// pushed to those bindings with syncBuiltinESMExports, and undone after the test.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const fault = (code) => Object.assign(new Error(code), { code });

function inject(t, name, file, fail) {
  const real = fs[name];
  let calls = 0;
  t.mock.method(fs, name, (target, ...rest) => {
    if (typeof target === 'string' && path.resolve(target) === file && fail(calls++)) throw fault(fail.code);
    return real(target, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

// `file` is missing at its first stat and there at every later one: it appears between two reads.
export function appearsAfterFirstStat(t, file) {
  inject(t, 'statSync', file, Object.assign((call) => call === 0, { code: 'ENOENT' }));
}

// `file` is a regular file whose every read fails as one without read permission does.
export function unreadableFile(t, file) {
  inject(t, 'readFileSync', file, Object.assign(() => true, { code: 'EACCES' }));
}
