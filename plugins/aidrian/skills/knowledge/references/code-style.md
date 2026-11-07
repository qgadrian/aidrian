# Default code style

These are the plugin's defaults. A project's own `code_style` docs win where they conflict.
`knowledge.defaults.codeStyle: false` in the project's config turns this doc off.

- **Simplest sufficient solution.** Build what the requirement needs: no speculative abstraction, and no options beyond it.
- **Reuse first.** Use an existing helper before writing a new one.
  When a second caller needs a behaviour, extract it into a public helper they share.
- **One concern per file and per function.** A file above about 300 lines, or a function above about 40,
  needs a reason to stay that way. This is a guideline, never a hard fail, and a project sets its own numbers.
- **Flat control flow, named values.** Prefer an early return and a named intermediate to nesting.
  No nested ternaries, and no conditional inside an argument or a template: name a variable for it.
  One flat conditional assigned to a name is fine.
  Where the project's linter configures this, the linter decides, and this rule is advice, not a review gate.
- **Interfaces only at a real extension point.** Put a boundary where a second implementation is plausible, not everywhere.
- **Read the facts before deciding.** Read the real types, callers, and docs; never guess.
- **Shortcuts.** A simpler solution that skips complexity the problem does not need yet is preferred,
  as long as it does not block a fuller one later. When it leaves a known limit, mark the spot with a comment
  that starts `SHORTCUT:` and says why it is enough now and what would replace it.
- **Docs and comments state the contract and the why**, not a retelling of the code, so they do not drift from it.
