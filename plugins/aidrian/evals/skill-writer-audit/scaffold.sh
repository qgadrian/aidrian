#!/bin/sh
# Exports the committed HEAD of the repository that holds this suite into the run's working folder, without the skill
# under test or the eval suite, as a fresh one-commit repository: no history to read the skill back from, so only the
# plugin arm has it.
set -eu
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
git -C "$root" archive HEAD -- . ':(exclude)plugins/aidrian/skills/skill-writer' ':(exclude)plugins/aidrian/evals' | tar -x -f -
git init -q
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
