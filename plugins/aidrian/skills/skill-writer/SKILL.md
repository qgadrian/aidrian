---
name: skill-writer
description: Create, update, audit, rename, or retire a skill in this plugin or a project, held to aidrian lint limits. Use when asked to write, change, or audit any SKILL.md.
---

# skill-writer

A skill earns its tokens only by changing what the model does on a real task: show that first, then write the least text that does it.

Before you start, follow the `knowledge` skill. Knowledge tags: `harness_engineering`, `docs`.

## Where skills live, and their limits

- This plugin's own skills: `plugins/aidrian/skills/<name>/SKILL.md`, in the plugin's repository.
- A project's skills: the folder its `harness_engineering` knowledge names, else `.claude/skills/<name>/SKILL.md`.
  When that knowledge names a generator or a mirror for another host, run it after every edit.
- `aidrian lint skills <skills-folder>` reads the folder that holds the skill folders (`plugins/aidrian/skills`;
  with no argument, `.claude/skills`). Its summary must count this skill: `0 skills` means the wrong folder, not a pass.
- The lint fails a `SKILL.md` at 8,000 bytes, where Codex cuts it, and warns above 7,500; this plugin's tests fail above 7,500.
- The `description` is one line of at most 160 characters (config.json `skills.descriptionChars`),
  and all names and descriptions together fit in `skills.listingBytes`: both hosts list them in every session.

## Modes

Make every edit in a task worktree from the `worktree-new` skill (`aidrian worktree new <branch>`).
A session already in one stays in it; an audit that only reports needs none.

- **Create**: Steps 1 to 8.
- **Update**: Step 1 for the change, then Steps 2 to 8.
- **Audit**: the lint from Step 7, then Step 6 with Step 5's table applied to every fact in the skill,
  then the skill's saved cases if it has any. If a file changed, Steps 7 and 8.
- **Rename or retire**: § Rename or retire.

## Step 1: Find the gap

Take two or three real requests: from the lesson inbox (`aidrian lesson list`) when it holds any, else from the user.
Run each in a fresh session that shares none of this conversation, without the skill (for an update, with the current version).
Write down what went wrong: a missed step, a wrong default, a guess where a fact existed.

**Done when** each gap is one observed failure, not a feature idea.

## Step 2: Write the cases

Turn the gaps into at least three cases: a request, the files it needs, and the behaviors a correct run shows.
At least one asks in a user's words without naming the skill, and one is a near miss that belongs to a neighboring skill.
Save them where the next audit finds them: the project's eval folder, or in this plugin `evals/<case>/`
(`claude plugin eval init --bare <case>` writes one).

**Done when** every case passes or fails on behavior someone can check from the transcript.

## Step 3: Choose the home

1. Read the description of every skill that could overlap: in the session's listing, this plugin, and the project.
   Run `aidrian-knowledge search <words>` for a doc that already owns the behavior.
2. Extend an existing skill when the trigger and the audience match. Create one only for a request users really make.
   Decline when the need is a one-off prompt: stop, and report the sentence below.
3. Create only: name it in kebab-case by its action or role (`pr-write`, `adr-writer`), unused in the plugin or the project.

**Done when** one sentence names the closest existing skill and why it was or was not extended.

## Step 4: Write the frontmatter

The description is how the model picks the skill, and it sits in every session's context.

- Say what the skill does and when to use it, in the words a user would type, never as "I" or "you".
  This plugin's descriptions start with the verb ("Create ...").
- Name each mode the skill serves once, in the word a user types; no synonyms.
- `name` equals the folder name.
- A skill only the Human runs, which no agent preloads and no other skill invokes, gets `disable-model-invocation: true`.
  Claude Code then hides it from the model; Codex ignores the field, so its description still counts toward the listing.

**Done when** the description fits the limit and a reader can tell from it alone when the skill applies.

## Step 5: Write the body

Write to [references/checklist.md](references/checklist.md) § Content. Then:

- Put what only some modes need, or what would push `SKILL.md` past 7,500 bytes, in `references/<topic>.md`,
  and one phase of a long sequence in `steps/<phase>.md`. `SKILL.md` links each with when to read it.
- Check every fact while you write the sentence that states it:

| The draft states | Check |
| --- | --- |
| A schema field or enum value | Read the schema and one real file; they agree |
| A path or glob | `ls` a real instance; the glob matches what it should |
| A skill or agent | Its folder or file exists |
| A command or flag | Run it with `--help` or real arguments |
| A script | It exists; read its header; say what to do when it is absent |
| "The project does X" | `grep` finds a real instance |

Write placeholders as `<name>`. A path that differs per worktree comes from `git rev-parse`, never a guess.

**Done when** every step has a check, every support file is linked with when to read it, and you hold the list of commands run.

## Step 6: Review against the checklist

Go through [references/checklist.md](references/checklist.md), every section, on the draft or, for an audit, the current skill.
Fix or remove each sentence that fails an item.

**Done when** every item passes.

## Step 7: Run the checks and the cases

1. Run the lint. In this plugin's repository, `npm run bump` first, keep the skill's row in `docs/agents-and-skills.md`
   in step with its description, then `npm run check`. Run any generator the project names.
2. Run each case in a fresh session, never a fork of this one, on each model that runs the skill,
   as [references/running-cases.md](references/running-cases.md) says; read it before the first run.
3. Fix what failed, and repeat from 1.

**Done when** every command exits 0 with no size warning for this skill; every case passes with the skill and did worse
without it; the skill fired on the unnamed request and stayed out of the near miss. A case that passes without the
skill tests nothing: drop it, or drop the text it covers.

## Step 8: Ship

Skip this step for an audit that changed no file.

1. Commit from the task worktree, with the commands from Steps 5 and 7 and each case's result in the message:

   ```text
   Verification:
   - <command> (<what it showed>)
   ```

2. Open a draft pull request with the `pr-write` skill only when the caller asked, or the running flow publishes.
   Otherwise report the commit as ready to publish.

**Done when** the commit lists the commands really run, and the pull request exists or the commit is reported ready.

## Rename or retire

In one commit:

1. Rename: `git mv` the folder, and set `name:` to the new folder name. Retire: delete the folder and any generated copy.
2. `grep -rn '<old-name>'` across skills, agent sources (`agents-src/<group>/` in this plugin), docs, and the project folder.
   Point each live reference at the skill that now does the work, or remove it. In this plugin, `docs/agents-and-skills.md` lists every skill.
3. Step 7's first item, then Step 8.

**Done when** the grep finds the old name only in history, such as changelogs and decision records.
