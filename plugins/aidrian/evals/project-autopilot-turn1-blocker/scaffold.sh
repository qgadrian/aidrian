#!/bin/sh
# A fresh project whose config names one tracker project, and whose team has not allowed project runs: turn 1 must run
# the preflight, name every blocker with its fix in one message, and start nothing. No forge or tracker is reachable,
# so the forge's checks are blockers too.
set -eu
git init -q -b main
mkdir -p .aidrian
cat > .aidrian/config.json <<'JSON'
{ "version": 1, "tracker": { "provider": "linear", "project": { "values": ["Billing v2"] } }, "projectRun": { "allow": false } }
JSON
printf '# billing\n' > README.md
git remote add origin https://github.com/acme/billing.git
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
