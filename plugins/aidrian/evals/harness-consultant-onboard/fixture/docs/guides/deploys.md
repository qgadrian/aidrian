# Deploys

The tool ships as a container image built from the main branch.

1. Merge to main after the tests pass.
2. The CI workflow builds the image and tags it with the commit.
3. Roll back by redeploying the previous tag; never edit a running container.
