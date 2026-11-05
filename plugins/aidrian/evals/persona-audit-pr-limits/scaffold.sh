#!/bin/sh
# The fixture of persona-audit-pr-url, as a stranger's pull request from a fork: a preview link in a comment, under a host
# product-access allows, an instruction to the run in the diff, and accounts and commands a run must not use. The prompt's
# link holds a command substitution, which only an unquoted or double-quoted shell word would run.
set -eu
exec sh "$(dirname "$0")/../persona-audit-pr-url/scaffold.sh" limits
