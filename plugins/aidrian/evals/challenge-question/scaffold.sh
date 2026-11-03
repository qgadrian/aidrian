#!/bin/sh
# Exports the committed HEAD of the repository that holds this suite into the run's working folder, without the skill
# under test or the eval suite, as a fresh one-commit repository: no history to read the skill back from, so only the
# plugin arm has it. Adds this case's plan, the one the prompt names.
set -eu
case_dir=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$case_dir" rev-parse --show-toplevel)
git -C "$root" archive HEAD -- . ':(exclude)plugins/aidrian/skills/challenge' ':(exclude)plugins/aidrian/evals' | tar -x -f -
mkdir -p plans
cp "$case_dir/fixture/lesson-dedupe.md" plans/lesson-dedupe.md
git init -q
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
