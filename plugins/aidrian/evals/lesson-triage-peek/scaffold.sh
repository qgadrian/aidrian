#!/bin/sh
# Exports the committed HEAD of the repository that holds this suite into the run's working folder, without the skill
# under test or the eval suite, as a fresh one-commit repository: no history to read the skill back from, so only the
# plugin arm has it. Points the project's state folder at .eval-state in the run folder, so no inbox outside the run is
# written, and seeds that inbox with two open lessons through the CLI.
set -eu
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
git -C "$root" archive HEAD -- . ':(exclude)plugins/aidrian/skills/lesson-triage' ':(exclude)plugins/aidrian/evals' | tar -x -f -
node -e '
const fs = require("node:fs");
const file = ".aidrian/config.json";
const config = JSON.parse(fs.readFileSync(file, "utf8"));
config.state = { ...config.state, dir: ".eval-state" };
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
'
git init -q
echo .eval-state/ >> .git/info/exclude
# The seeding commands lock the plugin's inbox in the state root as well: keep that root in the run folder too.
XDG_STATE_HOME="$(pwd)/.eval-state/root"
export XDG_STATE_HOME
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
plugins/aidrian/bin/aidrian lesson add --tier P1 --kind bug --target project <<'LESSON' >/dev/null
title: Review rounds repeat the same lint finding after it was fixed
The reviewer flagged an unused import that the previous round had already removed.
LESSON
plugins/aidrian/bin/aidrian lesson add --tier P3 --kind improvement --target project <<'LESSON' >/dev/null
title: Worktree bootstrap reinstalls packages on every new worktree
Each new worktree spent four minutes in the package install although the lockfile had not changed.
LESSON
test "$(plugins/aidrian/bin/aidrian lesson list --json | node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(0, "utf8")).length))')" = 2
