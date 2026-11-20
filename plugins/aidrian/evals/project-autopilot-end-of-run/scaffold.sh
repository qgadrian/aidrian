#!/bin/sh
# A project whose tracker project is all done: the driver inits the run from a snapshot of completed issues, finds
# `next` says done, and finishes: report, summary, end, then the final report. The state folder is committed in
# config.json, outside the checkout, so every command resolves the same one.
set -eu
state="$(cd .. && pwd)/state"
mkdir -p "$state"
git init -q -b main
mkdir -p .aidrian
cat > .aidrian/config.json <<JSON
{ "version": 1, "state": { "dir": "$state" }, "tracker": { "provider": "linear", "project": { "values": ["Billing v2"] } }, "projectRun": { "allow": true } }
JSON
cat > snapshot.input <<'JSON'
{ "issues": [
  { "key": "ENG-1", "branch": "feat/eng-1-export", "status": "completed", "priority": 1 },
  { "key": "ENG-2", "branch": "feat/eng-2-import", "status": "completed", "blockedBy": ["ENG-1"] }
] }
JSON
printf '# billing\n' > README.md
printf 'snapshot.input\n' > .gitignore
git remote add origin https://github.com/acme/billing.git
git add README.md .gitignore .aidrian/config.json
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
git update-ref refs/remotes/origin/main HEAD
