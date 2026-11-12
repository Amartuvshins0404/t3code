# Merge lanes and the outcome ledger

Every pull request into `amaraa-mode` gets one `lane:*` label from the Merge Lane workflow:

- `lane:green`: documentation only.
- `lane:amber`: ordinary app and package code.
- `lane:red`: always a maintainer's call: migrations, contracts, auth, deploys and releases, build config, product defaults, text models read, dependencies, and anything that loosens a gate.

The rules and the reason behind each label are in [merge-lane.cjs](../../.github/scripts/merge-lane.cjs). The job summary of each run explains the lane in plain words.

## What is easy to get wrong

- **The base branch judges.** The workflow runs on `pull_request_target`, checks out the base commit, and reads the PR's files and patches from the GitHub API. It never checks out or runs PR code. A PR that edits the rules is judged by the old rules, so a rule change takes effect only after it merges. It also means the workflow first runs on the PR after the one that adds it.
- **Unknown is red.** A path no rule matches is red, and so is a code file GitHub sends without a patch, since a loosened check cannot be ruled out. When a new top-level directory or config file appears, add a rule for it, or every PR that touches it stays red.
- **It only reports.** The label is not a required check. Nothing merges, blocks, closes or reverts because of it. The workflow does not run outside `Amartuvshins0404/t3code`.
- **Suppressions make a change red, except the two the repo requires.** An added `oxlint-disable`, `eslint-disable`, `@ts-ignore`, `@ts-expect-error` or `@effect-diagnostics` line counts as loosening a gate. Two forms pass: the `t3code/no-unreasoned-state-sync` comment with its reason, and `@effect-diagnostics nodeBuiltinImport:off` alone in a test file or a `scripts/` directory. A reason on any other suppression changes nothing, because whoever wrote the change can always write one.

Judge any commit, range or working tree locally:

```sh
node .github/scripts/merge-lane.cjs HEAD
node .github/scripts/merge-lane.cjs fork/amaraa-mode..HEAD
node .github/scripts/merge-lane.cjs --worktree-base fork/amaraa-mode --cwd ../other-worktree
node .github/scripts/merge-lane.cjs --pr 12 --repo Amartuvshins0404/t3code
```

`--pr` reads the same API data the workflow reads and changes nothing on GitHub.

## Outcome ledger

The ledger measures which merged changes later needed repair. It reads only git history, and PR labels when you pass `--repo`.

```sh
vp run report:merge-ledger --branch fork/amaraa-mode --repo Amartuvshins0404/t3code --out ../ledger
vp run report:merge-ledger --branch origin/main --since "30 days ago"
```

A change escaped when a later commit reverts it, or when a later `fix` commit within `--window` days (default 14) rewrites code it wrote. The ledger runs `git blame -w -M -C` on the fix's parent over the code lines the fix changes or deletes, and links the fix to a change only when that change wrote at least half of those lines. Blank and comment-only lines, tests, docs, lockfiles, generated files and vendored `.repos/` are left out. Escape rates count only changes whose window has passed. Thirty days of upstream history take under two minutes.

**How far to trust it.** Against 59 upstream fixes labelled by hand (2026-11-12), 5 of the ledger's 11 links were right, and it found 5 of the 7 fixes that repaired a change from the previous 14 days. About half the escapes it lists are wrong, and it counts about 1.5 times as many recent repairs as hand reading. The report also gives the share of fix commits linked to a recent change, the figure to compare with hand reading, where 15 of 120 upstream fixes (12.5%) repaired one. With 7 recent repairs behind the figures, a rate is rough: trust a gap between two lanes or areas only when it is large and both have many mature merges.

What blame cannot do, whatever the rules:

- A fix whose lines a recent change last wrote looks like a repair of that change, even when the fault is older or the fix is polish. This causes most of the wrong links that remain.
- A fix that only adds lines, such as a missing guard or case, links to nothing.
- A fix that repairs code older than the window is not counted, by design.
- Without `--repo`, lanes are recomputed with today's rules, not the label the change had when it merged.

### Checking a rule change

`--score <labels.json>` adds a section that compares the ledger's links with hand labels: link precision and recall, how many labelled recent repairs it found, and how many fixes it counts as recent repairs against the labelled count, each with the numbers behind it. The labels file holds `{ "records": [{ "fix", "kind", "culprits" }] }`, where `kind` is `repair-recent`, `repair-old`, `not-repair` or `unsure`, and `culprits` are the full SHAs of the changes the fix repairs. Run it over a range that starts at least 14 days before the oldest labelled fix, or the culprits are not in the list:

```sh
vp run report:merge-ledger --branch ee90bdc9405d8d4b8ff78ce2133ccb04844298ab --since 2026-09-28 --until 2026-11-12T09:18:38Z --score labels.json
```

A new rule has to hold for fixes nobody labelled. Keep half the labels out of tuning and score the rule on them before you trust it. When the figures change, update the "How sure" text in `scripts/merge-ledger.ts` and this section.
