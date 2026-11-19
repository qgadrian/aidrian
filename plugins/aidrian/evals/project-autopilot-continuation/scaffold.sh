#!/bin/sh
# A project whose run `launch` a driver handed on: the continuation skips turn 1, takes the run with
# `aidrian project wait launch --max-wait 0` first, and, when that refuses, as it does here for whatever cause, stops the loop
# and reports the refusal instead of starting turn 1 over.
set -eu
git init -q -b main
mkdir -p .aidrian
cat > .aidrian/config.json <<'JSON'
{ "version": 1, "tracker": { "provider": "linear", "project": { "values": ["Billing v2"] } }, "projectRun": { "allow": true } }
JSON
printf '# billing\n' > README.md
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
