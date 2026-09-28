# Issue tracker: GitHub

Issues and PRDs for this repository live in GitHub Issues at `akhilasuraj/starlink-dashboard`. Use the `gh` CLI from this checkout, or pass `-R akhilasuraj/starlink-dashboard` explicitly.

## Issue operations

- Create: `gh issue create --title "..." --body-file <path>`; use a temporary UTF-8 file for a multiline body.
- Read: `gh issue view <number> --json number,title,body,labels,comments,state` (the JSON response includes comments).
- List: `gh issue list --state open --json number,title,body,labels` with appropriate filters.
- Comment: `gh issue comment <number> --body-file <path>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

When a skill says to publish a PRD or create a ticket, create a GitHub issue. When it says to fetch a ticket, read the corresponding issue and its comments. Use the state labels from `docs/agents/triage-labels.md`.

## Pull requests as a triage surface

External PRs are **not** a request surface for triage. Triage GitHub issues only. Review PRs when a user explicitly requests a PR review.

## Related issues and dependencies

Use GitHub sub-issues or a task list in a parent issue to record child work. For a blocker, use GitHub's issue dependency feature when available; otherwise add a `Blocked by: #<number>` line to the dependent issue. Do not treat an issue as ready for independent work while an open blocker remains.
