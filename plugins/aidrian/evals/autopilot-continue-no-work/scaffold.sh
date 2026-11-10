#!/bin/sh
# Exports the committed HEAD of the repository that holds this suite into the run's working folder, without the skill
# under test or the eval suite, as a fresh one-commit repository: no history to read the skill back from, so only the
# plugin arm has it. The run folder is a clean main checkout on the default branch, with no task worktree, no task
# branch, and no plan: a session with nothing under way.
set -eu
case_dir=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$case_dir" rev-parse --show-toplevel)
git -C "$root" archive HEAD -- . ':(exclude)plugins/aidrian/skills/autopilot' ':(exclude)plugins/aidrian/evals' | tar -x -f -
git init -q -b main
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
