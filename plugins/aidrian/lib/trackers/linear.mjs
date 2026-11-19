// Linear's adapter. docs/providers/adding-a-host.md#adding-a-tracker lists the fields, and docs/config.md#tracker says why
// each list holds what it holds.

export default {
  id: 'linear',
  name: 'Linear',
  // The server names a Linear connection is known to show, as lib/hosts/ names them: `any` on every host, then per host.
  servers: {
    any: ['linear', 'linear-server'],
    'claude-code': ['plugin_linear_linear', 'claude_ai_Linear'],
    codex: ['codex_apps_linear'],
  },
  readTool: 'get_workspace',
  // `prepare_*` counts: those tools are the step before file bytes reach the workspace. `mark_notification` stays out,
  // since it changes only one person's inbox.
  writeVerbs: ['save_*', 'create_*', 'delete_*', 'share_*', 'unshare_*', 'update_*', 'merge_*', 'submit_*', 'resolve_diff_thread', 'retire_*', 'restore_*', 'prepare_*'],
  workspaceField: 'url',
  // Relations such as `blocks`, `parentId`, and `duplicateOf` may cross teams, so they stay out of `keyFields`.
  team: { createFields: ['team', 'addTeams', 'setTeams', 'leadTeam'], keyFields: ['id', 'issueId', 'issue'] },
  project: { field: 'project' },
  // A UUID names no team, so the team check skips it: a write by UUID to another team passes.
  idHint: "pass the item's UUID when it is not an issue",
  // Every write tool of its connection is a named tool that reaches the hooks.
  unguardedRoutes: [],
  // The hosts of the endpoints a Linear MCP server answers on, so a server the team names otherwise in
  // projectRun.mcpServers still maps to this adapter (lib/tracker-guard.mjs trackerOfTool).
  endpoints: ['mcp.linear.app'],
  // What a session of a project run may write (lib/tracker-guard.mjs runWriteRefusal), by tool and input field: an
  // update of one issue, which `save_issue` makes only with `id` (without it, it creates), and a new comment on one.
  // `state` takes a status type as well as a name or id: an issue's session may set only `started`, and the driver's
  // report sets `done`, which the tracker maps to the team's first completed status. `fields` are what an issue's own
  // session may also set; `text` the fields whose text the guard checks, with the comment's body. A `parentId` or `id`
  // on a comment, a reply or an edit, is none of these. `labelRead` and `statusRead` list a team's labels and statuses,
  // which the driver reads in its first turn.
  run: {
    issue: { tool: 'save_issue', key: 'id', status: 'state', label: 'addLabels', started: 'started', done: 'completed', fields: ['estimate', 'patch'], text: ['patch'] },
    comment: { tool: 'save_comment', key: 'issueId', body: 'body' },
    labelRead: 'list_issue_labels',
    statusRead: 'list_issue_statuses',
  },
  // Tools that merge code, refused on a tracker server to every session: a merge goes through `gh pr merge`, which the
  // merge guard judges, and for a session no Human attends only through pr-auto-merge. A name that matches on any other
  // server is refused to a session no Human attends.
  mergeVerbs: ['merge_*'],
  // Calls that mark a pull request ready for review, refused as a merge is: `gh pr ready` is the route the ready hold
  // judges.
  readyCalls: [{ tool: 'update_diff', field: 'statusAction', values: ['markReadyForReview'] }],
};
