import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig, parseConfig } from "../src/core/config.ts";

function full(): Record<string, unknown> {
  return {
    org: "acme-org",
    tickets: {
      repo: "acme-tickets",
      project: "Acme",
      labels: ["team", "Security"],
      find: { labels: ["Security"], creators: ["proseco-bot[bot]"] },
      maintainedIn: "acme-ops",
    },
    sources: { dependabot: {}, defender: { imageRepos: "image-repos.json" } },
    fixer: { labels: { assess: "proseco-assess", fix: "proseco-fix" } },
  };
}

const mapping = () => ({ "acme-api": "acme-api" });

describe("config", () => {
  it("reads every section", () => {
    const config = parseConfig(full(), mapping);
    assert.equal(config.org, "acme-org");
    assert.deepEqual(config.tickets, {
      repo: "acme-tickets",
      project: "Acme",
      labels: ["team", "Security"],
      find: { labels: ["Security"], creators: ["proseco-bot[bot]"] },
      maintainedIn: "acme-ops",
    });
    assert.equal(config.sources.dependabot, true);
    assert.deepEqual([...config.sources.defender!.imageRepos], [["acme-api", "acme-api"]]);
    assert.deepEqual(config.fixer, { labels: { assess: "proseco-assess", fix: "proseco-fix" } });
  });

  it("treats the project, Defender and the fixer as optional", () => {
    const raw = full();
    delete (raw["tickets"] as Record<string, unknown>)["project"];
    raw["sources"] = { dependabot: {} };
    delete raw["fixer"];
    const config = parseConfig(raw, mapping);
    assert.equal(config.tickets.project, null);
    assert.equal(config.sources.defender, null);
    assert.equal(config.fixer, null);
  });

  it("rejects a misspelt key rather than ignoring it", () => {
    const raw = full();
    (raw["tickets"] as Record<string, unknown>)["label"] = ["Security"];
    assert.throws(() => parseConfig(raw, mapping), /tickets has unknown keys: label/);
  });

  it("refuses a config that could not find its own tickets again", () => {
    const raw = full();
    (raw["tickets"] as Record<string, unknown>)["find"] = { labels: [], creators: [] };
    assert.throws(() => parseConfig(raw, mapping), /tickets.find needs at least one label or creator/);
  });

  it("refuses a config with no source", () => {
    const raw = full();
    raw["sources"] = {};
    assert.throws(() => parseConfig(raw, mapping), /at least one source/);
  });

  it("refuses an org given as a URL or with a slash", () => {
    const raw = full();
    raw["org"] = "github.com/acme-org";
    assert.throws(() => parseConfig(raw, mapping), /org must be a name/);
  });

  it("refuses the same label for assessing and fixing", () => {
    const raw = full();
    raw["fixer"] = { labels: { assess: "proseco", fix: "proseco" } };
    assert.throws(() => parseConfig(raw, mapping), /must differ/);
  });

  it("reads the image mapping relative to the config file and names the file in errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "proseco-config-"));
    writeFileSync(join(dir, "proseco.json"), JSON.stringify(full()));
    writeFileSync(join(dir, "image-repos.json"), JSON.stringify(mapping()));
    assert.equal(loadConfig(join(dir, "proseco.json")).sources.defender!.imageRepos.get("acme-api"), "acme-api");
    writeFileSync(join(dir, "image-repos.json"), JSON.stringify({ "Acme-Api": "acme-api" }));
    assert.throws(() => loadConfig(join(dir, "proseco.json")), /proseco\.json: image-repos\.json: "Acme-Api" is not a lowercase/);
  });
});
