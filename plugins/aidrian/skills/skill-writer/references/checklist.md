# Skill review checklist

Based on Anthropic's [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).
Testing is in `SKILL.md` Step 7's Done when.

## Frontmatter

- [ ] `name` equals the folder name: lowercase letters, digits, and hyphens, at most 64 characters, says what the skill does.
  Not `helper`, `utils`, or `tools`, and no `anthropic` or `claude`.
- [ ] `description` says what the skill does and when to use it, in the words a user would type, never as "I" or "you".
- [ ] `description` fits `skills.descriptionChars`, and the whole listing still fits `skills.listingBytes`.
- [ ] Neither field holds XML tags.

## Content

- [ ] Each sentence tells the model something it would not do or know without it.
- [ ] Strictness matches risk: exact steps or a script for fragile work, guidance where several approaches are fine.
- [ ] Multi-step work is numbered, and each step ends in a check someone can verify.
- [ ] A workflow of more than about six steps offers a checklist the model copies and ticks.
- [ ] Quality-critical work has a loop: run the check, fix, run it again.
- [ ] One default is given, with the case that changes it, instead of a list of options.
- [ ] One term names one thing throughout.
- [ ] Examples are concrete: a real command, a real path, a real output.
- [ ] Nothing depends on a date; replaced behavior is removed, not kept as "before X, do Y".
- [ ] Every fact was checked against the code, a schema, or a command run, not memory.
- [ ] Each tool or CLI the skill needs is named, with what to do when it is missing.
- [ ] An MCP tool is named by its server and tool, or by the role a shared reference gives it.

## Structure

- [ ] `SKILL.md` is at most 7,500 bytes.
- [ ] `SKILL.md` links every file the skill reads, with when to read it. A support file names another only when
  `SKILL.md` also links it, or when it is another skill's file, named with that skill.
- [ ] A support file over about 100 lines starts with a list of its sections.
- [ ] Paths use forward slashes.

## Scripts, if the skill ships any

- [ ] The script handles its own errors and says what went wrong, instead of leaving it to the model.
- [ ] Each constant has a stated reason.
- [ ] The skill says whether to run the script or read it.
