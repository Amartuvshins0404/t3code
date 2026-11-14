# Merge lanes and the outcome ledger

Every pull request into `amaraa-mode` gets one `lane:*` label from the Merge Lane workflow:

- `lane:green`: documentation only.
- `lane:amber`: ordinary app and package code.
- `lane:red`: always a maintainer's call: migrations, contracts, auth, deploys and releases, build config, product defaults, text models read, dependencies, and anything that loosens a gate.

The lane bot, Blind Checks, test strength and the merge ledger are [agent-trust](https://github.com/Amartuvshins0404/agent-trust). Its [docs/merge-lanes.md](https://github.com/Amartuvshins0404/agent-trust/blob/main/docs/merge-lanes.md) is the contract a pull request follows (the `## Request` section, the checks commit with its `Blind-checks:` trailer, `Repairs:` lines) and lists what each bot cannot prove. This page covers only what is specific to t3code.

## What t3code adds

- [.github/workflows/merge-lane.yml](../../.github/workflows/merge-lane.yml) and [.github/workflows/blind-checks.yml](../../.github/workflows/blind-checks.yml) call agent-trust's reusable workflows. Keep these two file names: other tools look for `blind-checks.yml`.
- [.github/agent-trust.json](../../.github/agent-trust.json) holds t3code's path rules, the two suppressions the repo requires, and the install and test commands. The lane and the reason for each label come from its rules. The job summary of each run explains the lane in plain words.
- [.github/actions/agent-trust-setup](../../.github/actions/agent-trust-setup/action.yml) installs Vite+ and the workspace through `setup-ci-deps`, in place of plain Node.
- [.github/scripts/blind-checks-test.sh](../../.github/scripts/blind-checks-test.sh) is the test command. It installs Chromium when a browser test is in the list and the Electron runtime when a desktop test is, then runs `vp test run`. Test strength calls it too, so desktop tests get Electron there as well.
- `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` stay in the root `package.json`. Without them test strength reads "not measured".

## What is easy to get wrong

- **The required checks are the two small result jobs.** `amaraa-mode` requires `Check`, `Merge lane` and `Blind checks`. A job that calls a reusable workflow reports as `lane / Merge lane` and `proof / Blind checks`, so each caller has a second job with the plain name that fails unless the called job succeeded, also when it was skipped or cancelled. Renaming either result job leaves a required check missing and blocks every merge.
- **The pin is a full commit SHA, and only the owner moves it.** Both callers pin agent-trust by SHA with the tag in a trailing comment, so nobody can change the judge under t3code. Moving the pin is an edit under `.github/workflows/`, which is red, so it is always the owner's call. Pin only a commit on agent-trust's `main`.
- **The base branch judges.** The lane bot runs on `pull_request_target` from `amaraa-mode`, checks out only the settings file and package manifests, and never runs pull request code. A pull request that edits the settings, the callers, the setup action or the test script is red and is judged by the old versions. Blind Checks runs pull request code with read-only contents and no secrets. It takes the settings from the newest `amaraa-mode`, the setup action and the test script from the base code, and the judge from the pinned agent-trust commit. Its caller file comes from the pull request, which makes any edit to it red.
- **Unknown is red.** A path no rule matches is red. When a new top-level directory or config file appears, add a rule for it in `.github/agent-trust.json`, or every pull request that touches it stays red.
- **Suppressions make a change red, except the two the repo requires.** The `t3code/no-unreasoned-state-sync` comment with its reason, and `@effect-diagnostics nodeBuiltinImport:off` alone in a test file or a `scripts/` directory, pass. Any other added `oxlint-disable`, `eslint-disable`, `@ts-ignore`, `@ts-expect-error` or `@effect-diagnostics` line is red, whatever reason it gives.
- **A check must not leave files behind.** After the run without the code the job stops if git sees a changed or new file, so tests write temp files to the system temp folder or clean up in `finally`.
- **`vp test run` skips a path it does not know.** The judge treats a test file with no result as not run, never as passed.
- **It reports until the switches are on.** `BLIND_CHECKS_MODE=required` makes Merge lane fail when the lane is red for any reason except test strength, and Blind checks fail when the proof does not hold. `TEST_STRENGTH_MODE=required` makes weak or unmeasured strength turn the lane red. Only the owner sets these repository variables.

## Run it locally

Clone agent-trust next to this checkout and check out the commit the callers pin. From the root of this checkout:

```sh
node ../agent-trust/lib/merge-lane.cjs fork/amaraa-mode..HEAD
node ../agent-trust/lib/merge-lane.cjs --pr 12 --repo Amartuvshins0404/t3code
node ../agent-trust/lib/test-strength.cjs measure --first <checks commit> --base fork/amaraa-mode --head HEAD --out ../strength
node ../agent-trust/lib/merge-ledger.ts --branch fork/amaraa-mode --repo Amartuvshins0404/t3code --out ../ledger
```

`--pr` reads the same API data the workflow reads and changes nothing on GitHub. The ledger reads `Repairs:` lines, `Blind-checks:` trailers and `lane:*` labels the same way for pull requests merged before and after t3code moved to agent-trust. How far to trust its figures is in agent-trust's doc.
