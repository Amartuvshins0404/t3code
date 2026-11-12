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
- **Suppressions make a change red.** An added `oxlint-disable`, `eslint-disable`, `@ts-ignore`, `@ts-expect-error` or `@effect-diagnostics` line counts as loosening a gate, including the reasoned `t3code/no-unreasoned-state-sync` comments AGENTS.md asks for.

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

A change escaped when a later commit reverts it, or when a later `fix` commit within `--window` days (default 14) changes or deletes lines it introduced, found with `git blame -w` on the fix's parent. Tests, docs, lockfiles, generated files, vendored `.repos/` and whitespace-only edits are ignored. Escape rates count only changes whose window has passed. Thirty days of upstream history take about a minute.

Read the numbers as an upper bound with noise:

- A fix that edits a recent line on the way to repairing something else counts as an escape.
- A fix that only adds lines, such as a missing guard, links to nothing.
- Code that a refactor moved is blamed on the refactor, not on the change that wrote it.
- A fix that repairs code older than the window is not counted, by design.
- Without `--repo`, lanes are recomputed with today's rules, not the label the change had when it merged.
