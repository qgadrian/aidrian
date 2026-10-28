# Producer self-compliance

The producer consumes the same neutral compiler it distributes. Typed inputs live under `.agent-harness/overlays/`; `buildCatalog`, `loadProjectOverlays`, and `loadSkillOverlays` render exactly these checked-in families:

- `.claude/agents/*.md`
- `.codex/agents/*.toml`
- `.codex/config.toml`
- `.agents/skills/**`

The projection is acyclic: it reads catalog content, schemas, adapters, and typed overlays, but no Git commit, package artifact, bundle digest, managed ledger, or prior projection. The currentness test rejects missing, extra, and stale files and compares two independent renders.

## Contributor workflow

Install the locked dependencies, then run the distribution boundary and disposable build:

```sh
npm ci
npm run test:distribution-safety
npm run check:provenance
npm run check:capabilities
npm run build:pilot -- --check
```

Run the provider-free producer and neutral-consumer proof with:

```sh
node --test test/pilot/producer-self-dogfood.test.mjs \
  test/pilot/lifecycle-fixture.test.mjs \
  test/pilot/cross-project-isolation.test.mjs \
  test/pilot/provider-claims.test.mjs
```

Build and scan the private artifact with:

```sh
npm run build:pilot
npm run check:distribution-artifact -- --artifact dist/pilot/private-pilot.tgz
```

`build:pilot -- --check` uses disposable output and reports working inputs without presenting a dirty checkout as an immutable source pin. Safety failures print only a rule identifier and relative path; an optional neutral policy is supplied with `npm run build:pilot -- --check --policy policy.json`.

The two neutral consumers are disposable test directories, not application pilots. They rebuild bundles from the immutable source commit recorded in `test/pilot/helpers.mjs`, compare them with caller-owned pins, and exercise marketplace-companion install, update, rollback, uninstall, cleanup, collision rejection, reviewer subsets, and cross-project isolation through the existing bundle and managed-projection APIs. They do not write Acme, Globex, or any other application repository.

Full project-bundle activation requires the existing native inventory capability. That capability executes version-pinned provider inventory commands before planning. The provider-free fixtures therefore leave full activation and native mode collision as separate provider-attended rows with status `unverified`; they do not bypass or fabricate the opaque native observation token. The existing project-bundle tests own the applicable provider-free validation and rejection coverage around that guard.

## Handoff shape

Producer role work returns an object with `status`, `role`, `decision`, `evidence`, `deferred_refs`, `blockers`, and `next_owner`. A blocked result names the failing provider or invariant explicitly. `docs/providers.md` owns the durable attended-row inventory; `test/pilot/provider-claims.test.mjs` verifies it and prevents static evidence from being reported as a provider pass.
