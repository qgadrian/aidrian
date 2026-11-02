#!/bin/sh
# Exports the committed HEAD of the repository that holds this suite into the run's working folder, without the skill
# under test or the eval suite, as a fresh one-commit repository: no history to read the skill back from, so only the
# plugin arm has it. Points the project's state folder at .eval-state in the run folder, so no inbox outside the run is
# written, seeds that inbox with one open lesson through the CLI, and keeps a fresh triage record on it, as an earlier
# triage in this checkout would have.
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
id=$(plugins/aidrian/bin/aidrian lesson add --tier P2 --kind rule --target project <<'LESSON' | head -n 1
title: Sessions forget the quartzwick rule for lesson titles
Two sessions this week wrote lesson titles without the quartzwick prefix, and triage could not group them.
LESSON
)
plugins/aidrian/bin/aidrian lesson update "$id" --triage - <<'TRIAGE' >/dev/null
{"existing": ["docs/lessons.md"], "proposed_end": "Fix now", "owner": "harness-librarian", "expect": "no new occurrence", "verdict": null, "reason": null}
TRIAGE
plugins/aidrian/bin/aidrian lesson list --json | node -e '
const [lesson] = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
if (lesson?.triage?.proposed_end !== "Fix now") throw new Error("the seeded triage record does not read back fresh");
'
