# Issue trackers

The project's `issue_tracker` knowledge names the tracker and its details: key format, branch names, status names,
estimate scale, labels, and closing keyword. This file maps each issue step to the tool of the two trackers the plugin knows.
For another tracker, use the tools that knowledge names for the same steps; with none, write nothing and return a draft.

When the knowledge names no tracker, the reference decides: `ABC-123` or a `linear.app` URL is Linear;
`#123`, `owner/repo#123`, or a `github.com/<owner>/<repo>/issues/<n>` URL is GitHub Issues.
Never search a tracker to guess a key.

| Step | Linear: the host's Linear tools | GitHub Issues: `gh` |
| --- | --- | --- |
| The key, `<key>` | `ABC-123`; from a URL, the key in it | the number, `123`; add `--repo owner/repo` for another repository |
| In a commit or body line | `Refs ABC-123`, `Fixes ABC-123` | `Refs #123`, `Fixes #123` |
| In a path, such as a plan | the key in lowercase, `abc-123` | the number, `123` |
| Read | `get_issue` with relations, then `list_comments` | `gh issue view <n> --json number,title,body,state,stateReason,labels,assignees,milestone,comments,url,updatedAt,parent,subIssues,blockedBy,closedByPullRequestsReferences` |
| Closed | `statusType` `completed`, `canceled`, or `duplicate` | `state` `CLOSED` |
| Blocked by | `relations.blockedBy` | `blockedBy.nodes`, each with its `state`, and the issues the body's dependencies section names |
| Linked pull requests | the pull request links in `get_issue`'s `attachments` | `closedByPullRequestsReferences`, which has no state: read each with `gh pr view <url>` |
| Assigned to the current user | the assignee is `get_user` for `me` | `assignees` holds `gh api user --jq .login` |
| Branch | the issue's `gitBranchName`, as it is | the branch format the knowledge names |
| Move to In Progress | `save_issue` with the started status | the label or project status the knowledge names; none named: skip |
| Edit the body: tick a box, patch a size | `save_issue` with `description` | `gh issue edit <n> --body-file <file>` |
| Comment | `save_comment` | `gh issue comment <n> --body-file <file>` |
| Estimate | `save_issue` with `estimate` | the label or project field the knowledge names; none: the size line in the body |
| Create | `save_issue`, by the `agent-issue-writer` skill's `references/linear.md` | `gh issue create --title <title> --body-file <file>`, plus `--label` and `--milestone` |
| Parent and children | `parentId` on each child | read: `parent` and `subIssues.nodes`, each with its `state`, and the body lines this cell writes; write: the parent's body lists each child as `- [ ] #<n>`; each child's body names its parent |
| A group of issues | a Linear Project | the milestone or GitHub project the knowledge names |

Write a body from a file, never inline: the shell then cannot mangle Markdown, quotes, or backticks.
Read the issue once per run and keep that snapshot; read it again only when the Human asks.
