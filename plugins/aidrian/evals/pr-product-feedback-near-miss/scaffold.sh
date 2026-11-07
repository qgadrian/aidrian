#!/bin/sh
# The trigger case's scaffold: the bike shop, member pull request 5, and a gh that posts nowhere. A request for a persona
# audit of the pull request, with no word of posting, must stay with persona-audit, which posts nothing.
set -eu
exec sh "$(dirname "$0")/../pr-product-feedback-trigger/scaffold.sh"
