# Following upstream T3 Code

`amaraa-mode` follows `pingdotgg/t3code` `main` with real merge commits, so git knows what is already merged and each sync only carries the new commits. The first merge was on 2026-11-17. Before it, the fork had never merged upstream.

Remotes: `origin` is upstream and is never pushed to. `fork` is `Amartuvshins0404/t3code`.

## Steps

1. `scripts/upstream-sync.sh` fetches both remotes. It prints `Up to date` and stops when upstream has nothing new. Otherwise it creates `sync/upstream-<date>` from `fork/amaraa-mode` and starts the merge. It lists the conflicts and exits with 2 when there are any.
2. Settle the conflicts. Keep every fork feature below. When upstream now ships the same thing, take upstream's version and delete the fork's copy.
3. Commit the merge as `chore(sync): merge upstream T3 Code <date>`.
4. Run `vp i`, `vp run typecheck`, `vp lint`, `vp fmt`, `vp run i18n:check` and `vp run fork:check`.
5. Push to `fork`, open a pull request into `amaraa-mode`, and merge it once CI is green. A sync is always on the red lane, because it changes contracts, migrations and dependencies. Merge it with `--admin` after a clean review.
6. The Fork desktop release workflow builds and publishes the Mac app on the merge.

## Fork-only features

`vp run fork:check` runs the tests for each feature and reports one line per feature. [scripts/fork-features-check.ts](../scripts/fork-features-check.ts) maps each feature to its test files.

- The owner's name and icons on every surface: `getAppBaseName()` and `getConnectName()` from `@t3tools/shared/appName`, and `vp run icons:check`.
- The desktop app runs beside upstream T3 Code (its own app id, keychain entry and T3 home) and updates only from the fork's releases.
- Self-hosted sign-in through Better Auth (`infra/auth`) and the Node relay (`infra/relay`), in place of Clerk.
- CLI Proxy providers and their settings.
- Teams: shared machines, threads and projects, the team CLI Proxy, and teammates asking a person's agent.
- The Projects board, the needs-you badge, and planting agent-trust in a project.
- Recommended answers send themselves after the wait set in Settings.
- The master agent: one constant thread with memory that hands off work and hears back.
- The Code map tab.
- The CI bots: Merge Lane, Blind Checks and the ledger (see [operations/merge-lanes.md](operations/merge-lanes.md)).

## Traps

- **Fork tables never take a migration id.** `ensureTeamColumns` and `ensureMasterAgentTables` in `apps/server/src/persistence/Migrations.ts` create them after the numbered migrations run. Keep those two calls when upstream changes the migration loop.
- **Clerk comes back with upstream files.** Upstream still uses Clerk. Delete a new `clerk` file or import, and port what it does to `CloudAuth`.
- **New upstream text says "T3 Code" or "T3 Connect".** Use `getAppBaseName()` or `getConnectName()` in text the owner sees, then add the translation keys in every locale.
- **Teammates are allowed listed methods only.** `apps/server/src/team/TeamMemberAccess.ts` denies new upstream RPC methods and HTTP routes to teammates until they are added there.
- **The team proxy key uses file descriptor 5 for Claude.** Upstream uses descriptor 4 for its launch gate.
- **Fork desktop tests need a file system for `DesktopEnvironment`.** It reads the owner name from the server settings file.
