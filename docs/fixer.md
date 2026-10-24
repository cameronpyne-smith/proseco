# The fixer

A daemon on a workstation with a GPU. It polls the tickets repository, works every open proseco ticket with a local model, and opens pull requests under the proseco GitHub App. Repository code only ever runs inside a throwaway container.

This document is the design. The README describes what is built.

## Decisions

| Area | Decision |
| --- | --- |
| Shape | A long-running daemon, like reviewdo. No GitHub Actions. TypeScript in this repository, no runtime dependencies. |
| Trigger | Every open proseco ticket is worked automatically. A person forces a fresh attempt by commenting `@<bot> fix` on the ticket, as with `@reviewdo-bot review`. The fixer reacts with eyes on the comment. |
| Model | Ollama on the host. Default `qwen3.8:27b`. The daemon drives its own tool-call loop. |
| Agency | A full coding agent: it reads, edits and runs commands in the container, for every ticket. |
| Isolation | Rootless Docker under a dedicated `proseco` user. The daemon runs as that user under systemd. |
| Image | One toolchain image per ecosystem (node, python with uv, dotnet). The tag is chosen from the version the repository declares, with a current LTS as the fallback. |
| Network | The container sits on an internal Docker network. Its only route out is a proxy container, also ours, that allows package registries only. No credential ever enters a container. |
| Credentials | The proseco app, with contents and pull-requests write. Its private key reaches the daemon through systemd `LoadCredential`. The daemon mints short-lived installation tokens and passes them to git per command. |
| Clones | The daemon keeps its own bare clones. One worktree per attempt is bind-mounted into the container. |
| PR split | One PR per lockfile for the non-major rows. Each major upgrade gets its own draft PR. |
| PR gate | Deterministic lockfile check, or no PR. Tests green in the container: a ready PR. Tests red when the budget runs out: a draft PR that says what fails. |
| Re-runs | One attempt per ticket body. Rerun when the body hash changes and no open proseco PR exists for the ticket, or when a person comments `@<bot> fix`. A PR closed without merging is not retried on its own. |
| Budgets | Per PR attempt, from config: 30 minutes and 200 tool calls by default. Each container command has its own timeout. One ticket at a time. |
| Ecosystems | npm (`package-lock.json`), uv (`uv.lock`) and pinned `requirements.txt` first. NuGet and container base-image bumps later. |

## Principles kept from the ticketer

- The ticketer is the control and stays deterministic. The fixer is an accelerator: switched off, nothing is lost.
- The fixer never edits a ticket's title, body or state. It leaves one comment, edited in place, and reacts with eyes on the command comment it acted on.
- PRs say `Part of <org>/<tickets repo>#<n>`, never `Fixes`. The ticket closes when the ticketer sees the alerts gone.
- The model proposes; deterministic code decides. Nothing is pushed unless the lockfile check passes.
- Model input is untrusted. Repository files, advisories and changelogs can carry text written to steer the model. The model holds no token, cannot reach the network except through its container, and its only effect on the world is a branch that the check and a person review.
- The fixer never approves or merges.

## How one attempt works

1. **Find.** List open proseco tickets (marker on line 1, author in `tickets.find.creators`, not `unmapped`). Skip any whose body hash matches the last attempt, unless a new `@<bot> fix` comment (by a person, newer than the last one seen) is present. Skip any with an open `proseco/*` PR for the ticket.
2. **Plan.** Parse the raw table and group it with the same function the ticketer uses. Split into PR units: one per lockfile for non-major rows, one per major row. For each package, fetch the advisory from the global advisories API, and for transitive rows walk the lockfile to name the direct parent. These are facts for the prompt, computed without the model.
3. **Fetch.** Update the bare clone and create a worktree at the default branch head.
4. **Sandbox.** Pick the image from the lockfile's ecosystem and the repository's declared toolchain version. Start the proxy container and the repository container on the internal network, with the worktree mounted at `/work`.
5. **Agent.** For each PR unit, run the tool loop with the unit's rows, advisories, parent chains and ecosystem notes. Tools: `read_file`, `list_dir`, `search`, `outline`, `write_file`, `apply_patch`, `run` (a command in the container, with a timeout and captured output). The loop ends on a final answer, the time budget or the tool-call cap.
6. **Check.** Parse the resulting lockfile. Every package from the unit's rows must be at or above its fixed-in version, or gone. Otherwise the unit produces no PR and the comment says why. The unit's claims are passed through a sceptical verification call that drops what the diff does not support and marks the rest `[Unverified]`.
7. **Publish.** Commit on `proseco/<lockfile slug>` or `proseco/<package>-<target>`, push with a token minted for that repository, open or update the PR. Draft when tests were red. Body: the rows and CVEs, the agent's summary, the test result, `Part of`.
8. **Record.** Write or edit the ticket comment (`<!-- proseco:attempt <body hash> -->`), save the attempt and the last seen comment id in the state file, remove the worktree and the containers.

## Layout

```
src/fixer/
  main.ts         CLI: find, read, run <n> [--dry-run], serve, check, clone
  daemon.ts       poll loop, ordering, one attempt at a time
  state.ts        attempts by ticket: body hash, head SHA, PRs, outcome
  plan.ts         rows → PR units; advisory lookup; parent chains
  attempt.ts      steps 3–8 for one ticket
  git.ts          bare clone store, worktree per attempt, push with a per-command token
  sandbox/
    docker.ts     run, exec with timeout, stop; rootless docker CLI
    proxy.ts      CONNECT proxy with an allowlist, run in its own container
    images/       Dockerfiles: node, python-uv, dotnet
  ecosystems/
    npm.ts, uv.ts, requirements.ts
                  toolchain version detection, image choice, lockfile parsing for the check,
                  notes for the prompt (commands that regenerate the lockfile with scripts off)
  agent/
    ollama.ts     chat with tools, usage, timeouts (ported from reviewdo)
    tools.ts      tool definitions and their container-side execution
    loop.ts       the tool-call loop and budgets
    verify.ts     sceptical verification of the agent's claims
    prompts.ts
  pr.ts           branch names, body, open or update
  comment.ts      the ticket comment
src/core/github.ts  gains GitHub App auth (JWT, installation tokens) and PR calls
```

Config, under `fixer`, gains: `bot` (the app slug, matched in the command comment), `app` (client id, installation id), `cloneDir`, `stateFile`, `ollama` (url, model, numCtx, numPredict, think, timeout), `budget` (time, toolCalls, commandTimeout), `proxy.allow` (registry hosts), and `ecosystems` (which are enabled). Unknown keys are still rejected.

## Deployment

- A `proseco` system user with rootless Docker, linger enabled so its Docker daemon runs without a login.
- A systemd unit modelled on reviewdo's, with `User=proseco` instead of `DynamicUser`, a state directory for clones and state, and the private key via `LoadCredential`.
- Outbound from the daemon: `api.github.com`, `github.com`, Ollama on localhost, the rootless Docker socket. Nothing listens.
- The deployment lives in the private repository that holds the config, like the ticketer's workflow. Only Dockerfiles, the unit template and an install script live here.

## Milestones

| # | Milestone | Done when |
| --- | --- | --- |
| 1 | **Plumbing.** App auth, clone store, worktrees, state, PR units, advisory and parent lookup, `run <n> --dry-run` with no model. | The dry run on a live npm ticket prints the PR units, each row's advisory and parent chain, and the branch it would use. |
| 2 | **Sandbox.** Images, proxy, docker run and exec. `fixer sandbox <repo>` starts a container on a worktree and runs a command. | A container can `npm ci --ignore-scripts` through the proxy and cannot reach any other host. |
| 3 | **npm end to end.** Agent loop, tools, lockfile check, PR publish, comment, state. | A live npm ticket gets a PR whose lockfile passes the check and whose CI is green. A second poll does nothing. |
| 4 | **Python.** uv and requirements.txt. | The uv ticket and the requirements.txt ticket each get a PR. |
| 5 | **Majors as drafts.** Code changes by the agent, verification of claims. | A major row gets a draft PR with the agent's edits and a passing check. |
| 6 | **Service.** Dedicated user, rootless Docker, unit, install script; `serve` runs for a week. | Tickets are worked within a poll of appearing and nothing is re-worked without a body change or comment command. |
