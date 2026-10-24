import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Releases, repositoryOf } from "../src/fixer/releases.ts";

function release(tag: string, body = `notes for ${tag}`, name = `Release ${tag}`) {
  return { tag_name: tag, name, body };
}

function client(responses: Record<string, unknown>) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    headers.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)));
    const body = responses[url];
    return body === undefined ? new Response("missing", { status: 404, statusText: "Not Found" }) : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { releases: new Releases("token", fetchImpl), urls, headers };
}

const NPM_URL = "https://registry.npmjs.org/acme-parse";
const RELEASES = "https://api.github.com/repos/acme-org/acme-parse/releases?per_page=100&page=1";

describe("repository names", () => {
  it("normalises the common GitHub URL shapes to owner/repo", () => {
    for (const url of [
      "git+https://github.com/acme-org/acme-parse.git",
      "https://github.com/acme-org/acme-parse",
      "git://github.com/acme-org/acme-parse.git",
      "git+ssh://git@github.com/acme-org/acme-parse.git",
      "git@github.com:acme-org/acme-parse.git",
      "github:acme-org/acme-parse",
      "acme-org/acme-parse",
      "https://github.com/acme-org/acme-parse/tree/main/packages/x",
      "https://www.github.com/acme-org/acme-parse/",
    ]) {
      assert.equal(repositoryOf(url), "acme-org/acme-parse", url);
    }
  });

  it("returns null for anything that is not a GitHub repository", () => {
    for (const url of ["https://gitlab.com/acme-org/acme-parse", "https://acme.example.test/docs", "", "https://github.com/acme-org"]) {
      assert.equal(repositoryOf(url), null, url);
    }
  });
});

describe("release notes", () => {
  it("finds the repository from npm metadata, keeps releases in (installed, target] and orders them newest first", async () => {
    const { releases, urls, headers } = client({
      [NPM_URL]: { name: "acme-parse", repository: { type: "git", url: "git+https://github.com/acme-org/acme-parse.git" } },
      [RELEASES]: [release("v1.0.0"), release("v2.0.0"), release("v3.0.0"), release("v2.5.0"), release("v3.0.1"), release("not-a-version")],
    });
    const found = await releases.lookup("npm", "acme-parse", "2.0.0", "3.0.0");
    assert.equal(found.repository, "acme-org/acme-parse");
    assert.deepEqual(found.releases.map((entry) => entry.tag), ["v3.0.0", "v2.5.0"]);
    assert.deepEqual(urls, [NPM_URL, RELEASES]);
    assert.equal(headers[0]!["authorization"], undefined);
    assert.equal(headers[1]!["authorization"], "Bearer token");
  });

  it("strips v, <package>@ and <package>- from tags before reading the version", async () => {
    const { releases } = client({
      [NPM_URL]: { repository: "acme-org/acme-parse" },
      [RELEASES]: [release("acme-parse@3.0.0"), release("acme-parse-2.9.0"), release("v2.8.0"), release("other@2.7.0"), release("2.6.0")],
    });
    const found = await releases.lookup("npm", "acme-parse", "2.0.0", "3.0.0");
    assert.deepEqual(found.releases.map((entry) => entry.tag), ["acme-parse@3.0.0", "acme-parse-2.9.0", "v2.8.0", "2.6.0"]);
  });

  it("handles scoped npm packages and their tags", async () => {
    const { releases, urls } = client({
      "https://registry.npmjs.org/@acme%2Fparse": { repository: { url: "git+https://github.com/acme-org/parse.git" } },
      "https://api.github.com/repos/acme-org/parse/releases?per_page=100&page=1": [release("@acme/parse@3.0.0")],
    });
    const found = await releases.lookup("npm", "@acme/parse", "2.0.0", "3.0.0");
    assert.deepEqual(found.releases.map((entry) => entry.tag), ["@acme/parse@3.0.0"]);
    assert.equal(urls[0], "https://registry.npmjs.org/@acme%2Fparse");
  });

  it("reads PyPI project_urls in the order Source, Repository, Homepage, Changelog", async () => {
    const { releases, urls } = client({
      "https://pypi.org/pypi/acme-parse/json": {
        info: { project_urls: { Changelog: "https://github.com/acme-org/changes", Homepage: "https://acme.example.test", Repository: "https://github.com/acme-org/second", Source: "https://github.com/acme-org/first" } },
      },
      "https://api.github.com/repos/acme-org/first/releases?per_page=100&page=1": [release("3.0.0")],
    });
    const found = await releases.lookup("pip", "acme-parse", "2.0.0", "3.0.0");
    assert.equal(found.repository, "acme-org/first");
    assert.equal(urls[0], "https://pypi.org/pypi/acme-parse/json");
  });

  it("skips PyPI urls that are not GitHub repositories and falls through to the next key", async () => {
    const { releases } = client({
      "https://pypi.org/pypi/acme-parse/json": { info: { project_urls: { Source: "https://gitlab.com/acme-org/x", Homepage: "https://github.com/acme-org/home" } } },
      "https://api.github.com/repos/acme-org/home/releases?per_page=100&page=1": [],
    });
    assert.equal((await releases.lookup("pip", "acme-parse", "2.0.0", "3.0.0")).repository, "acme-org/home");
  });

  it("truncates each body to 1,500 characters and the total to 12,000", async () => {
    const tags = Array.from({ length: 12 }, (_, index) => `v3.0.${index}`);
    const { releases } = client({
      [NPM_URL]: { repository: "acme-org/acme-parse" },
      [RELEASES]: tags.map((tag) => release(tag, "x".repeat(5000))),
    });
    const found = await releases.lookup("npm", "acme-parse", "2.0.0", "3.0.20");
    assert.equal(found.releases.length, 12);
    assert.ok(found.releases.every((entry) => entry.body.length <= 1500));
    assert.equal(found.releases[0]!.body.length, 1500);
    const total = found.releases.reduce((sum, entry) => sum + entry.body.length, 0);
    assert.ok(total <= 12_000, `total ${total}`);
    assert.equal(found.releases.at(-1)!.body, "");
  });

  it("pages through releases up to 300 and stops on a short page", async () => {
    const page = (start: number) => Array.from({ length: 100 }, (_, index) => release(`v2.${start + index}.0`));
    const { releases, urls } = client({
      [NPM_URL]: { repository: "acme-org/acme-parse" },
      [RELEASES]: page(1000),
      "https://api.github.com/repos/acme-org/acme-parse/releases?per_page=100&page=2": page(2000),
      "https://api.github.com/repos/acme-org/acme-parse/releases?per_page=100&page=3": [release("v3.0.0")],
      "https://api.github.com/repos/acme-org/acme-parse/releases?per_page=100&page=4": [release("v3.0.1")],
    });
    const found = await releases.lookup("npm", "acme-parse", "1.0.0", "3.0.0");
    assert.equal(urls.filter((url) => url.includes("/releases")).length, 3);
    assert.equal(found.releases[0]!.tag, "v3.0.0");
  });

  it("says so when the package has no repository", async () => {
    const { releases, urls } = client({ [NPM_URL]: { name: "acme-parse" } });
    const found = await releases.lookup("npm", "acme-parse", "2.0.0", "3.0.0");
    assert.deepEqual(found.releases, []);
    assert.equal(found.repository, null);
    assert.match(found.note!, /no GitHub repository/);
    assert.deepEqual(urls, [NPM_URL]);
  });

  it("says so when no release falls in the window, and when the lookup fails", async () => {
    const empty = client({ [NPM_URL]: { repository: "acme-org/acme-parse" }, [RELEASES]: [release("v1.0.0")] });
    assert.match((await empty.releases.lookup("npm", "acme-parse", "2.0.0", "3.0.0")).note!, /no releases/);
    const failing = client({});
    const found = await failing.releases.lookup("npm", "acme-parse", "2.0.0", "3.0.0");
    assert.deepEqual(found.releases, []);
    assert.match(found.note!, /could not be fetched/);
  });

  it("caches per package and window", async () => {
    const { releases, urls } = client({ [NPM_URL]: { repository: "acme-org/acme-parse" }, [RELEASES]: [release("v3.0.0")] });
    const [first, second] = await Promise.all([releases.lookup("npm", "acme-parse", "2.0.0", "3.0.0"), releases.lookup("npm", "acme-parse", "2.0.0", "3.0.0")]);
    assert.equal(first, second);
    assert.equal(urls.length, 2);
  });
});
