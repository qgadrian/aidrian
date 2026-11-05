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
};
