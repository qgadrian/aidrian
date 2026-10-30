# Maintainer tasks. `make` lists them.

.DEFAULT_GOAL := help
.PHONY: help build bump check codex-agents

## List the targets.
help:
	@awk '/^## / { doc = substr($$0, 4); next } /^[a-z-]+:/ && doc { sub(/:.*/, ""); printf "  make %-13s %s\n", $$0, doc } { doc = "" }' $(MAKEFILE_LIST)

## Regenerate the Codex agents from plugins/aidrian/agents/.
build:
	node scripts/build.mjs

## Raise the plugin version in every file that carries it. LEVEL=minor or LEVEL=major; patch by default.
bump:
	node scripts/version.mjs $(LEVEL)

## Run what CI runs. Also checks the real claude and codex commands when they are installed.
check:
	npm run check

## Install the Codex agents from this checkout into ~/.codex/agents. TARGET=dir installs elsewhere.
codex-agents:
	node plugins/aidrian/codex/install-agents.mjs $(if $(TARGET),--target "$$TARGET")
