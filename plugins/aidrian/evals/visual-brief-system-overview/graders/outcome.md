---
type: llm
name: visual-brief-system-overview
focus: trace
criteria: |
  Pass when the run reads a workflow entry point and follows it into the code or tests that account for a completed
  review and a stop or retry. The HTML first explains how project rules, the review engine, reviewers, and the session
  work together. Its main visual shows those handoffs as well as what sends the session back to review. It explains
  what an adopting project supplies. A representative bug, if used, illustrates part of the system.
---
