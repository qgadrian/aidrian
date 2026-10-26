# Private Harness Distribution Tooling

This repository contains Node.js ESM tooling for a private, allowlisted pilot artifact. The artifact is assembled only from `provenance/distribution-files.json`; every shipped file must declare its origin, private-use authority, public-eligibility state, transformation, checksum, mode, and executable capabilities.

The current pilot is private. A distribution-level gate blocks public promotion until a separate explicit review changes that contract; every file and runtime dependency would also need to be marked eligible. No public license is selected by this repository.

## Commands

Install the exact locked dependencies:

```sh
npm ci
```

Run the distribution boundary and its focused test corpus:

```sh
npm run test:distribution-safety
npm run check:provenance
npm run check:capabilities
npm run build:pilot -- --check
```

Build and inspect the private pilot artifact locally:

```sh
npm run build:pilot
npm run check:distribution-artifact -- --artifact dist/pilot/private-pilot.tgz
```

`build:pilot -- --check` uses disposable output and reports working inputs without presenting a dirty checkout as an immutable source pin. A normal build writes the scanned assembly, deterministic archive, and `distribution-report.json` under `dist/pilot/`.

Safety failures print only a rule identifier and relative path. An optional neutral policy file may add generic-file terms that are forbidden for a particular producer without embedding source-project identities in this repository:

```sh
npm run build:pilot -- --check --policy policy.json
```
