#!/bin/sh
# Exports the committed HEAD of the repository that holds this suite into the run's working folder, without the skill
# under test or the eval suite, as a fresh one-commit repository: no history to read the skill back from, so only the
# plugin arm has it. Adds this case's plan, points the project's state folder at .eval-state in the run folder, and
# seeds there an open plan-mode ledger at the plan's hash, with three backed objections: one the plan covers, which
# also cites a line that does not support it, one real omission, and one small risk whose asked change is large.
# `aidrian quorum check` must pass it before the run starts.
set -eu
case_dir=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$case_dir" rev-parse --show-toplevel)
git -C "$root" archive HEAD -- . ':(exclude)plugins/aidrian/skills/quorum' ':(exclude)plugins/aidrian/evals' | tar -x -f -
mkdir -p plans
cp "$case_dir/fixture/lesson-list-since.md" plans/lesson-list-since.md
node -e '
const fs = require("node:fs");
const file = ".aidrian/config.json";
const config = JSON.parse(fs.readFileSync(file, "utf8"));
config.state = { ...config.state, dir: ".eval-state" };
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
'
git init -q
echo .eval-state/ >> .git/info/exclude
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
plan="$(pwd)/plans/lesson-list-since.md"
hash=$(git hash-object "$plan")
mkdir -p .eval-state/quorum
ledger=".eval-state/quorum/lesson-list-since-$hash.json"
sed -e "s#__PLAN__#$plan#" -e "s#__HASH__#$hash#" "$case_dir/fixture/ledger.json" > "$ledger"
plugins/aidrian/bin/aidrian quorum check "$ledger" --plan "$plan" | grep -qx 'checked: mode plan, 3 objections, 0 opinion, 0 problems'
