# Provider support

Aidrian emits complete project projections for Claude and Codex. The shared catalog is the source; `src/build/build.mjs` renders provider-specific role files, the Codex registry, and shared skills.

| Provider | Checked-in producer projection | Provider-free evidence | Provider-attended evidence |
| --- | --- | --- | --- |
| Claude | `.claude/agents/*.md` | schema, rendering, selection metadata, currentness, and fixed-point checks | Unverified until the recorded producer role invocation runs |
| Codex | `.codex/agents/*.toml` plus `.codex/config.toml` | schema, rendering, registry selection, currentness, and fixed-point checks | Unverified until the recorded producer role invocation runs |

The hook-free marketplace bundle and the producer projection are different activation modes. Marketplace installation uses an immutable source commit and bundle pins. Producer development calls `buildCatalog` directly with typed overlays and checks the rendered files into this repository; it has no current-commit pin, managed ledger, or bundle manifest.

OpenCode is not a supported provider. There is no OpenCode build, conformance command, adapter, artifact, or compatibility claim.

Provider-free tests never authenticate, modify trust, inspect provider status, or launch a provider. A static or byte-identical result cannot promote a provider-attended row to passing.

## Provider-attended handover

This machine-readable block is the durable handover inventory. Its rows stay `unverified` until the corresponding attended evidence exists.

<!-- provider-attended-rows:start -->
```json
[
  { "provider": "claude", "surface": "producer-project-role", "status": "unverified" },
  { "provider": "codex", "surface": "producer-project-role", "status": "unverified" },
  { "provider": "claude", "surface": "neutral-fixture-a-invocation", "status": "unverified" },
  { "provider": "codex", "surface": "neutral-fixture-a-invocation", "status": "unverified" },
  { "provider": "claude", "surface": "neutral-fixture-b-invocation", "status": "unverified" },
  { "provider": "codex", "surface": "neutral-fixture-b-invocation", "status": "unverified" },
  { "provider": "claude+codex", "surface": "full-project-bundle-activation-and-native-mode-collision", "status": "unverified", "dependency": "opaque native inventory token" }
]
```
<!-- provider-attended-rows:end -->
