// A tracker that does not exist, to prove that a new tracker is one adapter file. Never shipped: see test/adapters.test.mjs.
// Its verbs, fields, and server names share nothing with Linear's.

export default {
  id: 'faketracker',
  name: 'Fake Tracker',
  servers: {
    any: ['faketracker'],
    'claude-code': [],
    codex: ['codex_apps_faketracker'],
  },
  readTool: 'site_info',
  writeVerbs: ['add_*', 'transition_*', 'edit_ticket'],
  workspaceField: 'baseUrl',
  team: { createFields: ['projectKey'], keyFields: ['ticketKey'] },
  project: { field: 'board' },
  opaqueIdLimit: 'A fixture holds none.',
  unguardedRoutes: [],
};
