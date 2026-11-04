#!/bin/sh
# Exports the committed HEAD of the repository that holds this suite into the run's working folder, without the skill
# under test or the eval suite, as a fresh one-commit repository: no history to read the skill back from, so only the
# plugin arm has it. Points the project's state folder at .eval-state in the run folder, so no audit outside the run is
# read or written, and copies the synthetic bike-shop reports there: a walk that replaces a read-only run, both
# written before sidecars, with the screenshots the walk cites. With `sidecar` as its argument it also imports the
# walk, as the Human would have approved, so the run starts at the questions.
set -eu
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
git -C "$root" archive HEAD -- . ':(exclude)plugins/aidrian/skills/persona-audit-triage' ':(exclude)plugins/aidrian/evals' | tar -x -f -
node -e '
const fs = require("node:fs");
const file = ".aidrian/config.json";
const config = JSON.parse(fs.readFileSync(file, "utf8"));
config.state = { ...config.state, dir: ".eval-state" };
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
'
git init -q
echo .eval-state/ >> .git/info/exclude
XDG_STATE_HOME="$(pwd)/.eval-state/root"
export XDG_STATE_HOME
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
audits=.eval-state/audits
mkdir -p "$audits/front-desk-2026-05-02-2"
cp test/fixtures/persona-audit/front-desk-2026-05-02.md test/fixtures/persona-audit/front-desk-2026-05-02-2.md "$audits/"
# Every screenshot the walk cites, by full path or by suffix.
for n in 10 13 15 20 23 24 25 27 28 29 30 31 32 33 38; do : > "$audits/front-desk-2026-05-02-2/shot-17000000000$n-$n.jpg"; done
: > "$audits/front-desk-2026-05-02-2/shot-1700000000022-22.png"
if [ "${1:-}" = sidecar ]; then
  plugins/aidrian/bin/aidrian audits import front-desk-2026-05-02-2.md --not-rechecked F2,F3 --carried-forward F1 --write >/dev/null
  test -f "$audits/front-desk-2026-05-02-2.json"
fi
plugins/aidrian/bin/aidrian audits list --json >/dev/null
