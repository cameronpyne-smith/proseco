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
    app: { clientId: "Iv1.acme", installationId: 42, bot: "acme-proseco" },
    sources: { dependabot: {}, defender: { imageRepos: "image-repos.json" } },
    fixer: fixer(),
  };
}

function fixer(): Record<string, unknown> {
  return {
    cloneDir: "/var/lib/proseco/clones",
    stateFile: "/var/lib/proseco/state.json",
  };
}

const mapping = () => ({ own: { "ghcr.io/acme-org/acme-api": "acme-api" }, thirdParty: { "docker.elastic.co/": "acme-infra" }, ignore: ["docker.io/library/busybox"] });

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
    assert.deepEqual(config.app, { clientId: "Iv1.acme", installationId: 42, bot: "acme-proseco" });
    assert.equal(config.sources!.dependabot, true);
    assert.deepEqual([...config.sources!.defender!.imageRepos.own], [["ghcr.io/acme-org/acme-api", "acme-api"]]);
    assert.deepEqual([...config.sources!.defender!.imageRepos.thirdParty], [["docker.elastic.co/", "acme-infra"]]);
    assert.deepEqual(config.sources!.defender!.imageRepos.ignore, ["docker.io/library/busybox"]);
    assert.deepEqual(config.fixer, {
      cloneDir: "/var/lib/proseco/clones",
      stateFile: "/var/lib/proseco/state.json",
      pollMinutes: 1,
      proxy: { allow: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "api.nuget.org", "*.nuget.org"] },
      sandbox: { memory: "8g", cpus: 4 },
      ollama: { url: "http://127.0.0.1:11434", model: "qwen3.8:27b", numCtx: 65536, numPredict: 12288, think: true, timeoutMinutes: 20 },
      budget: { minutes: 30, majorMinutes: 60, toolCalls: 200, commandMinutes: 10 },
    });
  });

  it("reads the poll interval, defaulting to one minute, and validates it", () => {
    const set = (patch: Record<string, unknown>) => {
      const raw = full();
      Object.assign(raw["fixer"] as Record<string, unknown>, patch);
      return raw;
    };
    assert.equal(parseConfig(set({ pollMinutes: 0.5 }), mapping).fixer!.pollMinutes, 0.5);
    assert.throws(() => parseConfig(set({ pollMinutes: 0 }), mapping), /fixer.pollMinutes must be a positive number/);
    assert.throws(() => parseConfig(set({ pollMinutes: "1" }), mapping), /fixer.pollMinutes must be a positive number/);
  });

  it("overrides the ollama and budget settings and validates them", () => {
    const set = (patch: Record<string, unknown>) => {
      const raw = full();
      Object.assign(raw["fixer"] as Record<string, unknown>, patch);
      return raw;
    };
    const config = parseConfig(
      set({ ollama: { url: "http://gpu.example.test:11434", model: "m:1b", numCtx: 8192, numPredict: 1024, think: false, timeoutMinutes: 5 }, budget: { minutes: 10, majorMinutes: 45, toolCalls: 20, commandMinutes: 2 } }),
      mapping,
    );
    assert.deepEqual(config.fixer!.ollama, { url: "http://gpu.example.test:11434", model: "m:1b", numCtx: 8192, numPredict: 1024, think: false, timeoutMinutes: 5 });
    assert.deepEqual(config.fixer!.budget, { minutes: 10, majorMinutes: 45, toolCalls: 20, commandMinutes: 2 });
    const bad = (patch: Record<string, unknown>, message: RegExp) => assert.throws(() => parseConfig(set(patch), mapping), message);
    bad({ ollama: { url: "gpu" } }, /fixer.ollama.url must be an http or https URL/);
    bad({ ollama: { url: "ftp://gpu" } }, /fixer.ollama.url must be an http or https URL/);
    bad({ ollama: { model: "" } }, /fixer.ollama.model must be a name/);
    bad({ ollama: { numCtx: 0 } }, /fixer.ollama.numCtx must be a positive integer/);
    bad({ ollama: { numPredict: 1.5 } }, /fixer.ollama.numPredict must be a positive integer/);
    bad({ ollama: { think: "high" } }, /fixer.ollama.think must be true or false/);
    bad({ ollama: { timeoutMinutes: -1 } }, /fixer.ollama.timeoutMinutes must be a positive number/);
    bad({ ollama: { temperature: 0 } }, /fixer.ollama has unknown keys: temperature/);
    bad({ budget: { minutes: 0 } }, /fixer.budget.minutes must be a positive number/);
    bad({ budget: { majorMinutes: 0 } }, /fixer.budget.majorMinutes must be a positive number/);
    bad({ budget: { toolCalls: 0 } }, /fixer.budget.toolCalls must be a positive integer/);
    bad({ budget: { commandMinutes: 0 } }, /fixer.budget.commandMinutes must be a positive number/);
    bad({ budget: { time: 1 } }, /fixer.budget has unknown keys: time/);
  });

  it("replaces the default proxy allowlist with a configured one and overrides the sandbox limits", () => {
    const raw = full();
    Object.assign(raw["fixer"] as Record<string, unknown>, {
      proxy: { allow: ["registry.example.test", "*.mirror.example.test"] },
      sandbox: { memory: "2g", cpus: 1.5 },
    });
    const config = parseConfig(raw, mapping);
    assert.deepEqual(config.fixer!.proxy, { allow: ["registry.example.test", "*.mirror.example.test"] });
    assert.deepEqual(config.fixer!.sandbox, { memory: "2g", cpus: 1.5 });
  });

  it("validates the proxy and sandbox keys", () => {
    const bad = (patch: Record<string, unknown>, message: RegExp) => {
      const raw = full();
      Object.assign(raw["fixer"] as Record<string, unknown>, patch);
      assert.throws(() => parseConfig(raw, mapping), message);
    };
    bad({ proxy: { allow: [] } }, /fixer.proxy.allow must list at least one host/);
    bad({ proxy: { allow: ["https://pypi.org"] } }, /fixer.proxy.allow\[0\] must be a name/);
    bad({ proxy: { allow: ["*"] } }, /fixer.proxy.allow\[0\] must be a name/);
    bad({ proxy: { hosts: [] } }, /fixer.proxy has unknown keys: hosts/);
    bad({ sandbox: { memory: "lots" } }, /fixer.sandbox.memory must be a name/);
    bad({ sandbox: { cpus: 0 } }, /fixer.sandbox.cpus must be a positive number/);
    bad({ sandbox: { pids: 1 } }, /fixer.sandbox has unknown keys: pids/);
  });

  it("treats the project, Defender and the fixer as optional", () => {
    const raw = full();
    delete (raw["tickets"] as Record<string, unknown>)["project"];
    raw["sources"] = { dependabot: {} };
    delete raw["fixer"];
    const config = parseConfig(raw, mapping);
    assert.equal(config.tickets.project, null);
    assert.equal(config.sources!.defender, null);
    assert.equal(config.fixer, null);
  });

  it("treats the sources as optional, for a fixer-only config", () => {
    const raw = full();
    delete raw["sources"];
    assert.equal(parseConfig(raw, () => assert.fail("must not read the image routing file")).sources, null);
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

  it("rejects the retired fixer labels", () => {
    const raw = full();
    (raw["fixer"] as Record<string, unknown>)["labels"] = { fix: "proseco-fix" };
    assert.throws(() => parseConfig(raw, mapping), /fixer has unknown keys: labels/);
  });

  it("requires the bot to be a login without the [bot] suffix", () => {
    const raw = full();
    (raw["app"] as Record<string, unknown>)["bot"] = "acme-proseco[bot]";
    assert.throws(() => parseConfig(raw, mapping), /app.bot must be a name/);
  });

  it("rejects unknown keys under the fixer and the app", () => {
    const withExtra = full();
    (withExtra["fixer"] as Record<string, unknown>)["budgets"] = {};
    assert.throws(() => parseConfig(withExtra, mapping), /fixer has unknown keys: budgets/);
    const appExtra = full();
    (appExtra["app"] as Record<string, unknown>)["secret"] = "x";
    assert.throws(() => parseConfig(appExtra, mapping), /app has unknown keys: secret/);
  });

  for (const key of ["clientId", "installationId", "bot"]) {
    it(`requires app.${key}`, () => {
      const raw = full();
      delete (raw["app"] as Record<string, unknown>)[key];
      assert.throws(() => parseConfig(raw, mapping), new RegExp(`app.${key}`));
    });
  }

  it("requires the app", () => {
    const raw = full();
    delete raw["app"];
    assert.throws(() => parseConfig(raw, mapping), /app must be an object/);
  });

  for (const key of ["cloneDir", "stateFile"]) {
    it(`requires fixer.${key} when the fixer is present`, () => {
      const raw = full();
      delete (raw["fixer"] as Record<string, unknown>)[key];
      assert.throws(() => parseConfig(raw, mapping), new RegExp(`fixer.${key}`));
    });
  }

  it("requires the installation id to be a positive integer", () => {
    const raw = full();
    (raw["app"] as Record<string, unknown>)["installationId"] = "42";
    assert.throws(() => parseConfig(raw, mapping), /app.installationId must be a positive integer/);
  });

  it("reads the image mapping relative to the config file and names the file in errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "proseco-config-"));
    writeFileSync(join(dir, "proseco.json"), JSON.stringify(full()));
    writeFileSync(join(dir, "image-repos.json"), JSON.stringify(mapping()));
    assert.equal(loadConfig(join(dir, "proseco.json")).sources!.defender!.imageRepos.own.get("ghcr.io/acme-org/acme-api"), "acme-api");
    writeFileSync(join(dir, "image-repos.json"), JSON.stringify({ ...mapping(), own: { "Acme/Api": "acme-api" } }));
    assert.throws(() => loadConfig(join(dir, "proseco.json")), /proseco\.json: image-repos\.json\.own: "Acme\/Api"/);
  });
});
