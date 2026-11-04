#!/bin/sh
# The import case's scaffold: the synthetic bike-shop reports in .eval-state, the run's own state folder. A request
# for a new walk, near the triage's words, must stay with persona-audit.
set -eu
exec sh "$(dirname "$0")/../persona-audit-triage-import/scaffold.sh"
