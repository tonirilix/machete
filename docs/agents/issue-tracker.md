# Issue tracker: Local Markdown

Issues and specs live in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`.
- Specs live at `.scratch/<feature-slug>/spec.md`.
- Implementation issues have individual files:
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`,
  numbered from `01`.
- Record triage state in a `Status:` line near the top
  of each issue. Use the strings in `triage-labels.md`.
- Append discussion under a `## Comments` heading.

## Publishing

When a skill says to publish to the issue tracker, create
the appropriate spec or issue file using these conventions.

## Reading

When a skill says to fetch a ticket, read its referenced file.
Resolve issue numbers within the relevant feature directory.
Ask for clarification if the reference is ambiguous.
