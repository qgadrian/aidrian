# Merge strategy

Read in step 0, once the run's choices are set, to pick the strategy step 2 merges with.

Read the allowed strategies with `gh repo view <owner>/<repo> --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed`.
Stop when the chosen strategy is not allowed. With none chosen, or a null `strategy`, use the one allowed strategy,
or with several, `squash`, then `merge`, then `rebase`.
