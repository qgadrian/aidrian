#!/bin/sh
# Copies the fixture project into the run's working folder as a fresh one-commit repository, so the fixture is the run
# root: the plugin arm reads its knowledge through the plugin, and the baseline arm sees the same files without it.
set -eu
# A git variable inherited from the caller would point git init and commit at another repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
cp -R "$(dirname "$0")/fixture/." .
git init -q
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
