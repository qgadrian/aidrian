#!/bin/sh
# The import case's scaffold, with the walk's sidecar written: the synthetic bike-shop reports in .eval-state, the
# run's own state folder, and the triage starting at the questions.
set -eu
exec sh "$(dirname "$0")/../persona-audit-triage-import/scaffold.sh" sidecar
