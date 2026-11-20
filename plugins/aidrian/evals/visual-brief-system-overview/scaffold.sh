#!/bin/sh
# Export tracked sources and use the checked-out skill directly. Run these cases with --ablation none.
set -eu
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
git -C "$root" archive HEAD -- . ':(exclude)plugins/aidrian/evals' | tar -xf -
skill=plugins/aidrian/skills/visual-brief
cp -R "$root/$skill/." "$skill/"
git init -q
git add -A
git -c commit.gpgsign=false -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture
