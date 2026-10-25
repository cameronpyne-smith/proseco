<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/proseco-gold.svg">
    <img src="assets/proseco-green.svg" width="128" alt="proseco logo">
  </picture>
</p>

# proseco

Proactive security operations for a GitHub organisation.

**What it does today:**
- Reads open vulnerability findings from Dependabot and Microsoft Defender for Cloud (container images).
- Keeps **one GitHub issue per repository**, and one per third-party image, listing the critical and high findings that have a fix.
- Rewrites each issue on every run, closes it once nothing remains, and reopens it if findings return.

**What comes next:** the **fixer**, which reads those issues, works each one with a local model, and opens fix pull requests. `fixer run <n>` does this for one npm, uv or requirements.txt ticket, and `fixer serve` is the daemon that polls and works every open ticket.

Proseco itself knows nothing about any particular organisation: the org, tickets repository, labels and project all come from a config file kept in the repository that runs it.

## Layout

```
src/core/       Finding model, grouping, versions, config, GitHub client, ticket render + parse
src/sources/    dependabot, defender      (each a Source)
src/enrich/     EPSS (FIRST) and KEV (CISA)
src/ticketer/   raises and maintains the tickets; run by action.yml
src/fixer/      reads the tickets; a CLI for the fix workflow
deploy/         systemd unit, install script and example config for the fixer service
```

**The ticket body is a contract.** `src/core/ticket.ts` both writes it (`renderBody`) and reads it back (`parseRawTable`), so the ticketer and the fixer cannot drift apart.

## Ticket format

- **Line 1:** `<!-- proseco:<key> -->`, where the key is a repository name, `unmapped` for images that map to no repository, or an image reference such as `docker.elastic.co/kibana/kibana` for a third-party image. An image ticket carries the repository its fix belongs in: `<!-- proseco:<image> repo:<repo> -->`. The `repo:` part is written only when the key is not itself the repository, and older tickets without it still parse.
  - A ticket's body may not exceed GitHub's 65,536 characters. A ticket whose body would is not written, the run logs an error naming the key and the length, the other tickets are still handled, and the run exits non-zero. The raw table is never truncated.
  - Tickets are found by any of `tickets.find.labels` or `tickets.find.creators`.
  - Only a ticket with the marker on line 1 **and** an author in `tickets.find.creators` is treated as proseco's.
- **Fix table:** one row per package version per lockfile. It is a view for people.
- **Raw findings:** one row per CVE, in a collapsed `<details>` block. **This is the source data.** Parse this table, never the fix table.

**When a run changes a ticket:**
- A re-run that finds the same findings changes nothing; EPSS movements and row order are ignored.
- A ticket a person closed as **not planned** (risk accepted) stays closed until a CVE appears that its last table did not list.

## Config

The ticketer and the fixer read the same format, usually from two files: the ticketer's in the repository whose workflow runs it, with `org`, `tickets`, `app` and `sources`; the fixer's on its host, with `org`, `tickets`, `app` and `fixer`. Keep `org`, `tickets` and `app` the same in both.

```json
{
  "org": "acme-org",
  "tickets": {
    "repo": "acme-tickets",
    "project": "Security",
    "labels": ["security", "proseco"],
    "find": { "labels": ["security"], "creators": ["acme-proseco[bot]"] },
    "maintainedIn": "acme-ops"
  },
  "app": { "clientId": "Iv1.0000000000000000", "installationId": 12345678, "bot": "acme-proseco" },
  "sources": {
    "dependabot": {},
    "defender": { "imageRepos": "image-repos.json" }
  },
  "fixer": {
    "cloneDir": "/var/lib/proseco/clones",
    "stateFile": "/var/lib/proseco/state.json",
    "pollMinutes": 1,
    "proxy": { "allow": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"] },
    "sandbox": { "memory": "8g", "cpus": 4 },
    "ollama": { "url": "http://127.0.0.1:11434", "model": "qwen3.8:27b", "numCtx": 65536, "numPredict": 12288, "think": true, "timeoutMinutes": 20 },
    "budget": { "minutes": 30, "majorMinutes": 60, "toolCalls": 200, "commandMinutes": 10 }
  }
}
```

| Key | Meaning |
| --- | --- |
| `org` | The GitHub organisation whose alerts are read and where tickets live. |
| `tickets.repo` | The repository tickets are opened in. |
| `tickets.project` | Optional. Title of an org project (v2) that every open ticket is added to. |
| `tickets.labels` | Labels put on a new ticket. |
| `tickets.find.labels`, `tickets.find.creators` | How existing tickets are found. List every app that has ever created tickets, so a ticket whose label was removed is still found after the app is replaced. |
| `tickets.maintainedIn` | The repository running proseco, named in each ticket body. |
| `app.clientId`, `app.installationId` | The proseco GitHub App's client id and the id of its installation on the org. Both the ticketer and the fixer mint their tokens as this app. |
| `app.bot` | The app's slug, i.e. its login without `[bot]`. A person comments `@<bot> fix` on a ticket to force the fixer to redo it. Every open proseco ticket is worked without a command. List `<bot>[bot]` in `tickets.find.creators`. |
| `sources` | Required by the ticketer, which reads at least one of the sources below. The fixer ignores it. |
| `sources.dependabot` | Present to read the org's open Dependabot alerts. |
| `sources.defender.imageRepos` | Present to read Defender container findings. Points to a JSON routing file, relative to the config file, described below. |
| `fixer` | Required by the fixer. `cloneDir` and `stateFile` are required within it. |
| `fixer.cloneDir` | Directory holding the fixer's bare clones, one `<repo>.git` each. |
| `fixer.stateFile` | JSON file recording each ticket's last attempt. |
| `fixer.pollMinutes` | Optional. How often `fixer serve` polls for tickets, in minutes (a positive number). Default `1`. |
| `fixer.proxy.allow` | Optional. Hostnames the sandbox proxy lets a container reach: exact names, or `*.suffix` for subdomains only (it does not match the bare suffix). A configured list replaces the default, which is `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `api.nuget.org` and `*.nuget.org`. It must not be empty. |
| `fixer.sandbox` | Optional `{ memory, cpus }` for the repository container. `memory` is a Docker size such as `8g` or `512m`, `cpus` a positive number. Defaults to `8g` and `4`. |
| `fixer.ollama` | Optional `{ url, model, numCtx, numPredict, think, timeoutMinutes }` for the model that drives the agent. Defaults: `http://127.0.0.1:11434`, `qwen3.8:27b`, `65536`, `12288`, `true`, `20`. `timeoutMinutes` limits one model call. |
| `fixer.budget` | Optional `{ minutes, majorMinutes, toolCalls, commandMinutes }`. One lockfile unit's agent may run for `minutes`, and a major-upgrade unit's for `majorMinutes`; either may make `toolCalls` tool calls (`finish` does not count); one container command may run for `commandMinutes`. Defaults: `30`, `60`, `200`, `10`. |

Unknown keys are rejected, so a misspelt key fails the run instead of being ignored.

### The image routing file

```json
{
  "own": { "ghcr.io/acme-org/acme-api": "acme-api" },
  "thirdParty": { "docker.elastic.co/": "acme-infra", "docker.io/library/postgres": "acme-infra" },
  "ignore": ["docker.io/library/busybox"]
}
```

| Section | Meaning |
| --- | --- |
| `own` | Images built from the org's repositories. A finding joins that repository's ticket like a Dependabot finding. |
| `thirdParty` | Images the org only runs. One ticket per image, keyed by the image reference, naming the repository where the image tag or chart version is declared. |
| `ignore` | Images to leave out. They are dropped before ticketing and counted in the log. |

- Every key and every `ignore` entry is an image reference prefix: lowercase, `[a-z0-9._/-]`, at least one `/`, no `@` or `:`. Values are repository names without the org. All three sections are required; `ignore` may be empty. A prefix may appear once across the sections. Unknown keys and malformed entries fail the run.
- Matching is case-insensitive, and the longest matching prefix across all three sections wins. A match is only on a `/` boundary: `docker.io/library/node` matches itself and `docker.io/library/node/anything`, never `docker.io/library/nodejs`. An entry ending in `/` is a plain prefix.
- An image that matches nothing goes to the `unmapped` ticket.

## Running the ticketer

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@<sha>
    with:
      persist-credentials: false
  - uses: azure/login@<sha>
    with:
      client-id: ${{ vars.AZURE_CLIENT_ID }}
      tenant-id: ${{ vars.AZURE_TENANT_ID }}
      subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
  - uses: <owner>/proseco@<full commit sha>
    with:
      config: proseco.json
      private-key: ${{ secrets.PROSECO_PRIVATE_KEY }}
      azure-subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      dry-run: "false"
```

**Notes:**
- **The ticketer mints its own tokens** as the app named in `app`, each scoped to one step: `vulnerability_alerts: read` across the installation for Dependabot, `issues: read` on the tickets repository, and, only when not a dry run, `issues: write` on it plus `organization_projects: write` when `tickets.project` is set. The action writes the key to a mode-0600 file under `RUNNER_TEMP` and deletes it when the step ends.
- **Pin the action by full commit SHA.** This is a security control; a moved tag must not change it.
- **The GitHub App must be installed on every repository whose alerts it reads.** Dependabot alerts are only returned for repositories in the installation.
- **Defender** is read from its individual container vulnerability recommendations (one `Update <package>` assessment per vulnerable package per running container, with the CVEs inside), not the retired grouped format. Runtime scanning is registry-agnostic, so images from any registry appear. It needs Defender for Containers with agentless scanning and Kubernetes API access enabled, and first results appear within about a day of enabling. The identity needs a Reader-level role that covers security assessments (e.g. Security Reader) on the subscription. `azure/login` must run before the action. Skip both when the config has no `defender` source.
- **The log** shows `defender findings: N`, `defender rows skipped: N` (rows with malformed data or no image) and `defender findings ignored: N`. If rows came back but none parsed, it warns that the recommendation format may have changed.
- The same image and package running in several containers is one finding, because findings are deduplicated by image.

**Locally:**
```
PROSECO_CONFIG=path/to/proseco.json PROSECO_APP_KEY=path/to/private-key.pem AZURE_SUBSCRIPTION_ID=... npm run ticketer
```
It is a dry run unless `PROSECO_DRY_RUN=false`, and the write token is only minted then.

## The fixer

`npm run fixer -- run <n>` takes one ticket all the way: an agent in the sandbox, a deterministic lockfile check, a pushed branch, a pull request opened or updated, a ticket comment and a state record. Running it again does nothing. It works npm (`package-lock.json`), uv (`uv.lock`) and pinned `requirements*.txt` lockfiles. `npm run fixer -- serve` does this for every open ticket, forever; see `docs/fixer.md` for the design.

Commands:
- `npm run fixer -- find`: lists every open proseco ticket except `unmapped` as `{ number, key, repo, force, ignored, commentId }`, where `key` is the marker key and `repo` the repository to fix in. `force` is true when a person has commented `@<bot> fix` since the last comment the fixer recorded for the ticket (a comment by a bot never counts); `ignored` is true after `@<bot> ignore`, until a later `@<bot> fix`. The newest command wins. For each such comment it reacts with eyes and records the comment id and the ignored flag in the state file, so a command is acted on once; `commentId` is that comment. An ignored ticket gets no attempt, fetch or comment.
- `npm run fixer -- read <n>`: prints a ticket's raw findings, parsed, as JSON.
- `npm run fixer -- run <n> --dry-run`: prints, as JSON, what an attempt on the ticket would do. It reads the ticket, fetches the repository into the bare clone store, reads each lockfile at the default branch head, and reports:
  - the PR units: one per lockfile for the non-major rows, one per major upgrade, each with its branch (`proseco/<lockfile slug>` or `proseco/<package>-<target>`);
  - each row's GitHub advisory (summary, severity, vulnerable range, patched version, affected functions, references);
  - each package's chain from a direct dependency to it, the ecosystem, and the declared toolchain version (each file is looked for beside the lockfile, then at the repository root);
  - whether the state file says the ticket would be attempted, and why.

  It reports the command comment but does not react to it. It writes nothing except the clone store. It does not look at pull requests, so `openPullRequests` is `"not checked"`.
- `npm run fixer -- run <n> --local`: everything except the push, the pull request, the ticket comment, the reaction and the state file. It ignores the attempt decision and runs the agent on every npm unit, then prints for each: the diff, the lockfile check, the test result and the pull request body it would have used. The checkout stays in place and its path is printed, for inspection. It needs Docker, Ollama and `contents: read` credentials.
- `npm run fixer -- run <n>`: the real attempt, described below. It needs Docker, Ollama and credentials that can write.
- `npm run fixer -- check`: runs the startup checks and prints each as `ok <name>: <detail>` or `FAILED <name>: <reason>`; the exit code is non-zero if any failed. The checks are: the config loads and has a `fixer` section; an installation token for the tickets repository can be minted (so the app key works); Ollama answers `/api/tags` and lists the configured model; `docker info` succeeds. A config that does not load stops the run, since the rest depend on it.
- `npm run fixer -- serve`: the daemon, described below. It needs everything a real `run` needs.

All commands need `PROSECO_CONFIG` and the private key of the app named in `app`, from the file named by `PROSECO_APP_KEY`, or from `$CREDENTIALS_DIRECTORY/private-key` when systemd supplies it. The app is the only identity the fixer uses, locally too. It mints installation tokens scoped to the repositories and permissions each step needs:
  - `issues: write` on the tickets repository for `find` and the real `run` (comment and reaction), `issues: read` otherwise;
  - `contents: read` and `pull_requests: read` on the repository being fixed, to fetch it and read the state of earlier pull requests;
  - `contents: write` and `pull_requests: write` on that repository, minted only at the moment of the push.

  The key is never logged or written.

Git runs with no system or user configuration and no credential helper. The token reaches it through the environment for a single command and is never written to a clone.

### The daemon

`npm run fixer -- serve` runs the startup checks (the same function as `check`), then removes every proseco container and network left by an earlier process (`Sandbox.sweep(0)`, so nothing else may use proseco containers on that Docker while it runs), then loops. Any startup failure prints the reasons and exits non-zero.

Every `fixer.pollMinutes` it runs `find` exactly as the CLI does (list the open tickets, react with eyes to new command comments and record them, save the state), orders the requests (forced ones first, then by ticket number) and works them one at a time through the same code path as `run <n>`. A ticket marked ignored is skipped; for the others the attempt decision (state file and the real state of recorded pull requests) is made as in `run`, so an already-attempted ticket costs one comment lookup and no clone. A failure in one ticket is logged and the pass continues. If `find` fails (GitHub down) the daemon logs it and tries again at the next poll.

One line per event on stdout, each with an ISO timestamp:

```
#12 attempting
#12 done: `uv.lock`: ready https://github.com/<org>/<repo>/pull/7; `web/package-lock.json`: no pull request (<reason>)
#13 skipped: <reason>
#14 failed: <error>
find failed: <error>
idle: nothing to attempt among 5 open tickets
```

A skip is logged once per ticket until its reason changes, and an idle pass is logged only when the pass before it did something (the first pass counts as having done something), so a quiet daemon does not fill its log.

On SIGTERM or SIGINT it lets the unit in progress finish and tear down (stop the sandbox, discard the checkout), starts no further unit or ticket and exits 0. A ticket interrupted between units records nothing and is attempted again after a restart, which updates any branch it already pushed. A second signal exits immediately; the next start sweeps whatever was left in Docker.

### Python

- **uv.** The agent resolves with `uv lock --upgrade-package <package>`, or edits the constraint in `pyproject.toml` and locks again; it never edits `uv.lock` by hand. The harness installs with `uv sync --frozen`. It runs `uv run pytest -x -q` when `pytest` is a locked package, and no tests otherwise.
- **requirements.txt.** The fix is a text edit of the `==` pin, and only that file may change (the prompt says the file may belong to a script or a tool, not the application). The harness runs `python -m pip install -r <file>` from the file's directory, and `python -m pytest -x -q` when `pytest` is pinned in the same file. pip falls back to a user install because the container user cannot write the system site-packages. A file containing `--hash` is reported as unsupported for now: re-hashing needs `pip-compile`.
- **Image.** `proseco/python:<major.minor>`, from `.python-version` or `requires-python`. `UV_LINK_MODE=copy` and `PIP_NO_INPUT=1` are set in every container, and uv's cache lands in `/tmp/home/.cache/uv` because `HOME` is a tmpfs.

### Major upgrades

A unit that is one package whose fix crosses a major version (the plan's `major` unit) is attempted like a lockfile unit, with these differences. The lockfile units of the same ticket are worked first, and a major unit that fails leaves their pull requests untouched.

- **Always a draft.** The pull request is a draft whether or not the harness passed, titled `Upgrade <package> to <target> (major)`, on the branch `proseco/<package>-<target>` the plan assigns. The body says the upgrade crosses a major version and a person must confirm the change.
- **Release notes as facts.** Before the agent runs, the host reads the package's registry metadata (npm: `repository.url`; PyPI: `project_urls`, trying Source, Repository, Homepage, Changelog in that order), and when that is a GitHub repository, up to 300 of its releases. The releases whose tag, minus a leading `v`, `<package>@` or `<package>-`, is a version in `(installed, target]` go in the prompt, newest first, each name and body cut to 1,500 characters and 12,000 in total, as third-party text wrapped like advisories. When nothing is found the prompt says so. Lookups are cached per process.
- **The prompt.** The goal is the smallest working upgrade, not a refactor: read the release notes, search the repository for every use of the package and of the APIs the notes mention, change only what the upgrade requires, run the tests, and if they cannot pass within the budget leave the best state reached and say exactly what still fails. Never downgrade or remove the package. The `finish` summary lists each code change and why, in words.
- **Wider commit guard.** Everything in the checkout may be committed except: anything under `.github/workflows/`, anything under a `node_modules` or `.venv` directory, the lockfiles and manifests of other ecosystems (for an npm unit: `uv.lock`, `pyproject.toml`, `requirements*.txt`, `*.csproj` and the like), package-manager configuration in any directory (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnpmfile.cjs`, `pip.conf`, `pip.ini`, `.pypirc`, `uv.toml`, `nuget.config`, which can redirect the registry or change install behaviour), and a new binary file over 256 KB. Files the repository's `.gitignore` covers are never staged by git. Discarded paths are listed in the pull request.
- **Budget.** `fixer.budget.majorMinutes` (default 60) and the same tool-call cap.
- **Verification.** The same summary check, against a diff of up to 120,000 characters. A longer diff shows the manifest and lockfile hunks first, then code hunks until the cap, and the check is told the diff is truncated and which files are not shown.
- **Body.** The package row, "Breaking changes considered" (the tags of the releases found, not their text), the verified summary, the lockfile check and what the harness ran with the tail of its output (worded as what ran, never as the upgrade being safe), the discarded paths, "Why this is a draft", and `Part of`.
- **Harness.** Unchanged: install, then the tests if the project has any.

### What an attempt does

1. **Decide.** From the state file and the real state of the pull requests it recorded (`open`, `merged` by `merged_at`, `closed`): attempt when the ticket was never attempted, when its body changed and no recorded pull request is open, or when a person commented `@<bot> fix`. A ticket a person marked with `@<bot> ignore` is skipped before any other rule. An open pull request, or the same body already attempted, means nothing happens. The command comment is reacted to with eyes.
2. **Fetch and plan.** The bare clone is updated and the units are planned as in the dry run. Each unit gets its own checkout and sandbox, one after another.
3. **Units that are not attempted.** An image ticket (key is an image reference) is reported as "image tickets are not attempted yet". A lockfile of an unknown type is reported as unsupported. A major upgrade is attempted (see "Major upgrades" below), after the ticket's lockfile units. A hash-pinned requirements file is reported as unsupported too (see the Python notes).
4. **Agent.** For a unit of a supported ecosystem the agent loop runs, with that ecosystem's notes in its system prompt, against Ollama with these tools: `read_file`, `list_dir`, `search`, `write_file`, `edit_file` (all on the host, confined to the checkout: `..`, absolute paths and symlinks that escape are refused, and `.git` cannot be written), `run` (`sh -c` in the container) and `finish`. The loop ends on `finish`, on the time budget or tool-call cap, or when the model twice answers with no tool call. When the conversation approaches `numCtx` the oldest tool results are replaced by a placeholder, keeping the last 8.
5. **Commit guard.** Only the ecosystem's manifest and lockfile are kept. npm: `package.json`, `package-lock.json` and `npm-shrinkwrap.json` in the lockfile's directory, plus the `package.json` of each workspace member the lockfile names. uv: `pyproject.toml` and `uv.lock` in the lockfile's directory, plus the `pyproject.toml` of each workspace member `uv.lock` names. requirements.txt: that file only. Every other change the agent made is discarded and listed in the pull request. Nothing under `.github/workflows/` is ever committed. A major upgrade has a wider guard, below. Commits and tags the agent made inside the container are undone first.
6. **Lockfile check.** The lockfile is parsed. Every installed version of every package in the unit must be at or above the lowest of its target versions, or the package must be gone. Otherwise there is no pull request and the ticket comment says why.
7. **Harness test run.** The ecosystem's install command, then its test command, in the container, from the lockfile's directory (npm: `npm ci --no-audit --no-fund`, `npm test --if-present`; uv and requirements.txt below). Exit 0: a ready pull request. Anything else: a draft whose body names the failing command and has the tail of the output. A project with no tests the fixer can run is ready, and the body says so. The pull request body names the commands that ran. The agent's own claim about the tests plays no part.
8. **Summary check.** One model call with no tools sees the final diff and the agent's summary and returns the summary with every sentence the diff does not support removed. That text goes in the pull request.
9. **Publish.** One commit by `<bot>[bot]` (`Bump <package> to <target>`, or `Fix <n> vulnerable packages in <lockfile>`), force-pushed to `proseco/<lockfile slug>` (the code refuses any other branch name). The pull request is opened, or the open one for that branch is updated and flipped between draft and ready. Its body has the package table, the verified summary, the lockfile and test results, the discarded changes if any, and `Part of <org>/<tickets repo>#<n>`.
10. **Record.** One comment per ticket, edited in place, whose first line is `<!-- proseco:attempt <body hash> -->`, listing per unit the pull request or why there is none. Then the attempt is written to the state file, and the checkouts and containers are removed. A failure in one unit is caught, reported in the comment, and the next unit still runs.

A unit's install scripts may run: the container is the isolation, and running `postinstall` is the same risk class as running the tests. The container reaches package registries through the proxy and nothing else, and no credential ever enters it. The host does every commit and push, and runs git on the checkout with a fixed configuration so nothing the container wrote into `.git` is honoured.

- `npm run fixer -- sandbox <repo> <lockfile path> -- <command...>`: fetches the repository into the clone store, makes a checkout at the default branch head, and picks an image from the lockfile's ecosystem and declared toolchain (`proseco/node:<major>` for npm, `proseco/python:<major.minor>` for uv and requirements; a declaration it cannot read falls back to a current LTS). It builds the image if its tag does not exist, starts the sandbox, runs the command with a 10 minute timeout, prints the exit code and output, then removes the containers, network and checkout. The command's exit code becomes the CLI's (124 when it timed out). It needs `contents: read` credentials like the dry run, and Docker.
- `npm run fixer -- sandbox --sweep`: removes every container and network labelled `proseco.attempt` that is more than an hour old, for leftovers from a crashed run.

The model reads repository files only through the file tools on the checkout and runs commands only in the container.

## The sandbox

Repository code only runs in a throwaway container with no route to the internet except a proxy of our own.

- A per-attempt Docker network `proseco-<attempt>` is created with `--internal`, so it has no gateway.
- The proxy container (`proseco/proxy:<first 12 hex characters of the sha256 of proxy.ts>`, built from `src/fixer/sandbox/proxy.ts` alone) sits on that network and on the default bridge. The repository container sits on the internal network only and reaches the proxy by name on port 3128.
- The proxy is dependency-free Node (`node src/fixer/sandbox/proxy.ts --listen 0.0.0.0:3128 --allow host1,*.suffix`). It tunnels `CONNECT <allowed host>:443`. It answers 403 with the host named in the body to any other host or port, and to plain HTTP, so nothing leaves in clear. A malformed request gets 400 and the connection closes. It logs one line per request, `allowed|refused <host>:<port> bytes=<n>`.
- The repository container runs as the daemon's uid and gid, except under rootless Docker (detected from `docker info`), where it runs as root: that is the unprivileged service user on the host, and a `--user` of the host uid would map to a subordinate uid and leave files in the checkout that the host's `git add` cannot touch. It has the checkout at `/work`, `HOME=/tmp/home` on an `exec` tmpfs, `UV_LINK_MODE=copy`, `PIP_NO_INPUT=1`, all capabilities dropped, `no-new-privileges`, 2048 pids, and the configured memory and cpus. `HTTP_PROXY`, `HTTPS_PROXY` and their lowercase forms are set, `NO_PROXY` is empty, and `NODE_USE_ENV_PROXY=1` makes Node 24's `fetch` honour the proxy. Commands run with `docker exec` under `timeout`, which kills the command's whole process group when the limit passes; output beyond 1 MiB per stream is dropped with a note.
- Every container and network carries the label `proseco.attempt=<id>`. `stop()` removes both containers and the network even after a failed step.
- Checkouts live in `<cloneDir>/attempts/`, one directory per attempt, not in the OS temp directory, so a Docker daemon in another mount namespace (rootless Docker under a service manager) can see the bind mount.
- A checkout is a local `git clone` of the bare clone (objects are hardlinked, so it is cheap) detached at the default branch head. Its `origin` is the path of the bare clone, never a URL with a token. Git reads work inside the container; the host makes every commit and push.

Images live in `src/fixer/sandbox/images/`: `node` (`node:<major>-bookworm-slim`), `python` (`python:<major.minor>-slim-bookworm` plus uv, whose version is pinned once in `images.ts`) and `dotnet` (not used by any ecosystem yet). Each has git and `WORKDIR /work`.

The unit tests need no Docker. The integration test builds the node image, installs a fixture lockfile through the proxy, and checks that other hosts and raw IPs are unreachable:

```
npm run test:docker
```

The agent integration test needs Docker and Ollama with the configured model pulled. It creates a local origin from a fixture, runs the attempt with the real model and sandbox and a stub publisher, and checks the lockfile, the commit's files, the pull request body and that no container is left. There is one fixture each for npm (`minimist@1.2.5`), uv (`requests==2.31.0` in `pyproject.toml` with a generated `uv.lock` and a pytest dev group) and requirements.txt (`requests==2.31.0` and `pytest==8.3.3`):

```
npm run test:agent
```

It can take 10 to 30 minutes, and the major scenario (node-fetch 2.6.1 to 3, which is ESM only, so the agent must change code) up to 20 more. The major scenario stubs the release lookup and does not assert that the harness passed; it prints whether it did and what the agent changed.

## Deploying the fixer

`deploy/` installs the fixer as a systemd service on Ubuntu 24.04: a dedicated `proseco` user with rootless Docker, the app at a pinned commit, a Node 24 of its own, config under `/etc/proseco` and state under `/var/lib/proseco`.

Prerequisites: root, `curl`, `git`, `sudo`, `uidmap` (`newuidmap`), `dockerd-rootless-setuptool.sh` (from the Docker packages; the root Docker daemon is not used or touched), outbound HTTPS to `nodejs.org`, `github.com` and `api.github.com`, and Ollama on the host with the configured model pulled. The GitHub App's private key must be to hand.

```
sudo deploy/install.sh <40 character commit sha>
deploy/install.sh <sha> --dry-run
```

The commit must be the full sha: a branch, tag or abbreviation is refused. `--dry-run` prints every command that would change something, each with a leading `+`, and needs no root. Every step checks before acting and reports `already` or `done`, so the script can be run again.

| Step | Result |
| --- | --- |
| Node | `/opt/proseco/node`: the official `nodejs.org` tarball for the host's architecture, checked against `SHASUMS256.txt` from the same release directory. The version is `NODE_VERSION` at the top of the script. |
| App | `/opt/proseco/app`: a clone of this repository, detached at the commit, owned by root and world-readable. There is no `npm ci`: the project has no runtime dependencies. |
| User | `proseco`, a system user with home `/var/lib/proseco-home` and no login shell, and a 65536 range in `/etc/subuid` and `/etc/subgid` that starts above every existing range. |
| Linger | `loginctl enable-linger proseco`, so the user's systemd instance and its rootless `docker.service` start at boot. |
| Docker | `dockerd-rootless-setuptool.sh install` as `proseco` in its own user session, then `systemctl --user enable --now docker`. |
| Config | `/etc/proseco/config.json` from `deploy/config.example.json`, only when absent. It is root-owned, mode 0644. The script never creates or touches `/etc/proseco/private-key.pem`. |
| Unit | `/etc/systemd/system/proseco-fixer.service`, and a drop-in `proseco-fixer.service.d/docker.conf` that sets `DOCKER_HOST=unix:///run/user/<uid>/docker.sock` and `ReadWritePaths=/run/user/<uid>`, because the uid is only known on the host. Then `systemctl daemon-reload`. |
| Check | When the key is present, `fixer check` runs as `proseco` with the unit's environment and a temporary `CREDENTIALS_DIRECTORY` holding a copy of the key, which is removed afterwards. Its output is printed. |

It ends by printing what is left to do: copy the key (`sudo install -m 0600 -o root -g root <key> /etc/proseco/private-key.pem`), edit the config, then `sudo systemctl enable --now proseco-fixer` and `journalctl -fu proseco-fixer`. The example config is a complete fixer-only config, with no `sources`, every `fixer` key at its default and anonymised values.

State: `/var/lib/proseco` (`StateDirectory=proseco`) holds `clones/`, with the attempt checkouts under `clones/attempts/`, and `state.json`.

The unit follows the reviewdo unit, with these hardening lines left out or loosened:
- `DynamicUser` is replaced by `User=proseco`, because rootless Docker needs a user with a home and a subuid range.
- `PrivateUsers` is not set: the daemon's files must be owned by the real `proseco` uid for the rootless daemon's bind mounts.
- `MemoryDenyWriteExecute` is not set: Node's JIT needs writable executable memory.
- `ProtectHome` is not set: `ProtectSystem=strict` already makes `/home` and `/root` read-only and the service home is under `/var/lib`, while `ProtectHome=read-only` would also mount `/run/user` read-only, and `connect()` on a Unix socket there fails with `EROFS`, so the daemon could not reach the Docker socket. The drop-in adds `ReadWritePaths=/run/user/<uid>` for the same reason.
- `RestrictAddressFamilies` adds `AF_UNIX`, which the Docker socket needs.
- `UMask` is `0022` rather than `0077`: files the daemon writes into attempt directories must be readable through the container's uid mapping.

`TimeoutStopSec=15m` with `KillMode=mixed` lets a unit in progress finish its teardown after SIGTERM; the daemon handles the signal and exits 0.

The fixer builds its sandbox images the first time they are needed. The proxy image is tagged with the first 12 hex characters of the sha256 of `proxy.ts`, so it is rebuilt exactly when the proxy changes.

Logs: `journalctl -fu proseco-fixer`. The daemon prints one line per event.

Upgrade: run `sudo deploy/install.sh <new sha>` again. The script restarts the service only when the checkout moved and the service is active, and says so. A changed unit file is installed and reloaded but takes effect at the next restart.

Removal, by hand:

```
sudo systemctl disable --now proseco-fixer
sudo rm /etc/systemd/system/proseco-fixer.service
sudo rm -r /etc/systemd/system/proseco-fixer.service.d
sudo systemctl daemon-reload
sudo -u proseco env XDG_RUNTIME_DIR=/run/user/$(id -u proseco) systemctl --user disable --now docker
sudo loginctl disable-linger proseco
sudo userdel proseco
sudo rm -r /opt/proseco /etc/proseco /var/lib/proseco /var/lib/proseco-home
```

Remove the `proseco` lines from `/etc/subuid` and `/etc/subgid` if `userdel` left them.

## Development

Node 24 runs the TypeScript directly; there is no build step and no runtime dependency.

```
npm ci
npm run typecheck
npm test
```

Test fixtures are anonymised. Keep it that way: no real organisation, repository or ticket names in this repository.
