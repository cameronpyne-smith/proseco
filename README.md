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
    "labels": { "assess": "proseco-assess", "fix": "proseco-fix" }
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
| `fixer.labels` | The labels a person adds to a ticket to ask the fixer for an assessment, or for fix pull requests. |

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

Built so far:
- `npm run fixer -- find`: lists open proseco tickets that carry a fixer label, as JSON. In Actions it also writes `requests=<json>` to `$GITHUB_OUTPUT`, for a job matrix.
- `npm run fixer -- read <n>`: prints a ticket's raw findings, parsed, as JSON.

Both need `PROSECO_CONFIG` and `GH_READ_TOKEN`.

The assessment and pull request steps are next.
- **Package managers will run only on disposable hosted runners**, with scripts and builds disabled.
- **The model will run on a self-hosted runner** and only ever read repository files from git objects.
- **Keep that self-hosted runner out of public repositories,** since a pull request from a fork could run code on it. Run the fix workflow from a private repository.

## Development

Node 24 runs the TypeScript directly; there is no build step and no runtime dependency.

```
npm ci
npm run typecheck
npm test
```

Test fixtures are anonymised. Keep it that way: no real organisation, repository or ticket names in this repository.
