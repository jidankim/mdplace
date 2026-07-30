# Two-stage Captured Tab Note intake prototype

> THROWAWAY PROTOTYPE — this is not production capture or ingestion code.

## Question

Does the agreed two-stage state model keep stock Obsidian Web Clipper output
recoverable and non-authoritative while allowing mdplace to promote only
validated Captured Tab Notes?

The prototype exercises the decisions made while resolving
“Prototype the Captured Tab Note and Web Clipper contract”:

- Web Clipper is a Capture Source, not a Capture Adapter.
- It writes a Capture Candidate to protected local intake.
- mdplace validates, sanitizes, normalizes, hashes, and promotes the candidate.
- Only a promoted Captured Tab Note enters the Inbox.
- Failed candidates remain recoverable and explain why they failed.

## Run

```sh
bash prototypes/captured-tab-note-two-stage-intake/prototype.sh
```

Each key selects one difficult case and renders the complete resulting state.
The two JSON files are importable stock Web Clipper template variants:

- `mdplace-web-clipper-candidate-url-withheld.json` is the default.
- `mdplace-web-clipper-candidate-url-retained.json` requires a Source Profile
  with protected local URL-retention permission.

Neither template creates a Captured Tab Note. They create untrusted candidates
only.

## Contract represented

- Candidate destination:
  `.mdplace/intake/web-clipper/pending`
- Candidate behavior: `create`
- Candidate filename:
  `candidate-{{date|date:"YYYYMMDD-HHmmss-SSS"}}`
- Promoted filename:
  `YYYYMMDD-HHmmss--<safe-title-or-Untitled>--<candidate-hash-prefix>.md`
- Live selection: invalid candidate
- Saved highlights: optional Annotation Stream with unknown origin
- Remote images: converted to inert references; localization is deferred
- Pre-file stock extraction failure: no candidate and no mdplace receipt
- Promotion: journaled, hash-bound, idempotent, and recoverable

Full source, policy, validation, normalization, and promotion receipts belong
in the canonical ledger. The promoted Markdown contains only the portable
bridge fields agreed in the ticket.
