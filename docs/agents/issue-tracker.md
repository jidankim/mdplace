# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Create, read, list, comment on, label, and close issues using `gh issue`.
- Infer the repository from the current Git remote.
- PRs are not treated as a triage request surface.

## Publishing and retrieval

- “Publish to the issue tracker” means create a GitHub issue.
- “Fetch the relevant ticket” means read the issue and its comments.

## Wayfinding operations

- A map is an issue labelled `wayfinder:map`.
- Tickets are GitHub sub-issues carrying `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- Use GitHub native issue dependencies for blocking relationships.
- The frontier consists of open, unblocked, unassigned child issues.
- Claim a ticket by assigning it before beginning work.
- Resolve a ticket by posting a self-contained answer and evidence in an issue comment, closing the ticket, and linking the durable result from the map’s Decisions-so-far section.
- The map may link the resolved ticket or comment, a committed document, or a committed prototype. Use a Gist only when an in-repository artifact is unsuitable and the user explicitly authorizes the publication, visibility, and secret/PII-redaction boundary.
- If sub-issues or native dependencies are unavailable, fall back to map task lists and `Blocked by:` lines.
