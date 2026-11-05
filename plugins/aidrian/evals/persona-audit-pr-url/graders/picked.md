---
type: llm
name: picks the personas from the diff, up to the cap, and walks without asking
criteria: |
  The project has four personas, in this index order: front-desk, mechanic, parts-buyer, and owner. The pull request
  touches two tasks of front-desk, one of mechanic, one of parts-buyer, and none of owner, and the cap is 2. Judge the
  final reply and the report it names. Pass only if all of these hold:
  1. It says in one line that it picked front-desk and mechanic, and why.
  2. It did not stop to ask which personas to run.
  3. The report's Not reached section lists parts-buyer, over the cap, with its task "Order a part".
  4. The report and its sidecar cover no task of owner, or list them as out of scope, with no finding about them.
  5. The sidecar holds "pr": "acme/bike-shop#5" and "head" with the 40 characters of c the pull request's head has.
---
