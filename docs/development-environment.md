# Development environment

## GitHub CLI authentication in managed sandboxes

Managed network sandboxes can make `gh auth status` or GitHub API calls report an invalid token or a connection failure even when the stored credentials are valid.

Before diagnosing GitHub authentication as broken, rerun the relevant `gh` command outside the network sandbox with the required approval. Do not persist credentials or unredacted authentication output in repository artifacts.
