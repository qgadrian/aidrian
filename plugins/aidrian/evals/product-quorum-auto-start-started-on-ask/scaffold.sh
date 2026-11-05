#!/bin/sh
# Builds a consumer project in the run's working folder from the fixture of product-quorum-auto-start-off, with no copy of
# the plugin: the route step, knowledge/references/decisions.md, is left out, so the baseline run cannot route and only the
# plugin arm has it. Turns autoStart on with approval review-later, and seeds a complete ledger whose starting route asked, though its ruling resolve would let an agent decide.
# Copies from this folder rather than HEAD, so it runs before the case is committed.
set -eu
case_dir=$(cd "$(dirname "$0")" && pwd)
evals=$(dirname "$case_dir")
aidrian="$evals/../bin/aidrian"
cp -R "$evals/product-quorum-auto-start-off/fixture/." .
cat > .aidrian/config.json <<'JSON'
{
  "version": 1,
  "state": { "dir": ".eval-state" },
  "decisions": { "maxMode": "decide-reversible", "mode": "decide-reversible" },
  "quorum": { "product": { "autoStart": true, "approval": "review-later" } }
}
JSON
git init -q -b main
git config user.name eval
git config user.email eval@example.invalid
git config commit.gpgsign false
echo .eval-state/ >> .git/info/exclude
git add -A
git commit -qm fixture
git switch -q -c task/booking
"$aidrian" check >/dev/null
case_dir_ledger="$case_dir/ledger.json"
question_body="$case_dir/question.md"
hash=$(git hash-object "$question_body")
h7=$(printf %s "$hash" | cut -c1-7)
dir=.eval-state/quorum/product
mkdir -p "$dir/questions"
question="$(pwd)/$dir/questions/when-a-customer-cancels-within-24-hours-$h7.md"
cp "$question_body" "$question"
ledger="$dir/when-a-customer-cancels-within-24-hours-$hash.json"
sed -e "s#__PLAN__#$question#" -e "s#__HASH__#$hash#" "$case_dir_ledger" > "$ledger"
"$aidrian" quorum check "$ledger" --plan "$question" >/dev/null
