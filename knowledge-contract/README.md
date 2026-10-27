# Project knowledge contract

This contract validates project-owned knowledge without becoming a resolver.
The project keeps one document catalog, one route source, and one descriptor at
the root of every registered knowledge folder. The runtime that already chooses
tags, load order, fingerprints, and authorization remains authoritative.

`project.schema.json` declares the single catalog authority, the route source,
and the complete descriptor path set. `folder.schema.json` records folder
identity, ownership, visibility, include/exclude globs, allowed cross-folder
link roots, route-group identity, orphan policy, and always-loaded eligibility.
`index.schema.json` is the catalog format for projects that do not already
produce the same document-index shape. Folder descriptors cannot declare an
index, so they cannot create a second catalog authority.

`validateKnowledgeRegistry` in
`src/project-bundle/knowledge-registry.mjs` is the only validator. Its normal
mode reads every declared artifact through the repository's safe-file helpers.
Its preloaded mode accepts externally read catalog, route, and descriptor data
for discovery conformance while still checking the declared catalog and route
files plus every referenced project document at the external project root.
Neither mode copies project knowledge into this repository.

Validation is fail-closed for malformed schemas, unsafe or missing paths,
duplicate IDs, unmatched route groups, uncataloged route targets, stale or
unowned catalog entries, invalid orphan declarations, unauthorized
cross-folder links, shared-to-private links, and invalid bootstrap
contributors. Every catalog entry has exactly one folder owner; owned
catalog-only documents remain governed by that folder's orphan policy.

The link grammar accepts relative inline links, Markdown reference links,
link-bearing raw HTML `href`/`src` attributes, same-document anchors, and the
explicit external schemes `http`, `https`, `mailto`, and `tel`. Root-relative,
`file:`, malformed, escaping, character-reference-bearing, and
unrecognized-scheme destinations fail closed. Raw HTML link attributes also
reject ASCII control or whitespace bytes anywhere in their value instead of
interpreting them as Markdown title separators. Reference labels are unique
after case/whitespace normalization; label escapes and character references
are unsupported. Definitions stay on one line, and duplicate or continuation
definitions are rejected instead of guessed.
Link-shaped text inside inline or fenced code is not rendered and is ignored.
Every parsed local destination uses the same ownership, cross-root, and
visibility checks. The returned bootstrap list preserves route-source order;
the validator never sorts or rewrites it.
