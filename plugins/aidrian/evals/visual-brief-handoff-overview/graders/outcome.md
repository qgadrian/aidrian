---
type: llm
name: visual-brief-handoff-overview
focus: trace
criteria: |
  Pass when the run follows a real handoff entry point into source or tests for a completed handoff and a stop,
  fallback, or retry. The HTML explains the handoff brief, how the next session receives it, and what happens when
  automatic continuation is unavailable. Its main visual explains the handoffs that matter for that decision.
---
