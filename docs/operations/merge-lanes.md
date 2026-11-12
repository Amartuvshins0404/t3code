# Merge lanes and the outcome ledger

Every pull request into `amaraa-mode` gets one `lane:*` label from the Merge Lane workflow:

- `lane:green`: documentation only.
- `lane:amber`: ordinary app and package code.
- `lane:red`: always a maintainer's call: migrations, contracts, auth, deploys and releases, build config, product defaults, text models read, dependencies, and anything that loosens a gate.

The rules and the reason behind each label are in [merge-lane.cjs](../../.github/scripts/merge-lane.cjs). The job summary of each run explains the lane in plain words.

## What is easy to get wrong

- **The base branch judges.** The workflow runs on `pull_request_target`, and again from `amaraa-mode` when Blind Checks finishes. It checks out base branch code and reads the PR's files and patches from the GitHub API. It never checks out or runs PR code. A PR that edits the rules is judged by the old rules, so a rule change takes effect only after it merges. It also means the workflow first runs on the PR after the one that adds it.
- **Unknown is red.** A path no rule matches is red, and so is a code file GitHub sends without a patch, since a loosened check cannot be ruled out. When a new top-level directory or config file appears, add a rule for it, or every PR that touches it stays red.
- **It only reports until you switch it on.** Nothing merges, closes or reverts because of the label. With the switch in [Locked checks](#locked-checks-and-repairs-lines) on, the Merge lane check fails on a red lane. The workflow does not run outside `Amartuvshins0404/t3code`.
- **Suppressions make a change red, except the two the repo requires.** An added `oxlint-disable`, `eslint-disable`, `@ts-ignore`, `@ts-expect-error` or `@effect-diagnostics` line counts as loosening a gate. Two forms pass: the `t3code/no-unreasoned-state-sync` comment with its reason, and `@effect-diagnostics nodeBuiltinImport:off` alone in a test file or a `scripts/` directory. A reason on any other suppression changes nothing, because whoever wrote the change can always write one.

Judge any commit, range or working tree locally:

```sh
node .github/scripts/merge-lane.cjs HEAD
node .github/scripts/merge-lane.cjs fork/amaraa-mode..HEAD
node .github/scripts/merge-lane.cjs --worktree-base fork/amaraa-mode --cwd ../other-worktree
node .github/scripts/merge-lane.cjs --pr 12 --repo Amartuvshins0404/t3code
```

`--pr` reads the same API data the workflow reads and changes nothing on GitHub.

## Locked checks and Repairs: lines

An agent that writes both the code and its tests proves little when the tests pass. So for amber work, a fresh agent that has seen only the request writes the tests first, the lane bot locks them, and the [Blind Checks](../../.github/workflows/blind-checks.yml) job proves they fail without the code and pass with it.

The contract a pull request follows:

- The body has a `## Request` section: the request and any agreed decisions, with no code plan. The checks are judged against it.
- The first commit is the checks commit. It changes only test and test-support files and carries a `Blind-checks: <note>` trailer. When the repo's [Verifying](../../AGENTS.md#verifying) rules say no test is needed (a visual fix, copy text, types only, a pure refactor), the first commit is empty and says `Blind-checks: none, <reason>`.
- A fix, meaning a title that starts with `fix:` or `fix(scope):`, has a `Repairs:` line naming the commits or merged pull requests on `amaraa-mode` it repairs, such as `Repairs: 6fceb557b2, #5`, or `Repairs: none, older than 14 days`. Each target must already be in the history the fix was built on. Commit times do not count. This applies in every lane.

Test and test-support files are the paths the ledger already leaves out as tests (`TEST_SUPPORT` in [merge-lane.cjs](../../.github/scripts/merge-lane.cjs)).

Green pull requests are exempt from the checks rules. A red one gets them only when it has a checks commit, since you read red work anyway. An amber one with no checks commit and no `none` line turns red as "not checked blind". Each broken rule turns the lane red with its own reason. A changed lock also lists each locked test file with its old and new test names.

### What is easy to get wrong

- **The lock is a bot comment.** The first time the lane bot sees a checks commit it saves a fingerprint of it in a comment by `github-actions[bot]`. A comment by anyone else is ignored. The fingerprint covers the trailer and the lines the commit adds and removes, not its SHA, so rebasing onto a newer `amaraa-mode` keeps the lock. Rewriting the commit's content does not.
- **Revising checks is red on purpose.** A later commit with a `Blind-checks:` trailer is a revision, which is red and yours to judge. A later commit that touches a test file without the trailer is red as tampering. Putting a locked test file back as it was counts too.
- **The proof job runs pull request code.** It runs on `pull_request` with read-only contents and no secrets, which is why it is separate from the lane bot. It runs the judge script from the base branch, but the workflow file comes from the pull request, so a pull request can still change the job. Doing so makes the lane red.
- **A test file that cannot load counts as failing only if it loads with the code.** Without the code, an import of a missing module fails the whole file. The judge accepts that only when the same file loads and passes at the head, because both runs use the test files as they are at the head. A file that fails to load both times is a broken setup. A file that cannot load hides whether each test in it would have failed on its own.
- **`vp test run` skips a path it does not know.** The judge treats a test file with no result as not run, never as passed.
- **It reports until you switch it on.** The repository variable `BLIND_CHECKS_MODE=required` makes the Merge lane check fail when the lane is red for any reason except test strength, and makes Blind checks fail when the proof does not hold. Only the pull request's own run can fail. The run after Blind Checks finishes never fails. Any other value only reports. Nothing blocks a merge until both checks are required on `amaraa-mode`.

### What it cannot prove

- That the checks agent was blind. It could read other threads or branches, and the request could carry a code plan.
- That a check is strong. Failing first only proves that a check tests something that did not exist yet. A weak check still passes.
- That the markers are honest. An agent with the owner's token can write a `Blind-checks:` trailer, edit the bot's comment, remove a label or loosen the ruleset. Each leaves a trail in the commit, the comment's edit history or the audit log, and none of them can be stopped.
- That the code is general. The coder can special-case the test inputs, or change code under `src/` that the tests rely on.
- That the lock came early. A draft pull request opened late lets the lock record checks that were already rewritten.

### Test strength

After the proof, the Blind Checks job breaks the JavaScript and TypeScript lines the pull request changed, one small change at a time, with [Stryker](https://stryker-mutator.io), and runs the tests after each break. The tests are the pull request's test files plus same-name test files next to changed code, in any package. Browser tests are not run. Only breaks that change a decision count; the kinds are `BREAK_WORDING` in [test-strength.cjs](../../.github/scripts/test-strength.cjs). A break on a line no test ran counts as not noticed. Above 800 changed code lines it measures an even sample of 800, the same for the same commit, and it stops after 5 minutes.

When Blind Checks finishes, the lane bot reads the measurement as data, judges it again with the base branch's rules, adds a "Test strength" section to its comment, and keeps one label:

- `strength:strong`: the tests noticed every counted break, and at least one was tried.
- `strength:weak`: the tests missed at least one. The section gives the counts and up to 3 examples in fixed wording.
- `strength:unmeasured`: not measured, with the reason: no checks commit, no test needed, no JavaScript or TypeScript changed, only browser tests, the tests failed, no counted break could be made, it ran out of time, or Blind Checks has not finished or left no measurement.

It reports until the repository variable `TEST_STRENGTH_MODE` is `required`. Then weak, and not measured on a pull request that has tests, turn the lane red. A lane that is red only for test strength never fails the Merge lane check, whatever `BLIND_CHECKS_MODE` says.

Measure a change locally from a clean tree, with a checks commit first:

```sh
node .github/scripts/test-strength.cjs measure --first <checks commit> --base fork/amaraa-mode --head HEAD --out ../strength
```

#### What is easy to get wrong

- **Stryker edits files in place.** It puts them back when it ends or is stopped, and the runner checks `git status` after each run. Its type-check step is off and it reads only the planned files, because that step rewrote files across the repo, `.repos/` included, and lost their exec bits.
- **The runner never passes Stryker's `testFiles` option.** In 10.1.1 it makes a break in code that runs while a file loads, such as a pattern at the top of a file, look unnoticed. The runner narrows each package's own test config to the chosen tests instead, with one Stryker run per config.

#### What it cannot prove

- That the code does what the request asked. It checks that the tests pin the code's decisions, not that the decisions are right.
- What is missing. It only breaks code that exists, so a missing guard or case shows nothing.
- That a missed break matters. About 1 in 4 counted breaks change nothing real (32 checked by hand).
- That the measurement is honest. Pull request code runs in the job that writes it, so it can notice Stryker and fail on purpose, or overwrite the file. The bot shows only counts, paths and fixed wording, but cannot spot a forged count.
- Logic kept in data files, other languages or test-support paths, which it never breaks. Tests that snapshot whole outputs notice every break and look strong while being brittle.

## Outcome ledger

The ledger measures which merged changes later needed repair. It reads only git history, and PR labels when you pass `--repo`.

```sh
vp run report:merge-ledger --branch fork/amaraa-mode --repo Amartuvshins0404/t3code --out ../ledger
vp run report:merge-ledger --branch origin/main --since "30 days ago"
```

A change escaped when a later commit reverts it, or when a later `fix` commit within `--window` days (default 14) rewrites code it wrote. The ledger runs `git blame -w -M -C` on the fix's parent over the code lines the fix changes or deletes, and links the fix to a change only when that change wrote at least half of those lines. Blank and comment-only lines, tests, docs, lockfiles, generated files and vendored `.repos/` are left out. When several later commits count as escapes of one change, the report keeps one, and its days to the fix: a revert over a fix, then the closest in time, then the lowest commit id. Escape rates count only changes whose window has passed. Thirty days of upstream history take under two minutes.

A fix with a `Repairs:` line, read from the pull request body with `--repo` or from the commit message, is linked to the changes the line names, and blame is only a cross-check. The report lists each fix where the two disagree. Read a disagreement as a reason to look, not as proof that the line is wrong: blame misses fixes that only add lines. The "By checks" table splits merges into checked blind, none needed, checks revised and no checks. Merges from before the contract have no trailer and count as no checks.

**How far to trust it.** Against 60 upstream fixes labelled by hand and kept out of tuning (2026-11-12), 4 of the ledger's 13 links were right, and it found 4 of the 8 fixes that repaired a change from the previous 14 days. On the 59 fixes the rules were tuned on it did better, 5 of 11 and 5 of 7, which is why the kept-back half is the one to quote. Most of the escapes it lists are wrong, and it counts about 1.6 times as many recent repairs as hand reading. The report also gives the share of fix commits linked to a recent change, the figure to compare with hand reading, where 15 of 120 upstream fixes (12.5%) repaired one. With 8 recent repairs behind the figures, a rate is rough: trust a gap between two lanes or areas only when it is large and both have many mature merges.

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
