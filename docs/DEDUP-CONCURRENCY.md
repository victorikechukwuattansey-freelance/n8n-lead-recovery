# Known limitation: outreach dedup suppression is not atomic across runs

**Status:** open, not decided. No code change is proposed or made by this note.
**Scope:** `Outreach Execution & Delivery V1` — `src/execution.js`.

## Summary

`DUPLICATE_SUPPRESSED` is a correct *report* of a check that is not atomic
against a concurrent writer. Suppression is derived from an in-memory snapshot
of the Outreach Log taken at the start of a run. Two overlapping runs can each
read the log before either has written its row, each find the
`(lead_id, channel)` key absent, each pass the gate, and each send.

The guarantee is therefore **per-run, not persisted**.

## Evidence

- `src/execution.js:112` — `buildSentIndex(outreachRows)` builds a `Map` from
  the caller's `outreachRows` snapshot.
- `src/execution.js:494` — `const sentIndex = sentScope.confirmed`.
- `src/execution.js:519` — `gateExecution(item, sentIndex, ...)`.
- `src/execution.js:344` — `sentIndex.has(`${item.lead_id}\0${item.available_channel}`)`.
  A pure in-memory `Map` read; no I/O, no precondition.
- `src/execution.js:567` — the log row is written with
  `sheetsWriter.appendRows(outreachTabName, [logRowToArray(pendingRow)])`.

Grep for `lock|Lease|reserv|mutex|ifGenerationMatch|conditional|etag` across
`src/execution.js` and `src/google-sheets-client.js` returns no concurrency
primitive. (The `BLOCKED` hits in that grep are lead-suppression readiness, an
unrelated concept.) The client's write surface
(`src/google-sheets-client.js:168` `appendRows`, `:185` `updateRow`,
`:204` `deleteRows`) exposes no conditional-write precondition.

## What is already protected

Within a single run, two items sharing `(lead_id, channel)` are held by the
`pending` map — `src/execution.js:154` (`pending.set`) and `:347`
(`pending.has`). The exposure is **cross-run**, not within-run.

## Exposure window

The gate read precedes the log append, and the provider send sits between them.
The unprotected window is therefore the full duration of the send, not a narrow
read-modify-write instant. Slower sends widen it.

## Severity

Low in normal operation, and mitigated by the fact that runs are typically
serialized by a human or a scheduler. It becomes reachable when a run is
triggered concurrently — a manual live run while a scheduled one is in flight,
or two operators in the console at once. The consequence is a duplicate send to
a real recipient, which is the one failure this pipeline exists to prevent, and
it lands in the recipient's inbox rather than in a log.

## Open questions

1. Is there a provider-side idempotency layer absorbing this? "Idempotency-Key"
   in this codebase refers to the sheet-log identity `(lead_id, channel)`
   (`src/execution.js:30`, `:104`), **not** an HTTP header. No Resend call was
   found in `src/`, in `scripts/`, or in the frozen
   `Outreach-Execution-and-Delivery V1.json` — that artifact contains no
   `resend` reference at all. Where the actual send is implemented, and whether
   it sets an HTTP `Idempotency-Key`, is **unverified here**. A provider-side
   key would reduce the real-world impact without fixing the engine-level gap,
   and would be time-bounded by the provider's retention window.
2. If a mitigation is wanted, is serializing runners acceptable, or is a
   reservation row written *before* the send (then reconciled) preferred?

## Remediation options (none implemented)

| Option | Cost | Notes |
| --- | --- | --- |
| Serialize runs (advisory lock row in a tab) | Low | Fits the existing sheet-as-state model; needs stale-lock expiry. |
| Write a `pending` reservation row before the send | Medium | Narrows the window but must reconcile reservations abandoned by a crashed run. |
| Conditional append via `ifGenerationMatch` | Medium | Requires a client change; Sheets etags are per-document, so it would serialize writers rather than dedup per key. |
| Provider-side `Idempotency-Key` header | Low | Cheapest real mitigation, contingent on open question 1. |

## Adjacent observation (separate issue, same review)

`verify:queue` and `verify:dry` both reported an exception with
`severity: "ERROR"` (`OUTREACH_WITHOUT_APPROVAL` for `TEST-PROD-001`) and both
**exited 0**. The gates' exit status does not reflect exception severity, so a
data-consistency error reads as a green gate. The `DUPLICATE_SUPPRESSED` detail
string has a related gap: it names the condition
(`existing committed outreach log row for lead_id+channel; suppressed`,
`src/execution.js:345`) but not the matching row, so diagnosing a suppression
requires a manual cross-reference of the Outreach Log.
