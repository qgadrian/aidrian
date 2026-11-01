---
name: skill-writer
description: Creates, updates, audits, or retires a skill, tested against real tasks and kept small. Use when asked to write, fix, review, or remove a skill.
---

# skill-writer

A skill is worth its tokens only when it changes what the model does on a real task.
This skill builds that evidence first, then writes the least text that produces the change.

Before you start, follow the `knowledge` skill. Knowledge tags: `harness_engineering`, `docs`.

Read [references/checklist.md](references/checklist.md) before Step 4 and again in Step 6.

## Where skills live, and their limits

- This plugin's own skills: `plugins/aidrian/skills/<name>/SKILL.md`, in the plugin's repository.
- A project's skills: the folder its `harness_engineering` knowledge names, else `.claude/skills/<name>/SKILL.md`.
  When that knowledge names a generator or a mirror for another host, run it after every edit.
- `aidrian lint skills <folder>` fails a `SKILL.md` at 8,000 bytes, where Codex cuts it, and warns above 7,500.
- The `description` is one line of at most 160 characters (config.json `skills.descriptionChars`),
  and all skill names and descriptions together fit in `skills.listingBytes`: both hosts list them in every session.

## Paths

Make every edit in a task worktree from the `worktree-new` skill (`aidrian worktree new <branch>`).
A session already in one stays in it; an audit that only reports needs none.

- **Create**: Steps 1 to 8.
- **Update**: Step 1 for the change, then Steps 2 to 8.
- **Audit**: Step 6, Step 5 for each claim the audit touched, then Steps 7 and 8 if a file changed.
- **Retire or rename**: § Retire or rename.

## Step 1: Find the gap

Run the task without the skill, or with the current version, on two or three real requests.
Write down what went wrong: a missed step, a wrong default, a guess where a fact existed.

**Done when** each gap is written as one observed failure, not a feature idea.

## Step 2: Write the test cases

Turn the gaps into at least three cases: a request, the files it needs, and the behaviors a correct run shows.
Keep them beside the skill's pull request or in the project's eval folder, if it has one.

**Done when** every case passes or fails on behavior someone can check from the transcript.

## Step 3: Choose the home

1. Read the description of every skill in this plugin and the project that could overlap.
   Run `aidrian-knowledge search <words>` for a doc that already owns the behavior.
2. Extend an existing skill when the trigger and the audience match. Create one only for a request users really make.
   Decline when the need is a one-off prompt.
3. Name a new skill in kebab-case, by its action or role (`pr-write`, `adr-writer`), unused in the plugin or the project.

**Done when** one sentence names the closest existing skill and why it was or was not extended.

## Step 4: Write the frontmatter

The description is how the model picks the skill, and it sits in every session's context.

- Third person, saying what the skill does and when to use it, with the words a user would type.
- Each path from Step 3 once; no synonym lists.
- A skill only the Human runs gets `disable-model-invocation: true`. Claude Code then hides it from the model;
  Codex ignores the field and lists it anyway, so its description still counts toward `skills.listingBytes`.

**Done when** the description fits the limit and a reader can tell from it alone when the skill applies.

## Step 5: Write the body

- Write only what the model would not do on its own. Cut background it already knows.
- Match the strictness to the risk: firm steps for fragile or ordered work, short guidance where judgment fits.
- Give numbered steps for multi-step work, each ending in a **Done when** someone can check.
- Give one default, with the exception that changes it, rather than a menu of options.
- Put what only some paths need in `references/<topic>.md`, linked from `SKILL.md` with when to read it.
  Keep links one level deep; a reference file links to no other reference.
- Say what to do, not what to avoid. Keep one term for one thing. Leave out dates and versions that will go stale.
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

**Done when** every step has a check, every reference file is linked with its trigger, and you hold the list of commands
you ran to verify facts: Step 8 needs it.

## Step 6: Review against the checklist

Go through [references/checklist.md](references/checklist.md) item by item, on the draft or, for an audit, the current skill.
Remove each sentence that fails it, or fix it.

**Done when** every item passes. An audit of an older skill that removes nothing deserves a second look.

## Step 7: Run the checks and the cases

1. Run `aidrian lint skills <folder>`; in this plugin's repository, `npm run check`. Run any generator the project names.
2. Run the Step 2 cases with the skill, on each model the project uses. Watch the transcript: files read in an odd order,
   a reference never opened, or one opened every time, each says the structure should move.
3. Fix what failed, and repeat from 1.

**Done when** every command exits 0 with no size warning for this skill, every case passes, and generated files are staged.

## Step 8: Ship

Skip this step for an audit that changed no file.

1. Commit from the task worktree, with the commands from Step 5 and the case results in the message:

   ```text
   Verification:
   - <command> (<what it showed>)
   ```

2. Open a draft pull request with the `pr-write` skill only when the caller asked, or the running flow publishes.
   Otherwise report the commit as ready to publish.

**Done when** the commit lists the commands really run, and the pull request exists or the commit is reported ready.

## Retire or rename

In one commit:

1. Delete the skill's folder and any generated copy.
2. `grep -rn '<old-name>'` across skills, agent sources (`agents-src/<group>/` in this plugin), docs, and the project folder.
   Point each live reference at the skill that now does the work, or remove it.
3. Run Step 7's first item.

**Done when** the grep finds the old name only in history, such as changelogs and decision records.
