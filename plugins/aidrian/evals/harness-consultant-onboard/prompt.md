---
name: harness-consultant-onboard
max_turns: 80
timeout_seconds: 1800
allowed_tools: [Read, Glob, Grep, Skill, Bash, Agent, Write, Edit, AskUserQuestion]
---

Set this project up for aidrian, the whole thing, in this session. My answers up front, so there is nothing to ask:
we use no issue tracker; the Codex bot does not review our pull requests; our docs are in `docs`;
keep the default names for the human and the AI; turn the main-checkout guard on;
and no team settings file: each of us installs the plugin on our own machine.
Write the docs you propose as shown, no need to check with me first. Don't commit anything; tell me what to commit.
