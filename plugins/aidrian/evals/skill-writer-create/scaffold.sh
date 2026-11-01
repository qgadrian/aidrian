#!/bin/sh
# Clones the repository that holds this eval suite into the run's working folder, at its committed HEAD, then removes
# the skill under test, so only the plugin arm has it and the no-plugin baseline cannot read it from the checkout.
set -eu
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
git clone -q --depth 1 "file://$root" .
rm -rf plugins/aidrian/skills/skill-writer evals 2>/dev/null || true
rm -rf plugins/aidrian/evals
