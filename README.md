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
- Keeps **one GitHub issue per repository** listing that repository's critical and high findings that have a fix.
- Rewrites each issue on every run, closes it once nothing remains, and reopens it if findings return.

**What comes next:** the **fixer**, which reads those issues, assesses each finding with a local model, and opens fix pull requests.

Proseco itself knows nothing about any particular organisation: the org, tickets repository, labels and project all come from a config file kept in the repository that runs it.

## Layout

```
src/core/       Finding model, grouping, versions, config, GitHub client, ticket render + parse
src/sources/    dependabot, defender      (each a Source)
src/enrich/     EPSS (FIRST) and KEV (CISA)
src/ticketer/   raises and maintains the tickets; run by action.yml
src/fixer/      reads the tickets; a CLI for the fix workflow
```

**The ticket body is a contract.** `src/core/ticket.ts` both writes it (`renderBody`) and reads it back (`parseRawTable`), so the ticketer and the fixer cannot drift apart.

## Ticket format

- **Line 1:** `<!-- proseco:<repo> -->`, or `<!-- proseco:unmapped -->` for images that map to no repository.
  - Tickets are found by any of `tickets.find.labels` or `tickets.find.creators`.
  - Only a ticket with the marker on line 1 **and** an author in `tickets.find.creators` is treated as proseco's.
- **Fix table:** one row per package version per lockfile. It is a view for people.
- **Raw findings:** one row per CVE, in a collapsed `<details>` block. **This is the source data.** Parse this table, never the fix table.

**When a run changes a ticket:**
- A re-run that finds the same findings changes nothing; EPSS movements and row order are ignored.
- A ticket a person closed as **not planned** (risk accepted) stays closed until a CVE appears that its last table did not list.

## Config

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
  "sources": {
    "dependabot": {},
    "defender": { "imageRepos": "image-repos.json" }
  },
  "fixer": {
    "bot": "acme-proseco",
    "app": { "clientId": "Iv1.0000000000000000", "installationId": 12345678 },
    "cloneDir": "/var/lib/proseco/clones",
    "stateFile": "/var/lib/proseco/state.json",
    "proxy": { "allow": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"] },
    "sandbox": { "memory": "8g", "cpus": 4 }
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
| `sources.dependabot` | Present to read the org's open Dependabot alerts. |
| `sources.defender.imageRepos` | Present to read Defender container findings. Points to a JSON object, relative to the config file, mapping each lowercase ghcr package name under the org to a repository name. Images not in the mapping go to the `unmapped` ticket. |
| `fixer.bot` | The app's slug, i.e. its login without `[bot]`. A person comments `@<bot> fix` on a ticket to force the fixer to redo it. Every open proseco ticket is worked without a command. |
| `fixer.app` | The proseco GitHub App's `clientId` and the `installationId` of its installation on the org. All of `bot`, `app`, `cloneDir` and `stateFile` are required when `fixer` is present. |
| `fixer.cloneDir` | Directory holding the fixer's bare clones, one `<repo>.git` each. |
| `fixer.stateFile` | JSON file recording each ticket's last attempt. |
| `fixer.proxy.allow` | Optional. Hostnames the sandbox proxy lets a container reach: exact names, or `*.suffix` for subdomains only (it does not match the bare suffix). A configured list replaces the default, which is `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `api.nuget.org` and `*.nuget.org`. It must not be empty. |
| `fixer.sandbox` | Optional `{ memory, cpus }` for the repository container. `memory` is a Docker size such as `8g` or `512m`, `cpus` a positive number. Defaults to `8g` and `4`. |

Unknown keys are rejected, so a misspelt key fails the run instead of being ignored.

## Running the ticketer

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@<sha>
    with:
      persist-credentials: false
  - id: read-token
    uses: actions/create-github-app-token@<sha>
    with:
      client-id: ${{ vars.PROSECO_CLIENT_ID }}
      private-key: ${{ secrets.PROSECO_PRIVATE_KEY }}
      owner: acme-org
      permission-vulnerability-alerts: read
      permission-issues: read
  - id: write-token
    uses: actions/create-github-app-token@<sha>
    with:
      client-id: ${{ vars.PROSECO_CLIENT_ID }}
      private-key: ${{ secrets.PROSECO_PRIVATE_KEY }}
      owner: acme-org
      repositories: acme-tickets
      permission-issues: write
      permission-organization-projects: write
  - uses: azure/login@<sha>
    with:
      client-id: ${{ vars.AZURE_CLIENT_ID }}
      tenant-id: ${{ vars.AZURE_TENANT_ID }}
      subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
  - uses: <owner>/proseco@<full commit sha>
    with:
      config: proseco.json
      read-token: ${{ steps.read-token.outputs.token }}
      write-token: ${{ steps.write-token.outputs.token }}
      azure-subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      dry-run: "false"
```

**Notes:**
- **Pin the action by full commit SHA.** This is a security control; a moved tag must not change it.
- **The GitHub App must be installed on every repository whose alerts it reads.** Dependabot alerts are only returned for repositories in the installation.
- **Defender** needs a Reader-level role that covers security assessments (e.g. Security Reader) on the subscription. `azure/login` must run before the action. Skip both when the config has no `defender` source.

**Locally:**
```
PROSECO_CONFIG=path/to/proseco.json GH_READ_TOKEN=... AZURE_SUBSCRIPTION_ID=... npm run ticketer
```
It is a dry run unless `PROSECO_DRY_RUN=false`, and the write token is only needed then.

## The fixer

Built so far, with no model and no container:
- `npm run fixer -- find`: lists every open proseco ticket except `unmapped` as `{ number, repo, force, commentId }`, where `force` is true when a person has commented `@<bot> fix` since the last comment the fixer recorded for the ticket (a comment by a bot never counts). For each such comment it reacts with eyes and records the comment id in the state file, so a command is acted on once; `commentId` is that comment.
- `npm run fixer -- read <n>`: prints a ticket's raw findings, parsed, as JSON.
- `npm run fixer -- run <n> --dry-run`: prints, as JSON, what an attempt on the ticket would do. It reads the ticket, fetches the repository into the bare clone store, reads each lockfile at the default branch head, and reports:
  - the PR units: one per lockfile for the non-major rows, one per major upgrade, each with its branch (`proseco/<lockfile slug>` or `proseco/<package>-<target>`);
  - each row's GitHub advisory (summary, severity, vulnerable range, patched version, affected functions, references);
  - each package's chain from a direct dependency to it, the ecosystem, and the declared toolchain version (each file is looked for beside the lockfile, then at the repository root);
  - whether the state file says the ticket would be attempted, and why.

  It reports the command comment but does not react to it. It writes nothing except the clone store. It does not look at pull requests yet, so `openPullRequests` is `"not checked"`. `run` without `--dry-run` exits with "not built yet".

All commands need `PROSECO_CONFIG`. Credentials are one of:
- `GH_READ_TOKEN`: used as is, nothing is minted. For local runs.
- The app's private key, from the file named by `PROSECO_APP_KEY`, or from `$CREDENTIALS_DIRECTORY/private-key` when systemd supplies it. The fixer then mints installation tokens scoped to the repositories and permissions each step needs (`issues: write` on the tickets repository for `find`, which reacts to comments, `issues: read` for the others, `contents: read` on the repository being fixed). The key is never logged or written.

Git runs with no system or user configuration and no credential helper. The token reaches it through the environment for a single command and is never written to a clone.

- `npm run fixer -- sandbox <repo> <lockfile path> -- <command...>`: fetches the repository into the clone store, makes a worktree at the default branch head, and picks an image from the lockfile's ecosystem and declared toolchain (`proseco/node:<major>` for npm, `proseco/python:<major.minor>` for uv and requirements; a declaration it cannot read falls back to a current LTS). It builds the image if its tag does not exist, starts the sandbox, runs the command with a 10 minute timeout, prints the exit code and output, then removes the containers, network and worktree. It needs `contents: read` credentials like the dry run, and Docker.
- `npm run fixer -- sandbox --sweep`: removes every container and network labelled `proseco.attempt` that is more than an hour old, for leftovers from a crashed run.

The agent and pull request steps are next. See `docs/fixer.md`.
- **Package managers will run only inside a throwaway container**, with scripts and builds disabled.
- **The model reads repository files only from git objects or the container.**

## The sandbox

Repository code only runs in a throwaway container with no route to the internet except a proxy of our own.

- A per-attempt Docker network `proseco-<attempt>` is created with `--internal`, so it has no gateway.
- The proxy container (`proseco/proxy:<git short sha, or dev>`, built from `src/fixer/sandbox/proxy.ts` alone) sits on that network and on the default bridge. The repository container sits on the internal network only and reaches the proxy by name on port 3128.
- The proxy is dependency-free Node (`node src/fixer/sandbox/proxy.ts --listen 0.0.0.0:3128 --allow host1,*.suffix`). It tunnels `CONNECT <allowed host>:443`. It answers 403 with the host named in the body to any other host or port, and to plain HTTP, so nothing leaves in clear. A malformed request gets 400 and the connection closes. It logs one line per request, `allowed|refused <host>:<port> bytes=<n>`.
- The repository container runs as the daemon's uid and gid with the worktree at `/work`, `HOME=/tmp/home` on an `exec` tmpfs, all capabilities dropped, `no-new-privileges`, 2048 pids, and the configured memory and cpus. `HTTP_PROXY`, `HTTPS_PROXY` and their lowercase forms are set, `NO_PROXY` is empty, and `NODE_USE_ENV_PROXY=1` makes Node 24's `fetch` honour the proxy. Commands run with `docker exec` under `timeout`, which kills the command's whole process group when the limit passes; output beyond 1 MiB per stream is dropped with a note.
- Every container and network carries the label `proseco.attempt=<id>`. `stop()` removes both containers and the network even after a failed step.
- The worktree's `.git` file points at the bare clone, which is not mounted, so git commands that need history do not work inside the container.

Images live in `src/fixer/sandbox/images/`: `node` (`node:<major>-bookworm-slim`), `python` (`python:<major.minor>-slim-bookworm` plus uv, whose version is pinned once in `images.ts`) and `dotnet` (not used by any ecosystem yet). Each has git and `WORKDIR /work`.

The unit tests need no Docker. The integration test builds the node image, installs a fixture lockfile through the proxy, and checks that other hosts and raw IPs are unreachable:

```
npm run test:docker
```

## Development

Node 24 runs the TypeScript directly; there is no build step and no runtime dependency.

```
npm ci
npm run typecheck
npm test
```

Test fixtures are anonymised. Keep it that way: no real organisation, repository or ticket names in this repository.
