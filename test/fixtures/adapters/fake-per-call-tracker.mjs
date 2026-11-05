// A tracker that does not exist, shaped like Jira's connector, to prove the case Linear does not have: each call names its own
// workspace, so nothing needs a session read, its one read lists every site, and an issue can go by a bare number. Never shipped;
// test/adapters.test.mjs passes it in.

export default {
  id: 'faketickets',
  name: 'Fake Tickets',
  servers: {
    any: ['faketickets'],
    'claude-code': ['claude_ai_FakeTickets'],
    codex: ['codex_apps_faketickets'],
  },
  // Each write carries the site it goes to, and the read that could say which is connected lists them all.
  workspaceInput: 'cloudId',
  writeVerbs: ['createTicket*', 'editTicket*', 'transitionTicket*', 'executeWrite'],
  readVerbs: ['getTicket*', 'listSites', 'lookupAccount*', 'executeRead'],
  team: { createFields: ['projectKey'], keyFields: ['ticketIdOrKey'] },
  idHint: 'use the ticket\'s key, or its number when it has none',
  opaqueIdLimit: 'A bare number such as 10042 names no project, so the team check skips it: a write by number to another project passes.',
  unguardedRoutes: [{ name: 'executeWrite', reason: 'its arguments nest the real tool and its fields, which the guard does not read' }],
};
