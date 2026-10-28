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
  - A ticket's body always fits GitHub's limit of 65,536 characters, counted as UTF-8 bytes so it can never be over. When every row would not fit, the raw table lists as many findings as fit, KEV first, then by severity, then by CVE, and a note says how many of how many are listed. Only if the fix table alone is too big is it cut the same way. The order ignores EPSS, so a daily score change does not swap which rows are listed. The fixer works from the listed rows only, and a ticket closed as not planned reopens only for a CVE that makes the list.
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
    "ollama": { "url": "http://127.0.0.1:11434", "model": "qwen3.8:27b", "numCtx": 131072, "numPredict": 12288, "think": "medium", "temperature": 0.2, "timeoutMinutes": 20 },
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
| `app.bot` | The app's slug, i.e. its login without `[bot]`. A person comments `@<bot> fix` on a ticket to force the fixer to redo it, or on one of the fixer's pull requests to redo only that one. Every open proseco ticket is worked without a command. List `<bot>[bot]` in `tickets.find.creators`. |
| `sources` | Required by the ticketer, which reads at least one of the sources below. The fixer ignores it. |
| `sources.dependabot` | Present to read the org's open Dependabot alerts. |
| `sources.defender.imageRepos` | Present to read Defender container findings. Points to a JSON routing file, relative to the config file, described below. |
| `fixer` | Required by the fixer. `cloneDir` and `stateFile` are required within it. |
| `fixer.cloneDir` | Directory holding the fixer's bare clones, one `<repo>.git` each. |
| `fixer.stateFile` | JSON file recording each ticket's last attempt. |
| `fixer.pollMinutes` | Optional. How often `fixer serve` polls for tickets, in minutes (a positive number). Default `1`. |
| `fixer.proxy.allow` | Optional. Hostnames the sandbox proxy lets a container reach: exact names, or `*.suffix` for subdomains only (it does not match the bare suffix). A configured list replaces the default, which is `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `api.nuget.org` and `*.nuget.org`. It must not be empty. |
| `fixer.sandbox` | Optional `{ memory, cpus }` for the repository container. `memory` is a Docker size such as `8g` or `512m`, `cpus` a positive number. Defaults to `8g` and `4`. |
| `fixer.ollama` | Optional `{ url, model, numCtx, numPredict, think, temperature, timeoutMinutes }` for the model that drives the agent. Defaults: `http://127.0.0.1:11434`, `qwen3.8:27b`, `131072`, `12288`, `"medium"`, `0.2`, `20`. `think` is `true`, `false`, `"low"`, `"medium"` or `"high"`. `timeoutMinutes` limits one model call. |
| `fixer.budget` | Optional `{ minutes, majorMinutes, toolCalls, commandMinutes }`. One lockfile unit's agent may run for `minutes`, and a major-upgrade unit's for `majorMinutes`; either may make `toolCalls` tool calls (`finish` does not count); one container command may run for `commandMinutes`. Defaults: `30`, `60`, `200`, `10`. |
| `fixer.teams` | Optional `{ tenantId, appId, chatId, serviceUrl }`. When present, ready pull requests are announced in one Microsoft Teams chat by a bot (see "Announcing in Teams"). `tenantId` and `appId` are the bot's Entra tenant and app registration ids, `chatId` the chat's `19:…@thread.v2` id, and `serviceUrl` the Bot Framework service URL, default `https://smba.trafficmanager.net/teams`. Absent: nothing is announced. |
| `fixer.reviewer` | Optional `{ bot, name, label }`: a reviewing GitHub App such as [reviewdo](https://github.com/cameronpyne-smith/reviewdo). `bot` is its app slug without `[bot]` (`reviewdo-bot`), `name` how the pull request comment and the log call it (default: the slug) and `label` the label that asks it for a review (default `reviewdo`). When present, ready pull requests are labelled for review, announced only once the reviewer has given a verdict, and revised once when it requests changes (see "Review before announcing"). Absent: nothing changes. |
| `fixer.turnLock` | Optional path of a directory, `/run/lock/ollama` in the example config. When present, each attempt and each announcement sentence holds a kernel `flock` on it for its duration, so that another process sharing the same Ollama, such as reviewdo with the same `lock` setting, takes turns with the fixer instead of interleaving calls and evicting each other's prompt cache. Unset, or a path that does not exist: the fixer runs without taking turns, logging that once. |
| `fixer.autoMerge` | Optional `"merge"`, `"squash"` or `"rebase"`. When set, every ready pull request the fixer opens, makes ready or finds still ready has auto-merge enabled with that method, so GitHub merges it once the branch rules are met (an approval, the required checks). It is a convenience only: a repository without "Allow auto-merge" in its settings, or one whose rules forbid the method, refuses it, which is logged and changes nothing else. The fixer does nothing about anything else that blocks a merge, such as review threads a person must resolve or a branch that fell behind its base; someone merges those by hand. Unset: no auto-merge. |
| `fixer.transcripts` | Optional `{ maxAgeDays, maxMegabytes }`. When `serve` starts it deletes agent transcripts (`<cloneDir>/transcripts/*.jsonl`) older than `maxAgeDays`, then the oldest ones until the rest total at most `maxMegabytes`. Defaults: `14`, `500`. |

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

`npm run fixer -- run <n>` takes one ticket all the way: an agent in the sandbox, a deterministic lockfile check, a pushed branch, a pull request opened or updated, a ticket comment and a state record. Running it again does nothing. It works npm (`package-lock.json`), uv (`uv.lock`) and pinned requirements files (`requirements*.txt`, `*-requirements.txt`, `*_requirements.txt`, `*.requirements.txt`, any case, and any `.txt` inside a directory named `requirements`). `npm run fixer -- serve` does this for every open ticket, forever; see `docs/fixer.md` for the design.

Commands:
- `npm run fixer -- find`: lists every open proseco ticket except `unmapped` as `{ number, key, repo, force, ignored, commentId, pulls }`, where `key` is the marker key and `repo` the repository to fix in. `force` is true when a person has commented `@<bot> fix` since the last comment the fixer recorded for the ticket (a comment by a bot never counts, nor one by someone without write access to the tickets repository); `ignored` is true after `@<bot> ignore`, until a later `@<bot> fix`. The newest command wins. `pulls` lists the ticket's pull requests to redo (see "Redoing one pull request"). For each such comment it reacts with eyes and records the comment id and the ignored flag in the state file, so a command is acted on once; `commentId` is that comment. An ignored ticket gets no attempt, fetch or comment.
- `npm run fixer -- read <n>`: prints a ticket's raw findings, parsed, as JSON. A row whose package name is not a plain npm, PyPI, NuGet or OS package name, or whose source path is absolute, has an empty segment or a `.`/`..` segment, is refused.
- `npm run fixer -- run <n> --dry-run`: prints, as JSON, what an attempt on the ticket would do. It reads the ticket, fetches the repository into the bare clone store, reads each lockfile at the default branch head, and reports:
  - the PR units: one per lockfile for the non-major rows, one per major upgrade, each with its branch (`proseco/<lockfile slug>` or `proseco/<package>-<target>`);
  - each row's GitHub advisory (summary, severity, vulnerable range, patched version, affected functions, references);
  - each package's chain from a direct dependency to it, the ecosystem, and the declared toolchain version (each file is looked for beside the lockfile, then at the repository root);
  - whether the state file says the ticket would be attempted, and why.

  It reports the command comment but does not react to it. It writes nothing except the clone store. It does not look at the pull requests the state file recorded, so `openPullRequests` is `"not checked"`, but `redo` lists the pull requests that would be redone, and `units` is then only theirs.
- `npm run fixer -- run <n> --local`: everything except the push, the pull request, the ticket comment, the reaction and the state file. It ignores the attempt decision and runs the agent on every npm unit, then prints for each: the diff, the lockfile check, the test result and the pull request body it would have used, and at the end the Teams message it would post for the units that would be ready (with placeholder URLs). The checkout stays in place and its path is printed, for inspection. It needs Docker, Ollama and `contents: read` credentials.
- `npm run fixer -- run <n>`: the real attempt, described below, including any pull request redo the ticket has. It needs Docker, Ollama and credentials that can write. With `fixer.teams` set it then posts any announcement that is due.
- `npm run fixer -- run <pull request URL> [--dry-run | --local]`: redoes that one pull request's unit, as a command on it would, without reading command comments. The pull request must be open, opened by `<bot>[bot]` from a `proseco/` branch, and name its ticket.
- `npm run fixer -- announce <n> [--dry-run] [--now]`: announces the ticket's pull requests in Teams by hand, for a first test of the setup, after automatic retries gave up, or to stop waiting for a review. When the state file holds a queued announcement for the ticket (one the daemon has not managed to post yet, or one waiting for the reviewer), it delivers exactly that, with the same rules, reasons and facts the daemon would use, and clears or updates it in the state file as the daemon would, so a later pass never posts it again. Only when nothing is queued does it take the pull requests of the ticket's last attempt, keep those that are open, ready and opened by `<bot>[bot]` in the org, and post the same message the daemon would (without a `Re-review:` prefix). It prints which source it used. With `fixer.reviewer` set, a pull request without a verdict for its head is printed as `waiting for <name> on <url>` and not posted; `--now` posts it anyway. `--dry-run` prints the messages and the waiting lines, posts nothing and changes nothing, and needs no `fixer.teams`.
- `npm run fixer -- check`: runs the startup checks and prints each as `ok <name>: <detail>` or `FAILED <name>: <reason>`; the exit code is non-zero if any failed. The checks are: the config loads and has a `fixer` section; an installation token for the tickets repository can be minted (so the app key works); Ollama answers `/api/tags` and lists the configured model; `docker info` succeeds; with `fixer.turnLock` set, the path is a directory; with `fixer.teams` set, a Bot Framework token can be got with the Teams certificate. A config that does not load stops the run, since the rest depend on it.
- `npm run fixer -- serve [--only <n>,<n>...]`: the daemon, described below. It needs everything a real `run` needs.

All commands need `PROSECO_CONFIG` and the private key of the app named in `app`, from the file named by `PROSECO_APP_KEY`, or from `$CREDENTIALS_DIRECTORY/private-key` when systemd supplies it. The app is the only identity the fixer uses, locally too. It mints installation tokens scoped to the repositories and permissions each step needs:
  - `issues: write` on the tickets repository for `find` and the real `run` (comment and reaction), `issues: read` otherwise;
  - `contents: read` and `pull_requests: read` on the repository being fixed, to fetch it and read the state of earlier pull requests;
  - `contents: write` and `pull_requests: write` on that repository, minted only at the moment of the push. With `fixer.reviewer` set, the same token also creates the review label if the repository lacks it, adds it to the pull request, and posts the reply to the reviewer's findings as a pull request comment; GitHub accepts all three under `pull_requests: write`, so no further permission is needed.

  The key is never logged or written.

With `fixer.teams` set, the fixer also needs the bot's certificate: one PEM file holding the private key and the certificate, from the file named by `PROSECO_TEAMS_CERT`, or from `$CREDENTIALS_DIRECTORY/teams-certificate`. It is read only to sign a client assertion for Entra, never sent, logged or written.

Git runs with no system or user configuration and no credential helper. The token reaches it through the environment for a single command and is never written to a clone.

### The daemon

`npm run fixer -- serve` runs the startup checks (the same function as `check`), then removes every proseco container and network left by an earlier process (`Sandbox.sweep(0)`, so nothing else may use proseco containers on that Docker while it runs), then loops. Any startup failure prints the reasons and exits non-zero. It then prunes old transcripts (see `fixer.transcripts`).

Every `fixer.pollMinutes` it runs `find` exactly as the CLI does (list the open tickets, react with eyes to new command comments and record them, save the state), orders the requests (forced ones first, then by ticket number) and works them one at a time through the same code path as `run <n>`. A ticket marked ignored is skipped; for the others the attempt decision (state file and the real state of recorded pull requests) is made as in `run`, so an already-attempted ticket costs one comment lookup and no clone. A failure in one ticket is logged and the pass continues. If `find` fails (GitHub down) the daemon logs it and tries again at the next poll.

`--only 12,13` limits the daemon to those ticket numbers, for trying the full cycle (attempt, review, feedback round, announcement) on a few tickets: other open tickets are not attempted, their command comments are left unread, pull requests that name another ticket are neither scanned for commands nor checked for conflicts, and only the named tickets' announcements are delivered. Everything left alone is picked up by a later `serve` without `--only`. A named number that is not an open proseco ticket is never found, so it is simply not attempted. `run <n>` limits its own pull request scan to ticket n the same way.

One line per event on stdout, each with an ISO timestamp:

```
#12 attempting
#12 done: `uv.lock`: ready https://github.com/<org>/<repo>/pull/7; `web/package-lock.json`: no pull request (<reason>)
#13 skipped: <reason>
#14 failed: <error>
find failed: <error>
idle: nothing to attempt among 5 open tickets
```

With `fixer.teams` set, the daemon also posts due announcements after each finished attempt and once per pass, and logs `#12 announced in Teams: <urls>`, `#12 Teams announcement failed (try <n>), retrying at <time>: <error>` or `#12 not announced in Teams after <n> tries, giving up: <error>`.

A skip is logged once per ticket until its reason changes, and an idle pass is logged only when the pass before it did something (the first pass counts as having done something), so a quiet daemon does not fill its log.

On SIGTERM or SIGINT it lets the unit in progress finish and tear down (stop the sandbox, discard the checkout), starts no further unit or ticket and exits 0. A ticket interrupted between units records nothing and is attempted again after a restart, which updates any branch it already pushed. A second signal exits immediately; the next start sweeps whatever was left in Docker.

### Python

- **uv.** The agent resolves with `uv lock --upgrade-package <package>`, or edits the constraint in `pyproject.toml` and locks again; it never edits `uv.lock` by hand. The harness installs with `uv sync --frozen --all-extras --all-groups`, so a `pytest` that lives only in an optional-dependencies extra or a dependency group is installed too. It runs `uv run pytest -q -rfE` (no `-x`, so every failing test id is listed) when `pytest` is a locked package, and no tests otherwise.
- **requirements.txt.** The fix is a text edit of the `==` pin, and only that file may change (the prompt says the file may belong to a script or a tool, not the application). The harness runs `python -m pip install -r <file>` from the file's directory, and `python -m pytest -q -rfE` when `pytest` is pinned in the same file. pip falls back to a user install because the container user cannot write the system site-packages. A file containing `--hash` is reported as unsupported for now: re-hashing needs `pip-compile`.
- **Image.** `proseco/python:<major.minor>`, from `.python-version` or `requires-python`. `UV_LINK_MODE=copy` and `PIP_NO_INPUT=1` are set in every container, and uv's cache lands in `/tmp/home/.cache/uv` because `HOME` is a tmpfs.

### Major upgrades

A unit that is one package whose fix crosses a major version (the plan's `major` unit) is attempted like a lockfile unit, with these differences. The lockfile units of the same ticket are worked first, and a major unit that fails leaves their pull requests untouched.

- **Ready for review unless something failed.** The pull request is titled `Upgrade <package> to <target> (major)`, on the branch `proseco/<package>-<target>` the plan assigns. It follows the same draft rule as a lockfile unit: a draft only when the harness shows a regression, the agent was forced to finish, or the lockfile was not verified, and the body then says why. A ready major says what to review: that the upgrade crosses a major version and whether the agent changed code to adapt to it.
- **Release notes as facts.** Before the agent runs, the host reads the package's registry metadata (npm: `repository.url`; PyPI: `project_urls`, trying Source, Repository, Homepage, Changelog in that order), and when that is a GitHub repository, up to 300 of its releases. The releases whose tag, minus a leading `v`, `<package>@` or `<package>-`, is a version in `(installed, target]` go in the prompt, newest first, each name and body cut to 1,500 characters and 12,000 in total, as third-party text wrapped like advisories. When nothing is found the prompt says so. Lookups are cached per process.
- **The prompt.** The goal is the smallest working upgrade, not a refactor: read the release notes, search the repository for every use of the package and of the APIs the notes mention, change only what the upgrade requires, run the tests, and if they cannot pass within the budget leave the best state reached and say exactly what still fails. A package the upgrade forces across a major version too, usually through peer dependencies, is upgraded and adapted for in the same way. A passing install or build is not taken as evidence that the code works: every entry point and every use of a changed API is checked against the breaking changes. Never downgrade or remove the package. The `finish` summary names every package moved across a major version and why, then each code change and why, in words.
- **Wider commit guard.** Everything in the checkout may be committed except: anything under `.github/`, `.husky/`, `.githooks/`, `.vscode/`, `.devcontainer/` or `.idea/` (in any directory), `lefthook.yml` and `.pre-commit-config.yaml`, anything under a `node_modules` or `.venv` directory, the lockfiles and manifests of other ecosystems (for an npm unit: `uv.lock`, `pyproject.toml`, `requirements*.txt`, `*.csproj` and the like), package-manager configuration in any directory (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnpmfile.cjs`, `pip.conf`, `pip.ini`, `.pypirc`, `uv.toml`, `nuget.config`, which can redirect the registry or change install behaviour), and any new file the agent did not create with `write_file` or `edit_file`, such as build output from `npm run build`. A change a command makes to a tracked file, such as a codemod's, is kept. Files the repository's `.gitignore` covers are never staged by git. Discarded paths are listed in the pull request. Files that run code outside the upgrade itself are listed in a "High-risk paths changed" section at the top of the pull request body: `Dockerfile*`, `docker-compose*`, `Makefile`, `*.sh`, CI files outside `.github` (`.gitlab-ci.yml`, `azure-pipelines.yml`, `Jenkinsfile`, `.circleci/` and similar), and a manifest whose `scripts` (npm) or `project.scripts`, `project.gui-scripts`, `project.entry-points` or `build-system` (uv) changed.
- **Budget.** `fixer.budget.majorMinutes` (default 60) and the same tool-call cap.
- **Verification.** The same summary check, against a diff of up to 120,000 characters. A longer diff shows the manifest and lockfile hunks first, then code hunks until the cap, and the check is told the diff is truncated and which files are not shown.
- **Body.** The package row, "Breaking changes considered" (how many releases' notes the agent was given, a link to each stable release that starts a new major version or whose name or notes mention "breaking", and a link to all the repository's releases), "Other major upgrades" (every other direct dependency whose locked version crossed a major version between the default branch head and the agent's lockfile, old → new, with a link to its releases when its GitHub repository is found; omitted when there are none, and for `requirements*.txt`, which has no direct/transitive distinction), the verified summary, the lockfile check and what the harness ran with the tail of its output (worded as what ran, never as the upgrade being safe, and with an explicit **Untested** line when the project has no tests the fixer can run), the discarded paths, "Why this is a draft" when it is one, "What to review", and `Part of`.
- **Harness.** Unchanged: install, then the tests if the project has any.

### Announcing in Teams

With `fixer.teams` set, a ready pull request is announced in the configured Teams chat by the bot, under the bot's own name and icon, when the attempt that published it:
- opened it ready;
- made a draft ready; or
- pushed a different tree to it while a reviewer's latest deciding review (approve, request changes or dismissed) was an approval of the head it replaced, since the push invalidates what was approved. An approval of an earlier head does not count: the push that replaced that head already asked for the re-review, so a person is asked once per approval, not once per push. That message starts `Re-review:`.

An already-ready pull request that was only updated, and a draft, are not announced. One message per ticket and attempt, or two when it holds both new pull requests and re-reviews:

```
<ticket, linked to the ticket> - <sentence>
<pull request URL>
<pull request URL>
```

The sentence is written by the configured Ollama model, with thinking off and temperature 0, from facts the host produced: each pull request's title, whether it is a major upgrade, its lockfile, and its packages with old and new versions. The agent's summary and release notes are not given to it. The sentence is kept only if it is one line of at most 120 characters with no URL, mention or markup characters, and every word that contains a digit, `.`, `/`, `_` or `-` appears in the facts (a count must be one the facts give). Otherwise, or when the model fails, a fixed sentence is used: the title for one pull request, or for several a sentence such as `Fix 2 vulnerable packages in package-lock.json and upgrade vite to 6.4.4 (major)`. The message is HTML (`textFormat: "xml"`) with every piece of text escaped.

Announcements are queued in the state file when the attempt is recorded, merged with any still pending for the ticket, and posted at once. `fixer run <n>` delivers only ticket n's queue; the daemon delivers every ticket's on each pass. Before posting, each pull request is read again and kept only if it is still open, ready and opened by `<bot>[bot]`. A failed post is retried after 5 minutes, doubling up to 2 hours, for 24 hours; then it is dropped, logged, and a line `Not announced in Teams: <error>` is added to the ticket comment. A failed announcement never fails the attempt.

#### Review before announcing

With `fixer.reviewer` set as well, a reviewing bot gets the first look. The fixer labels a pull request with `fixer.reviewer.label` when it opens it ready, makes a draft ready, or pushes a different tree to a ready one; drafts are never labelled, since something already failed. reviewdo reviews a labelled pull request, removes the label, and posts its review as a comment-only review (never an approval) carrying a hidden marker `<!-- reviewdo verdict=ready|caution|blocked -->` on the commit it reviewed. The fixer reads the latest such review by `<bot>[bot]` whose commit is the pull request's head:

- `ready`: the announcement goes out. The message never mentions the review; the verdict is in the log line and on the pull request itself.
- `caution` or `blocked`: the announcement waits. On its next pass the daemon redoes that pull request (see "Redoing one pull request"; the decision reads `the reviewer raised findings on <url>`): a fresh attempt of its unit from the default branch, where the agent's prompt carries the review summary and each inline finding (path, line, severity, text) as third-party data, with the instruction to fix what is real and say why for anything it declines. Its `finish` call may list a response per finding; the fixer posts a comment on the pull request, `proseco revised this pull request after the review by <name> of <sha>:`, one line per finding with `fixed: <why>`, `not changed: <why>` or `no response from the agent`, pushes to the same branch and labels it again, so the reviewer looks at the new head. The reply replaces the redo reply, which is posted only when the round produced no pull request. One such round per pull request, counted in the state file under `feedback`, even when the revision produced nothing. If the new head is marked `caution` or `blocked` too, the announcement goes out anyway (as `caution` or `changes-requested` in the log), so a person decides; it also goes out 24 hours after it was queued if the round never happened. Any other redo or attempt of a unit whose pull request head carries a `caution` or `blocked` review (a `@<bot> fix` comment, a conflict) is given those findings as well, and counts as the round.
- no verdict for the head: the announcement waits, checked every pass without counting as a failed post. After 24 hours from the push it goes out anyway.

A pull request that was approved by a person and then changed by a feedback push waits for the reviewer's verdict on the new head like any other, and is then announced with the `Re-review:` prefix. Without `fixer.reviewer` nothing above applies.

Posting: the fixer signs a client assertion (RS256, `x5t` thumbprint) with the bot's certificate, exchanges it at `login.microsoftonline.com/<tenantId>/oauth2/v2.0/token` for a token with scope `https://api.botframework.com/.default`, and posts the message to `<serviceUrl>/v3/conversations/<chatId>/activities`. The bot needs no messaging endpoint, but it must have been added to the chat: until then every post fails with 403 `BotNotInConversationRoster`. The app registration behind the bot should hold no other role, since the certificate on the host can get a token for anything it may do.

### What an attempt does

1. **Decide.** From the state file and the real state of the pull requests it recorded (`open`, `merged` by `merged_at`, `closed`): attempt when the ticket was never attempted, when its body changed and no recorded pull request is open, when a person commented `@<bot> fix`, or when one of its pull requests is redone (below). A ticket a person marked with `@<bot> ignore` is skipped before any other rule. An open pull request, or the same body already attempted, means nothing happens. The command comment is reacted to with eyes. With `fixer.turnLock` set, the attempt then takes the lock and holds it until its last unit is done.
2. **Fetch and plan.** The bare clone is updated and the units are planned as in the dry run. Each unit gets its own checkout and sandbox, one after another.
3. **Units that are not attempted.** An image ticket (key is an image reference) is reported as "image tickets are not attempted yet". Rows whose source is an image built from the repository (the first part of the source has a dot or a colon, or is `localhost`, and it is not a known lockfile) form one image unit per image, after the file units. Nothing is attempted for it: the comment says the findings are in the built image and that rebuilding and pushing it, after merging the ticket's pull requests, picks up the patched packages from its base image, bumping the base first if the Dockerfile pins it to a digest or a patch version. A lockfile of an unknown type is reported as unsupported, and so is an npm lockfile that is not JSON or has no `packages` map (`lockfileVersion` 1), with that reason. A `package.json` that is not valid JSON is ignored when reading the toolchain version (`.nvmrc` is read first). A lockfile or major unit whose packages are already at or above their fixed-in version (or gone) at the default branch head is reported as already fixed, without starting the sandbox. A major upgrade is attempted (see "Major upgrades" below), after the ticket's lockfile units. A hash-pinned requirements file is reported as unsupported too (see the Python notes).
4. **Preflight and baseline.** Before the agent starts, with the checkout loaded in the sandbox, an ecosystem may run a `preflight`. npm's re-resolves the untouched lockfile on a scratch copy in `/tmp` (never in `/work`) with the sandbox's npm; if the parsed lockfile is not deep-equal to the original (a different `lockfileVersion`, a legacy `dependencies` section or any other top-level key counts, not only the `packages` map), it tries `npx -y npm@10`, `@9`, `@8`, `@7` in that order. The first that leaves the lockfile exactly equal becomes the unit's npm: the agent is told to use it for every npm command (resolver, `ci`, `test`), and the host's own install and test runs (the baseline, the gate's install, and the harness after the change, step 8) use it too. If none does, the candidate (the bundled npm included, preferred on ties) with the smallest package drift among those that keep `lockfileVersion` is used, and the agent is told how much unrelated change to expect; an npm that rewrites `lockfileVersion` is never chosen. The drift of every candidate is written to the log. Each candidate gets its own limit (the command limit, at most 3 minutes), and no new candidate starts after 10 minutes in total; the first exact one stops the search. What the preflight measured is kept as the unit's resolver reference (the tool, and either "exact" or the drift it allows) for the lockfile verification in step 7. uv has a preflight too: `uv lock --check` on the default branch. A preflight that fails is logged and skipped. Then the harness (step 8) runs once on the unmodified default branch (its install and test output is captured head and tail, 4 MiB in all, so a summary printed last survives), with the same `commandMinutes` limit per command, and the outcome is recorded; the checkout is loaded again so the agent starts clean. If it failed, the agent's prompt lists the failing test ids (pytest) or an excerpt of the output (from the first line that mentions an error, then the tail, so a usage dump after the error does not hide it), and says not to chase them. Pull request bodies show failure output the same way.
5. **Agent.** For a unit of a supported ecosystem the agent loop runs, with that ecosystem's notes in its system prompt, against Ollama with these tools: `read_file`, `list_dir`, `search`, `write_file`, `edit_file` (all in the container, on the copy at `/work`: `..` and absolute paths are refused, and `.git` cannot be written), `run` (`sh -c` in the container), `lockfile_status` and `finish`. `lockfile_status` is answered by the host, not the container: it reads the agent's current lockfile and returns each of the unit's fix checks (ok or failing, the target, every installed copy with its lockfile path and version) and the packages added, removed or changed against the default branch (fix packages first, capped at 60 lines); it is never blocked by the repetition guard. The loop ends on `finish`. The first time the agent stalls (two answers in a row with no tool call, or three rounds of only blocked repeated calls) it is sent the `lockfile_status` output with an instruction to fix the failing checks or finish, and carries on. On the time budget, the tool-call cap, or a second stall, it forces a final answer instead of giving up: the model is asked once more, with no tools, low thinking and the `finish` schema as the output format, then with thinking off; the work in the container then goes through the same checks, and a pull request from a forced answer is always a draft. Context use is estimated at 3 characters a token and corrected by the token count Ollama reports for the previous round; past 80% of `numCtx`, or `numCtx` minus `numPredict` if that is smaller, the oldest tool results are replaced by a placeholder, keeping the last 8. A reply cut off by `numPredict` before it said anything is sent back without its thinking. A tool call identical to two earlier ones within the last 10 calls, with an identical result each time, is not run again: the agent gets a short notice to change approach or finish (an edit with `write_file` or `edit_file` resets this), and three rounds of nothing but blocked calls are treated like a stall. Every `finish`, in lockfile and major units, is first checked by the host: it reads the agent's current lockfile from the container and runs the lockfile check on the unit's fixes. A failing check refuses the finish with each failing package, its target and the installed copies (npm: with their lockfile paths, such as `node_modules/a/node_modules/tmp`). In a major unit a finish is also refused, once, when the unit's manifest holds an override of the vulnerable package (npm: `overrides` in `package.json` naming it at any nesting level, with or without a version in the key; uv: `constraint-dependencies` or `override-dependencies` under `[tool.uv]`; not applicable to requirements files) and another direct dependency crossed a major version: the message names those majors and tells the agent to revert them, re-resolve and confirm with `lockfile_status` that every copy is still fixed, keeping a bump only if the override alone leaves a copy unfixed. In a lockfile unit a finish is also refused when a direct dependency crossed a major version since the default branch head. A finish the host cannot check (the lockfile is missing, larger than 20 MiB or does not parse) is refused too, with the reason, rather than accepted; the host reads files from the container with a 20 MiB limit. The override rule applies only when the override is new compared with the default branch head's manifest; the message also names a peer dependency that needs the new major as a reason to keep a bump. At most two such refusals are made per unit; after that the finish is accepted and the check after the loop decides. None of this runs once the time or tool-call budget is spent. Then, in a major unit, the first `finish` is held: the host reads the agent's current lockfile from the container, runs the ecosystem's install command (with the preflight's npm, if one was chosen), and then itself searches each package that now crosses a major version (the upgraded one and the direct dependencies it forced) for lines such as "no longer", "has been removed" and "removed in" (npm: under `node_modules/<package>`; Python: the package's files under its install directory). Lines are cleaned, deduplicated, cut at 300 characters, and ranked so that lines naming the package (its name, last path segment or capitalised name) together with its new major come first; at most 25 per package, and the whole message stays within an eighth of the context. The reply lists, per package, those lines and the README, CHANGELOG and MIGRATION files found, and requires that the next `finish` summary say, for each package, which messages apply to code in the repository and what was changed, or why none apply. The second `finish` is accepted. The gate fires once per unit, never for a lockfile unit, and not once the time or tool-call budget is spent. Every message, thinking included, is appended as it happens to `<cloneDir>/transcripts/<ticket>-<branch>-<time>.jsonl`, and `run` prints the path.
6. **Commit guard.** Only the ecosystem's manifest and lockfile are kept. npm: `package.json`, `package-lock.json` and `npm-shrinkwrap.json` in the lockfile's directory, plus the `package.json` of each workspace member the lockfile names. uv: `pyproject.toml` and `uv.lock` in the lockfile's directory, plus the `pyproject.toml` of each workspace member `uv.lock` names. requirements.txt: that file only. Every other change the agent made is discarded and listed in the pull request. Nothing under `.github/workflows/` is ever committed. A major upgrade has a wider guard, below. In a lockfile unit the manifest is also compared with the default branch's: for `package.json`, any key other than `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `overrides` and `resolutions` that changed (including `scripts`, `engines`, `bin`, `name`) means no pull request; for `pyproject.toml`, anything outside `project.dependencies`, `project.optional-dependencies`, `dependency-groups` and `tool.uv` `constraint-dependencies`, `override-dependencies` and `dev-dependencies` (including `requires-python` and `tool.uv.sources`) does. Workspace members' manifests are held to the same rule.
7. **Lockfile check.** The lockfile is parsed. A package can appear in the unit once per installed major line (for example 1.1.12 to 1.1.20 and 2.0.2 to 2.1.6). Each installed copy must be at or above a target on its own major line (a 0.x minor counts as its own line) or at or above the highest target of that package, or the package must be gone; each row of the pull request table shows only the copies of its own line. A copy that lies outside every vulnerable range the advisories give for the unit's rows (when each row has one) was never vulnerable and passes whatever its line; with no range known the line rule applies. In a requirements file the package must still be pinned with `==`: removing or loosening the pin fails the check, where in a lockfile a package that is gone passes. Then two more checks run on the committed lockfile. Host-side, for every changed or added entry: npm needs the entry's `name` (if present) to equal the name in its path, its `resolved` host to be one the default branch's lockfile already uses, its tarball path to end in `/<name>/-/<basename>-<version>.tgz`, and no new `npm:`, git, URL, `file:` or `link:` dependency spec in a manifest; uv needs a changed package's `source` to be a registry the default branch's lockfile already uses (no new git, URL or local sources). Any of these means no pull request. Then, in the container, the resolver must reproduce the lockfile: npm re-resolves a scratch copy with the preflight's npm and compares the whole file with the reference (exact when the preflight found an exact npm, otherwise no more drift than the default branch has, and no `resolved`, `integrity` or `name` differences beyond it); uv runs `uv lock --check`. An integrity or source mismatch means no pull request; a resolver that cannot re-resolve it, or more drift than allowed, makes a draft whose body says the lockfile was not verified. Otherwise there is no pull request and the ticket comment says why.
8. **Harness test run.** The checkout as it now stands is copied into the container again, replacing the agent's copy, so the tests run on what will be committed. Then the ecosystem's install command, then its test command, in the container, from the lockfile's directory (npm: `npm ci --no-audit --no-fund`, `npm test --if-present`; uv and requirements.txt below). Exit 0: a ready pull request. A failure: compared with the baseline. Where the ecosystem can list failing test ids (pytest), the failures that are new after the change make a draft and are listed, and failures that the default branch has too are listed apart and are not by themselves a reason for a draft. Where it cannot (npm test), a failure that also happened on the default branch at the same step stays a draft, and the body says the command also fails on the default branch and shows both output tails. A failure the default branch did not have is a draft, as before. A project with no tests the fixer can run is ready, and the body says so. The pull request body names the commands that ran. The agent's own claim about the tests plays no part. pytest runs with `-q -rfE`, and its failing ids are read to the end of the line (parametrised ids with spaces survive). npm failures are read from jest and vitest (`FAIL <file>`, `✕`/`×` test lines), mocha's numbered failures, node's test runner (`✖`) and TAP (`not ok`); ids are file or test names, enough to compare with the default branch.
9. **Summary check.** One model call with no tools sees the final diff and the agent's summary and returns the summary with every sentence the diff does not support removed. That text goes in the pull request.
10. **Publish.** One commit by `<bot>[bot]` (`Bump <package> to <target>`, or `Fix <n> vulnerable packages in <lockfile>`), force-pushed to `proseco/<lockfile slug>` (the code refuses any other branch name). The pull request is opened, or the open one for that branch is updated and flipped between draft and ready. When an open pull request's head already has the same tree as the new commit, nothing is pushed, so an approval stands; only the title and body are updated. A pull request is a draft when the harness shows a regression, the agent was forced to finish, or the committed lockfile was not verified against the resolver; otherwise it is ready. Its body has the package table, the verified summary, the lockfile and test results, the discarded changes if any, why it is a draft when it is one, and `Part of <org>/<tickets repo>#<n>`.
11. **Record.** One comment per ticket, edited in place, whose first line is `<!-- proseco:attempt <body hash> -->`, listing per unit the pull request or why there is none. Then the attempt is written to the state file, and the checkouts and containers are removed. A failure in one unit is caught, reported in the comment, and the next unit still runs.

### Redoing one pull request

A person who can write to the repository comments `@<bot> fix` on one of the fixer's pull requests (open, by `<bot>[bot]`, on a `proseco/` branch). Text after the command is a note for the agent: it goes into the prompt, escaped and attributed, after any review findings, and does not change the rules. The fixer also redoes, unasked, a pull request whose head the reviewer marked `caution` or `blocked` while its feedback round is still to come (see "Review before announcing"), and otherwise one GitHub reports as conflicting with the default branch (`mergeable` false; while GitHub is still computing it counts as not conflicting). Each happens once per pull request head, so a redo that cannot fix the conflict is not retried until the head changes or someone comments.

Each pass, for the repository of every open ticket, the fixer lists the open pull requests, keeps its own, finds each one's ticket from its `Part of <org>/<tickets repo>#<n>` line, and reads its comments after the last command it recorded for it. Only comments in the pull request's conversation count, not review comments on lines of the diff. It reacts with eyes and records the comment id, and the head of a pull request it redoes unasked, under `pulls` in the state file, keyed by URL; entries for pull requests no longer open are dropped. `@<bot> ignore` on a pull request, a command for a closed or ignored ticket, or one on a pull request that names no ticket gets a reply saying so and nothing else.

A redo works only the unit whose branch is the pull request's, as in steps 2 to 10, from the current default branch head, and force-pushes to the same branch, so it supersedes a conflicting head. The ticket's other pull requests are not touched. The ticket comment is edited in place, replacing only that unit's line, and the pull request gets a reply: `proseco redid this pull request from the default branch at <sha>, as <login> asked.` (or `because it conflicted with the default branch.`, or `to address the reviewer's findings.`), then the result. When the unit is already fixed at the default branch head, the reply says the pull request can be closed; when the ticket no longer has the unit, it says so and nothing is run. A redo does not change the recorded body hash, so it never stands in for an attempt on a changed ticket body; any new pull request URL is added to the last attempt. When the ticket is being attempted anyway (a ticket command, a changed body), the whole ticket is worked, the note goes to the pull request's unit, and the pull request gets the reply too.

A unit's install scripts may run: the container is the isolation, and running `postinstall` is the same risk class as running the tests. The container reaches package registries through the proxy and nothing else, and no credential ever enters it. Nothing from the host is mounted into the container: the checkout is copied in and the agent's work copied out (see the sandbox section). The host does every commit and push, and runs git on the checkout with a fixed configuration, with no hooks and no `commondir`.

- `npm run fixer -- sandbox <repo> <lockfile path> -- <command...>`: fetches the repository into the clone store, makes a checkout at the default branch head, and picks an image from the lockfile's ecosystem and declared toolchain (`proseco/node:<major>-<hash>` for npm, `proseco/python:<major.minor>-<hash>` for uv and requirements; a declaration it cannot read falls back to a current LTS). It builds the image if its tag does not exist, starts the sandbox, copies the checkout in, runs the command with a 10 minute timeout, prints the exit code and output, then removes the containers, network and checkout. The command's exit code becomes the CLI's (124 when it timed out). It needs `contents: read` credentials like the dry run, and Docker.
- `npm run fixer -- sandbox --sweep`: removes every container and network labelled `proseco.attempt` that is more than an hour old, for leftovers from a crashed run.

The model reads and writes repository files only through the file tools, and runs commands only in the container.

## The sandbox

Repository code only runs in a throwaway container with no route to the internet except a proxy of our own.

- A per-attempt Docker network `proseco-<attempt>` is created with `--internal`, so it has no gateway.
- The proxy container (`proseco/proxy:<first 12 hex characters of the sha256 of proxy.ts>`, built from `src/fixer/sandbox/proxy.ts` alone) sits on that network and on the default bridge. The repository container sits on the internal network only and reaches the proxy by name on port 3128.
- The proxy is dependency-free Node (`node src/fixer/sandbox/proxy.ts --listen 0.0.0.0:3128 --allow host1,*.suffix`). It tunnels `CONNECT <allowed host>:443`. It answers 403 with the host named in the body to any other host or port, and to plain HTTP, so nothing leaves in clear. A malformed request gets 400 and the connection closes. It logs one line per request, `allowed|refused <host>:<port> bytes=<n>`.
- The repository container runs as uid and gid 1000, never root, under any daemon: rootful, rootful with `userns-remap`, or rootless, where uid 1000 maps to a subordinate uid that owns nothing on the host. It has `/work`, owned by 1000 in the image, `HOME=/tmp/home` on an `exec` tmpfs, `UV_LINK_MODE=copy`, `PIP_NO_INPUT=1`, all capabilities dropped, `no-new-privileges`, 2048 pids, and the configured memory and cpus. `HTTP_PROXY`, `HTTPS_PROXY` and their lowercase forms are set, `NO_PROXY` is `localhost,127.0.0.1,::1` (the container's own loopback, so a dev server inside it can be reached without the proxy), and `NODE_USE_ENV_PROXY=1` makes Node 24's `fetch` honour the proxy. Commands run with `docker exec` under `timeout`, which kills the command's whole process group when the limit passes; output beyond 1 MiB per stream is dropped with a note.
- Every container and network carries the label `proseco.attempt=<id>`. `stop()` removes both containers and the network even after a failed step.
- Checkouts live in `<cloneDir>/attempts/`, one directory per attempt. A checkout is a local `git clone` of the bare clone (objects are hardlinked, so it is cheap) detached at the default branch head. Its `origin` is the path of the bare clone, never a URL with a token. The host makes every commit and push.
- Nothing from the host is mounted. `load` streams the checkout into `/work` as a tar, without `.git`, after emptying `/work`, then makes a baseline commit there so `git diff` and `search` work in the container. `save` streams `/work` back out, without `.git`, `node_modules` or `.venv`, and the host rebuilds the checkout from it, keeping only the host's `.git`. The host parses that tar itself rather than extracting it with `tar`, and refuses absolute paths, `..`, hard links, devices, and symlinks that point outside the checkout or into `.git`; symlinks are created last, and no file is written under one. Each direction is capped at 512 MiB and takes well under a second for a typical repository.

Images live in `src/fixer/sandbox/images/`: `node` (`node:<major>-bookworm-slim`), `python` (`python:<major.minor>-slim-bookworm` plus uv, whose version is pinned once in `images.ts`) and `dotnet` (not used by any ecosystem yet). Each has git and a `/work` owned by uid 1000. An image's tag ends in the first 12 hex characters of the sha256 of its Dockerfile, so an edited Dockerfile builds a new image.

The unit tests need no Docker. The integration test builds the node image, checks that the container works as uid 1000 on a copy, installs a fixture lockfile through the proxy, copies the work out without `node_modules`, and checks that other hosts and raw IPs are unreachable:

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
| Unit | `/etc/systemd/system/proseco-fixer.service`, and a drop-in `proseco-fixer.service.d/docker.conf` that sets `DOCKER_HOST=unix:///run/user/<uid>/docker.sock` and `ReadWritePaths=/run/user/<uid>`, because the uid is only known on the host. When `/etc/proseco/teams-certificate.pem` exists, a second drop-in `teams.conf` adds `LoadCredential=teams-certificate:/etc/proseco/teams-certificate.pem`; when it does not, that drop-in is removed, because systemd refuses to start a unit whose credential file is missing. Then `systemctl daemon-reload`. |
| Turn lock | `/etc/tmpfiles.d/ollama-turn-lock.conf` with `d /run/lock/ollama 0755 root root -`, and the directory created at once with `systemd-tmpfiles --create`. The example config points `fixer.turnLock` at it; reviewdo's `lock` setting should name the same directory. Both services open it read-only, so neither needs write access to `/run`. |
| Check | When the key is present, `fixer check` runs as `proseco` with the unit's environment and a temporary `CREDENTIALS_DIRECTORY` holding a copy of the key (and of the Teams certificate, when present), which is removed afterwards. Its output is printed. |

It ends by printing what is left to do: copy the key (`sudo install -m 0600 -o root -g root <key> /etc/proseco/private-key.pem`), edit the config, optionally copy the Teams certificate to `/etc/proseco/teams-certificate.pem` and run the script again, then `sudo systemctl enable --now proseco-fixer` and `journalctl -fu proseco-fixer`. The example config is a complete fixer-only config, with no `sources`, every `fixer` key at its default and anonymised values.

State: `/var/lib/proseco` (`StateDirectory=proseco`) holds `clones/`, with the attempt checkouts under `clones/attempts/`, and `state.json`.

The unit follows the reviewdo unit, with these hardening lines left out or loosened:
- `DynamicUser` is replaced by `User=proseco`, because rootless Docker needs a user with a home and a subuid range.
- `PrivateUsers` is not set: it was needed for bind-mounted checkouts, which the sandbox no longer uses, and has not been tried with rootless Docker since.
- `MemoryDenyWriteExecute` is not set: Node's JIT needs writable executable memory.
- `ProtectHome` is not set: `ProtectSystem=strict` already makes `/home` and `/root` read-only and the service home is under `/var/lib`, while `ProtectHome=read-only` would also mount `/run/user` read-only, and `connect()` on a Unix socket there fails with `EROFS`, so the daemon could not reach the Docker socket. The drop-in adds `ReadWritePaths=/run/user/<uid>` for the same reason.
- `RestrictAddressFamilies` adds `AF_UNIX`, which the Docker socket needs.
- `UMask` is `0022` rather than `0077`: it was needed for bind-mounted checkouts, which the sandbox no longer uses, and has not been tightened since.

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
