# The fixer

A daemon on a workstation with a GPU. It polls the tickets repository, works every open proseco ticket with a local model, and opens pull requests under the proseco GitHub App. Repository code only ever runs inside a throwaway container.

This document is the design. The README describes what is built.

## Decisions

| Area | Decision |
| --- | --- |
| Shape | A long-running daemon, like reviewdo. No GitHub Actions. TypeScript in this repository, no runtime dependencies. |
| Trigger | Every open proseco ticket is worked automatically. A person forces a fresh attempt by commenting `@<bot> fix` on the ticket, as with `@reviewdo-bot review`, or redoes one pull request by commenting it there, with an optional note for the agent. A pull request that conflicts with the default branch is redone unasked, once per head. Commands count only from people with write access. The fixer reacts with eyes on the comment. |
| Model | Ollama on the host. Default `qwen3.8:27b`. The daemon drives its own tool-call loop. |
| Agency | A full coding agent: it reads, edits and runs commands in the container, for every ticket. |
| Isolation | Rootless Docker under a dedicated `proseco` user. The daemon runs as that user under systemd. |
| Image | One toolchain image per ecosystem (node, python with uv, dotnet). The tag is chosen from the version the repository declares, with a current LTS as the fallback. |
| Network | The container sits on an internal Docker network. Its only route out is a proxy container, also ours, that allows package registries only. No credential ever enters a container. |
| Credentials | The proseco app, with contents and pull-requests write. Its private key reaches the daemon through systemd `LoadCredential`. The daemon mints short-lived installation tokens and passes them to git per command. |
| Clones | The daemon keeps its own bare clones. One local clone per attempt, hardlinked from the bare clone and detached at the default branch head, is bind-mounted into the container. Git reads work inside it; the host makes every commit and push. |
| PR split | One PR per lockfile for the non-major rows. Each major upgrade gets its own PR. |
| PR gate | Deterministic lockfile check, or no PR. For a lockfile unit, tests green in the container: a ready PR; tests red after the agent finished: a draft PR that says what fails. A major unit follows the same rule (draft only for a regression, a forced finish or an unverified lockfile) and says what to review, because a ready PR is the request for review. An agent that did not call finish (budget, stalled, error): no PR, and the reason goes in the ticket comment. |
| Image tickets | Tickets keyed by an image reference are fixed by bumping the image tag or chart version where it is declared, in a later milestone. Until then the fixer reports them as unsupported. Image rows on a repository's own ticket are not attempted either: the comment says to rebuild the image. |
| Ignore | A person comments `@<bot> ignore` to make the fixer leave a ticket alone, whatever happens to its body; `@<bot> fix` clears it and forces an attempt. |
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

1. **Find.** List open proseco tickets (marker on line 1, author in `tickets.find.creators`, not `unmapped`). Skip any whose body hash matches the last attempt, unless a new `@<bot> fix` comment (by a person, newer than the last one seen) is present. Skip any with an open `proseco/*` PR for the ticket, unless the configured reviewer blocked that PR's head and no feedback round has been done for it: then attempt once more, with the review findings in the prompt. With `fixer.turnLock` set, hold the lock for the whole attempt so a reviewer sharing the Ollama takes turns rather than interleaving.
2. **Plan.** Parse the raw table and group it with the same function the ticketer uses. Split into PR units: one per lockfile for non-major rows, one per major row. For each package, fetch the advisory from the global advisories API, and for transitive rows walk the lockfile to name the direct parent. These are facts for the prompt, computed without the model.
3. **Fetch.** Update the bare clone and make a local clone at the default branch head.
4. **Sandbox.** Pick the image from the lockfile's ecosystem and the repository's declared toolchain version. Start the proxy container and the repository container on the internal network, with the clone mounted at `/work`.
5. **Agent.** For each PR unit, run the tool loop with the unit's rows, advisories, parent chains and ecosystem notes. Tools: `read_file`, `list_dir`, `search`, `write_file`, `edit_file` (on the host, confined to the clone), `run` (a command in the container, with a timeout and captured output) and `finish`. The loop ends on `finish`, the time budget, the tool-call cap, or a model that stops calling tools. `outline` and `apply_patch` are not built.
6. **Check.** Keep only the manifest and lockfile changes. Parse the resulting lockfile. Every package from the unit's rows must be at or above its fixed-in version, or gone. Otherwise the unit produces no PR and the comment says why. The harness then runs the ecosystem's install and test commands in the container (`npm ci` and `npm test`; `uv sync --frozen` and `uv run pytest`; `pip install -r` and `pytest`): green is a ready PR, red a draft. The agent's summary is passed through a sceptical verification call that drops every sentence the diff does not support. (The `[Unverified]` marking is not built; unsupported sentences are removed.)
7. **Publish.** Commit on `proseco/<lockfile slug>` or `proseco/<package>-<target>`, push with a token minted for that repository, open or update the PR. Draft when tests were red. Body: the rows and CVEs, the agent's summary, the test result, `Part of`. With `fixer.teams` set, a PR that became ready is announced once, ever, in a Teams chat by a bot; the README's "Announcing in Teams" has the rules. With `fixer.reviewer` set too, a ready PR is labelled for the reviewing bot first and the announcement waits for its marker verdict: ready announces, caution and blocked feed one revision round and then announce, no verdict within 24 hours announces anyway; the message itself never mentions the review. With `fixer.autoMerge` set, a ready PR gets auto-merge enabled with that method, a refusal only logged; reviewdo's `status` setting can then supply a required review status that a bot's PR would otherwise never get.
8. **Record.** Write or edit the ticket comment (`<!-- proseco:attempt <body hash> -->`, a status line, the units), kept current on later passes as its pull requests are merged or closed, save the attempt and the last seen comment id in the state file, remove the clone and the containers.

## Layout

```
src/fixer/
  main.ts         CLI: find, read, run <n> [--dry-run | --local], sandbox, check, serve [--only]
  daemon.ts       the serve loop: poll, order, attempt one ticket at a time, log, stop on a signal
  startup.ts      the startup checks shared by check and serve
  run.ts          wires the real dependencies (tokens, git, Docker, Ollama, GitHub) into an attempt; find, shared by the CLI and the daemon
  attempt.ts      one ticket: decide, fetch, each unit, comment, state
  unit.ts         one unit: clone, sandbox, agent, guard, check, harness, verify, commit, publish
  state.ts        attempts by ticket: body hash, head SHA, PRs, outcome
  plan.ts         rows → PR units
  facts.ts        a unit's rows, advisories, parent chains and, for a major, release notes, for the prompt
  advisories.ts   advisory lookup
  releases.ts     release notes between the installed and target versions, from the registry and GitHub
  dryrun.ts       the dry-run report
  requests.ts     fix requests and the comment command
  pulls.ts        pull request redos: commands, review findings and conflicts on the fixer's own pull requests
  check.ts        the deterministic lockfile check
  publish.ts      the commit guard: allowed files, discard, commit
  pr.ts           commit message, pull request body
  comment.ts      the ticket comment, found and edited in place
  git.ts          bare clone store, clone per attempt, sanitised git access, push with a per-command token
  sandbox/
    docker.ts     run, exec with timeout, stop; docker CLI
    sandbox.ts    the network, proxy and repository containers of one attempt
    proxy.ts      CONNECT proxy with an allowlist, run in its own container
    images.ts     image choice and build
    images/       Dockerfiles: node, python-uv, dotnet, proxy
  ecosystems/
    ecosystem.ts  the Ecosystem interface: image family, prompt notes, allowed commit files, harness
    npm.ts, uv.ts, requirements.ts
                  toolchain version detection, lockfile parsing for the check, parent chains, and the behaviour above
  agent/
    ollama.ts     chat with tools, usage, timeouts (ported from reviewdo)
    tools.ts      tool definitions and their execution
    loop.ts       the tool-call loop, budgets and shrinking
    verify.ts     sceptical verification of the agent's summary
    prompts.ts    the system prompt, the ecosystem notes and the unit prompt
src/core/github.ts  GitHub API clients: tickets, and RepoApi for pull requests
src/core/versions.ts  version comparison (semver and PEP 440)
```

Config, under `fixer`, gains: `bot` (the app slug, matched in the command comment), `app` (client id, installation id), `cloneDir`, `stateFile`, `ollama` (url, model, numCtx, numPredict, think, timeoutMinutes), `pollMinutes` (default 1), `budget` (minutes, majorMinutes, toolCalls, commandMinutes), `proxy.allow` (registry hosts), and `ecosystems` (which are enabled). Unknown keys are still rejected.

## Deployment

- A `proseco` system user with rootless Docker, linger enabled so its Docker daemon runs without a login.
- `deploy/proseco-fixer.service`, modelled on reviewdo's, with `User=proseco` instead of `DynamicUser`, `StateDirectory=proseco` for clones and state, and the private key via `LoadCredential`. The user's Docker is reached through a drop-in that sets `DOCKER_HOST` and `ReadWritePaths` for the socket directory, written by the install script because the uid is only known on the host.
- The app lives at a pinned commit in `/opt/proseco/app` and runs on its own Node 24 in `/opt/proseco/node`, from the official tarball. Config and key are under `/etc/proseco`, state under `/var/lib/proseco`.
- Outbound from the daemon: `api.github.com`, `github.com`, Ollama on localhost, the rootless Docker socket. Nothing listens.
- `/run/lock/ollama`, from a tmpfiles.d entry the install script writes, is the directory the fixer and reviewdo `flock` while they use the GPU, so the two daemons take turns per job and keep their prompt caches.
- `deploy/install.sh <sha>` does all of it, idempotently, and also upgrades; `--dry-run` prints what it would change. It never creates the private key and finishes by running `fixer check` as the service user. The README's "Deploying the fixer" has the steps, the hardening lines that differ from reviewdo's and why, and removal.
- The deployment's own config lives in the private repository that holds it, like the ticketer's workflow. Only Dockerfiles, the unit, the install script and example config live here.

## Milestones

| # | Milestone | Done when |
| --- | --- | --- |
| 1 | **Plumbing.** App auth, clone store, state, PR units, advisory and parent lookup, `run <n> --dry-run` with no model. | The dry run on a live npm ticket prints the PR units, each row's advisory and parent chain, and the branch it would use. |
| 2 | **Sandbox.** Images, proxy, docker run and exec. `fixer sandbox <repo>` starts a container on a checkout and runs a command. | A container can `npm ci --ignore-scripts` through the proxy and cannot reach any other host. |
| 3 | **npm end to end.** Agent loop, tools, lockfile check, PR publish, comment, state. | A live npm ticket gets a PR whose lockfile passes the check and whose CI is green. Running it again does nothing. |
| 4 | **Python and the daemon.** uv and requirements.txt, and `serve`, the daemon loop that polls and works every open ticket. | The uv ticket and the requirements.txt ticket each get a PR, and `serve` works a new ticket within a poll. |
| 5 | **Majors as drafts.** Code changes by the agent, verification of claims. | A major row gets a draft PR with the agent's edits and a passing check. |
| 6 | **Service.** Dedicated user, rootless Docker, unit, install script; the service runs for a week. | Tickets are worked within a poll of appearing and nothing is re-worked without a body change or comment command. |
