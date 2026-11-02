#!/bin/sh
# Exports this case's committed fixture/, a consumer project already set up for aidrian, into the run's working
# folder as a fresh one-commit repository.
# The fixture is not this repository, so the run holds no copy of the plugin to read the skill back from:
# only the plugin arm has it. Reads HEAD, so commit the case before running it.
set -eu
case_dir=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$case_dir" rev-parse --show-toplevel)
rel=${case_dir#"$root"/}
git -C "$root" archive "HEAD:$rel/fixture" | tar -x -f -
git init -q
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
