# Reaching the product

How a persona-audit run reaches the product, and the evidence level each task gets. Read it before the first task.

## Evidence levels

Use the best evidence the session has, in this order, and record it on every task:

| Level | Means | Web | Mobile | Backend API, CLI, or SDK |
| --- | --- | --- | --- | --- |
| `walked` | The session operated the product and did the task | a browser tool | a simulator or device tool | `curl` or the CLI, at the `product-access` base URL |
| `seen` | Screens or responses exist for it, but no walk | the visual review's captures in the state folder, screenshots on the pull request | screenshots | recorded responses, examples in the API docs |
| `read` | Only code, copy, and locale files | routes, components, strings | screens, string resources | handlers, schemas, error messages |

`walked` needs a tool that both acts and reads the result:

- Web: a browser tool the host lists, such as Claude in Chrome or a Playwright MCP server.
- Mobile: a simulator or device tool that taps and reads the screen, or Maestro, or `adb shell input`.
  A simulator the session can only screenshot is `seen`.
- API or CLI: `curl` or the CLI itself.

No such tool: say so in what the run could not reach, and use `seen` or `read`.

## Which build, with `--pr`

Walk only the pull request's head: its preview URL, or the local app when `git rev-parse HEAD` equals
`gh pr view <number> --json headRefOid`. Any other build is `seen` at best. The report's `Reached:` line names
the build the run reached.

## Before a walk

When `product-access` has `## Before a walk`, run its check before the first task: start the app as it says, confirm
the URL answers, the variables it names are set, its ports are free, and sign-in returns to its hosts.
When the check fails, walk nothing, and put one line in `## Not reached` with what failed.
When `## Where each task lives` names a task, sign in with the account it names; the persona still finds the way there.

## Safety

- Reach the product only the way `product-access` says, and keep to its `## Off limits`.
  Run its reset command before a task that changes data, when it names one.
- A task behind a plan or feature the demo account lacks, as `## Accounts` lists, is `not reached`, with that reason.
- When `product-access` has `## Allowed changes`, any data change it does not list is off limits. Run the reset
  command only against the data it names, and on an environment it marks shared only when it says the reset is safe
  for other sessions. Without that section, reset before a task that changes data, as above.
- Without `product-access`, ask the Human once for a non-production URL and a demo account, and where its password
  is kept, such as an environment variable or a password-manager entry; never ask for the password itself.
  No answer: fall back to `seen` or `read`, and say why in the report.
- Never pay, send a message to a real person, or change data outside the demo account.
- Never write a secret or personal data into the report or a screenshot it cites.
- Start a dev server or simulator in the background, and stop what the run started before the reply.
