# Draft editing benchmark

Run `node scripts/draft-benchmark.cjs` from the repository, or pass its path as the first argument. The script archives baseline commit `4468985c4e312628beace0cef42c7a1e73a9660b` into temporary scratch, copies the current source, links the installed dependencies, and uses each version's real `DraftEditing` and `LibraryStore`. It prints the path to its raw results. [Recorded raw results](draft-benchmark-results.json) include all samples and candidate source hashes.

The fixture contains 30,000 clips, each with `Clip ${i} ` followed by 1,024 `x` characters, and occupies 35,775,821 bytes as formatted JSON. Each workload has one warmup, then three measured replicates with alternating version order. The process was Node v24.11.0 on macOS x64. A 1 ms interval measures the maximum elapsed gap between callbacks. Each durable write uses atomic file replacement and fsync. Write counts wrap the actual persistence function. Results depend on storage, scheduling, and cache state.

| Workload                                                        | Baseline median wall / max gap | Candidate median wall / max gap | Baseline / candidate writes |
| --------------------------------------------------------------- | ------------------------------ | ------------------------------- | --------------------------- |
| Sequential: five edits, `whenIdle` after each                   | 2,346 / 250 ms                 | 1,004 / 168 ms                  | 5 / 5                       |
| Burst: 20 immediate edits, then `whenIdle`                      | 937 / 252 ms                   | 214 / 168 ms                    | 2 / 1                       |
| Sustained: 20 edits at nominal 20 ms intervals, then `whenIdle` | 2,743 / 251 ms                 | 1,171 / 166 ms                  | 6 / 5                       |

The baseline's real editor already coalesces changes while a write is in flight: its 20-edit burst produces two writes here, not 20. `whenIdle` forces pending work without waiting for the candidate's 100 ms scheduling delay; the delay bounds scheduling from first dirty input, not durability. The runner reproduces IPC response envelopes without Chromium transport or renderer work. The JSON-encoded accepted-update response size estimate was 34,035,866 bytes for baseline and 84 bytes for the candidate; these are not measured wire bytes. Timer gaps are process event-loop observations, not renderer frame measurements.

The stored hashes identify the measured store, editor, and bridge source. After measurement, the store gained a read-only shortcut accessor outside the measured draft write path, and the UI gained a post-render scroll effect; the timing run was not repeated for those changes.

Whole-collection JSON serialization remains on the main thread, and the measured gaps show substantial residual stalls. A worker-owned collection and persistence path remains an open follow-up; this benchmark does not establish a complete blocking fix.
