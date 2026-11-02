#!/bin/sh
# Exports this case's committed fixture/, a consumer project set up for aidrian with no testing doc, into the
# run's working folder as a fresh one-commit repository.
# The fixture is not this repository, so the run holds no copy of the plugin to read the skill back from:
# only the plugin arm has it. Reads HEAD, so commit the case before running it.
set -eu
case_dir=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$case_dir" rev-parse --show-toplevel)
rel=${case_dir#"$root"/}
git -C "$root" archive "HEAD:$rel/fixture" | tar -x -f -
# The instruction files are written here, not kept in fixture/: this repository tracks AGENTS.md and CLAUDE.md
# only at its root and in the example, so no session in it loads a fixture as its own instructions.
cat > AGENTS.md <<'EOF'
# Pantry tracker

A small Node.js tool that lists the pantry items that run out soon.

Project rules live in knowledge buckets, indexed in `.aidrian/knowledge/`.
Load them with the `knowledge` skill before you plan, edit, or review.
EOF
printf '@AGENTS.md\n' > CLAUDE.md
git init -q
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
