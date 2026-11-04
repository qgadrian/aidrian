#!/bin/sh
# The import case's scaffold, with the walk's sidecar written and no tracker named: the triage must settle the tracker
# before any finding.
set -eu
exec sh "$(dirname "$0")/../persona-audit-triage-import/scaffold.sh" sidecar no-tracker
