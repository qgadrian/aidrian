// What a confined issue session of a project run needs to install a project's dependencies, the same on every host
// (docs/config.md#project-run, docs/providers/claude-code.md#project-start, docs/providers/codex.md#project-start):
//   - REGISTRIES: the package registries the team may list in projectRun.registries, by ecosystem name, each to the
//     fixed network hosts its official clients install from. A team names an ecosystem, never a host: no free-form
//     domain reaches a sandbox's allowlist. Each host was read on 2026-11-18 with an install's own requests (the index or
//     metadata, then the files it links to, with no redirect to another host); no live confined session has run one.
//   - cacheVars: the environment that moves every package manager's cache and global store into the attempt's `cache`
//     folder, the one place besides its clone a session's installs write, so nothing is written outside the attempt's
//     folder and the home folder stays as it is.
// It reads no file and imports no module of the plugin: config-types.mjs checks the names against it.

import path from 'node:path';

// The hosts of each ecosystem's registry:
//   - npm: registry.npmjs.org, where npm and pnpm read package metadata and tarballs; registry.yarnpkg.com, yarn's
//     default, which serves the same packages.
//   - pypi: pypi.org, the simple index pip and uv read; files.pythonhosted.org, where its files are.
//   - crates: index.crates.io, cargo's sparse index; static.crates.io, where the index's `dl` sends downloads.
//   - go: proxy.golang.org, the default GOPROXY; sum.golang.org, the default GOSUMDB that checks each module's sum.
//   - rubygems: index.rubygems.org, bundler's compact index; rubygems.org, where gems download from.
export const REGISTRIES = Object.freeze({
  npm: Object.freeze(['registry.npmjs.org', 'registry.yarnpkg.com']),
  pypi: Object.freeze(['pypi.org', 'files.pythonhosted.org']),
  crates: Object.freeze(['index.crates.io', 'static.crates.io']),
  go: Object.freeze(['proxy.golang.org', 'sum.golang.org']),
  rubygems: Object.freeze(['index.rubygems.org', 'rubygems.org']),
});
export const REGISTRY_NAMES = Object.freeze(Object.keys(REGISTRIES));

// Whether `value` is a list of registry names, each once: what projectRun.registries holds.
export const isRegistries = (value) => Array.isArray(value) && value.every((name) => Object.hasOwn(REGISTRIES, name)) && new Set(value).size === value.length;

// The network hosts of the registries `names` lists, in the order REGISTRIES gives them; a name it does not hold adds none.
export const registryHosts = (names) => (Array.isArray(names) ? REGISTRY_NAMES.filter((name) => names.includes(name)).flatMap((name) => REGISTRIES[name]) : []);

// The flag that makes go leave its module cache writable, so the driver can remove an attempt's folder: go makes each
// module's folder read-only, which a recursive remove cannot pass.
const GO_WRITABLE = '-modcacherw';

// The environment of a session whose attempt's cache folder is `cache`, an absolute path: each variable to a folder
// in it, and GOFLAGS as `env` has it with GO_WRITABLE added. Every package manager's own variable:
//   - npm: npm_config_cache.
//   - pnpm: PNPM_HOME, whose `store` is the default store of every pnpm since 7, and pnpm_config_store_dir,
//     pnpm_config_cache_dir, and pnpm_config_state_dir, which pnpm 10 and later read; npm_config_store_dir is not set,
//     since npm warns on every command of a key it does not know.
//   - yarn: YARN_CACHE_FOLDER, and YARN_GLOBAL_FOLDER, where yarn 2 and later keep their global cache by default.
//   - pip and uv: PIP_CACHE_DIR and UV_CACHE_DIR.
//   - cargo: CARGO_HOME, its registry cache and installs; the user's ~/.cargo config and credentials no longer load.
//   - go: GOPATH, GOMODCACHE, and GOCACHE.
//   - ruby: GEM_HOME, where gem and bundler install, and BUNDLE_USER_HOME, bundler's own cache and config; BUNDLE_PATH
//     is not set, so bundler still uses the gems the Ruby already has.
// COREPACK_HOME is not set: a version of yarn or pnpm corepack already downloaded stays readable where it is.
export function cacheVars(cache, env = {}) {
  const at = (...parts) => path.join(cache, ...parts);
  const goFlags = String(env.GOFLAGS ?? '').split(/\s+/u).filter(Boolean);
  return {
    npm_config_cache: at('npm'),
    PNPM_HOME: at('pnpm'),
    pnpm_config_store_dir: at('pnpm', 'store'),
    pnpm_config_cache_dir: at('pnpm-cache'),
    pnpm_config_state_dir: at('pnpm-state'),
    YARN_CACHE_FOLDER: at('yarn'),
    YARN_GLOBAL_FOLDER: at('yarn-global'),
    PIP_CACHE_DIR: at('pip'),
    UV_CACHE_DIR: at('uv'),
    CARGO_HOME: at('cargo'),
    GOPATH: at('go'),
    GOMODCACHE: at('go', 'pkg', 'mod'),
    GOCACHE: at('go-build'),
    GOFLAGS: [...goFlags.filter((flag) => flag !== GO_WRITABLE), GO_WRITABLE].join(' '),
    GEM_HOME: at('gem'),
    BUNDLE_USER_HOME: at('bundle'),
  };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

// Why `vars`, the environment a gate passes a host's start, is not an object of variable names to plain text, or null.
// None given is none.
export function varsProblem(vars) {
  if (vars === undefined) return null;
  const plain = typeof vars === 'object' && vars !== null && !Array.isArray(vars) &&
    Object.entries(vars).every(([name, value]) => ENV_NAME.test(name) && typeof value === 'string' && !CONTROL.test(value));
  return plain ? null : 'the cache environment the gate passes the session is not variable names to plain text';
}
