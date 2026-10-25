# The board's checker

Milestone 6, stage 3 (ADR-0018). The source of the public repository
`mrgedune/critical-response-checks`, which re-runs the records sent to the
board on the free plan. Made on David's word, 2026-10-25 20:36 ("Yes, make
the public repo"). A change here is copied there by hand.

- `check.mjs`: the checker. It takes what is waiting on the board, fetches the
  check module of each record's build from the site (`check/<build>.mjs`,
  which every build of the site carries), keeps it in `builds/`, re-runs the
  record and sends the verdict. Once a build, it files each board's AUTOPILOT
  REFERENCE.
- `check.yml`: its workflow, as `.github/workflows/check.yml` there. Every
  five minutes (GitHub may run it later), on demand, or on a
  `repository_dispatch` of type `check`. With no board to answer it ends
  quietly, so it can stand before the service is deployed.
- `builds/`: kept there with a `.gitkeep`, so the workflow's commit step has a
  folder to add before the first build is kept.

The board (`server/board/oidc.js`) takes verdicts only with the job's own
GitHub token naming that repository's main branch and this workflow, so
nothing in the repository is secret. GitHub stops a scheduled workflow after
60 days with no commits; a new build kept in `builds/` is a commit, and the
workflow can be turned on again from its Actions page.

On Workers Paid the board can run the same check itself, and this repository
is not needed.
