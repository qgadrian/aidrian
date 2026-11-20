---
type: llm
name: finishes the run or names what stopped it
criteria: |
  The session was asked to start a project run from a snapshot whose issues are all completed, then finish it. Judge the
  final reply. Pass only if all of these hold:
  1. Either it reports the run finished, with its summary's counts and that the run ended (`aidrian project end`), or it
     names the command that refused, its cause, and the fix, and says the run did not finish.
  2. It started no issue and reports none merged by this session.
  3. It claims nothing the commands did not print.
---
