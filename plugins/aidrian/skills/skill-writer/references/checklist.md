# Skill review checklist

Read before writing the frontmatter, and go through it item by item when reviewing a draft or auditing a skill.
Based on Anthropic's [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).

## Frontmatter

- [ ] `name` is lowercase letters, digits, and hyphens, and says what the skill does; not `helper`, `utils`, or `tools`.
- [ ] `description` is third person, says what the skill does and when to use it, and holds the words a user would type.
- [ ] `description` fits `skills.descriptionChars`, and the whole listing still fits `skills.listingBytes`.

## Content

- [ ] Each sentence tells the model something it would not do or know without it.
- [ ] Strictness matches risk: exact steps or a script for fragile work, guidance where several approaches are fine.
- [ ] Multi-step work is numbered, and each step ends in a check someone can verify.
- [ ] Quality-critical work has a loop: run the check, fix, run it again.
- [ ] One default is given, with the case that changes it, instead of a list of options.
- [ ] One term names one thing throughout.
- [ ] Examples are concrete: a real command, a real path, a real output.
- [ ] Nothing depends on a date; replaced behavior is removed, not kept as "before X, do Y".
- [ ] Every fact was checked against the code, a schema, or a command run, not memory.

## Structure

- [ ] `SKILL.md` is under the lint's size limit; what only some paths need lives in `references/`.
- [ ] Each reference is linked from `SKILL.md` with when to read it, and links to no other reference.
- [ ] A reference over about 100 lines starts with a list of its sections.
- [ ] Paths use forward slashes.

## Scripts, if the skill ships any

- [ ] The script handles its own errors and says what went wrong, instead of leaving it to the model.
- [ ] Each constant has a stated reason.
- [ ] Needed tools and packages are named, and the skill says what to do when one is missing.
- [ ] The skill says whether to run the script or read it.

## Testing

- [ ] At least three cases, each from a real failure, ran with the skill.
- [ ] They ran on each model the project uses: a smaller model may need more detail, a larger one less.
- [ ] The transcript was read: references opened when needed, none ignored, none needed every time.
