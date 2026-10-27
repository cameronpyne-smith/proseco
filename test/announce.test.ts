import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PullDetails } from "../src/core/github.ts";
import {
  announceReason,
  announcements,
  checkSentence,
  deliverAnnouncements,
  fallbackSentence,
  GIVE_UP_MS,
  messageGroups,
  pullLocation,
  queueAnnouncement,
  renderMessage,
  retryDelay,
  sentenceFacts,
  stillAnnounceable,
  writeSentence,
  type DeliveryDeps,
} from "../src/fixer/announce.ts";
import type { ChatMessage } from "../src/fixer/agent/ollama.ts";
import { emptyState, pendingAnnouncement, recordAttempt, type AnnouncedPr, type State } from "../src/fixer/state.ts";

const URL1 = "https://github.com/acme-org/acme-api/pull/1";
const URL2 = "https://github.com/acme-org/acme-api/pull/2";
const URL3 = "https://github.com/acme-org/acme-api/pull/3";

const LOCKFILE: AnnouncedPr = {
  url: URL1,
  reason: "new",
  facts: { title: "Fix 2 vulnerable packages in package-lock.json", major: false, lockfile: "package-lock.json", packages: [{ name: "minimist", from: "1.2.5", to: "1.2.8" }, { name: "left-pad", from: "1.0.0", to: "1.3.0" }] },
};
const MAJOR: AnnouncedPr = { url: URL2, reason: "new", facts: { title: "Upgrade vite to 6.4.4 (major)", major: true, lockfile: "web/package-lock.json", packages: [{ name: "vite", from: "5.4.21", to: "6.4.4" }] } };
const SECOND_MAJOR: AnnouncedPr = { url: URL3, reason: "new", facts: { title: "Upgrade svelte-check to 4.0.0 (major)", major: true, lockfile: "web/package-lock.json", packages: [{ name: "svelte-check", from: "3.8.0", to: "4.0.0" }] } };

const NOW = new Date("2026-03-01T10:00:00Z");

function details(url: string, overrides: Partial<PullDetails> = {}): PullDetails {
  return { url, title: "t", state: "open", draft: false, author: "acme-proseco[bot]", ...overrides };
}

describe("when a pull request is announced", () => {
  it("announces a new ready pull request, a draft made ready, and an approved one whose tree changed", () => {
    assert.equal(announceReason(null, false), "new");
    assert.equal(announceReason({ draft: true, approved: false, changed: true }, false), "new");
    assert.equal(announceReason({ draft: false, approved: true, changed: true }, false), "re-review");
    assert.equal(announceReason({ draft: true, approved: true, changed: true }, false), "re-review");
  });

  it("does not announce a draft, an unapproved ready one that was updated, or an approved one whose tree did not change", () => {
    assert.equal(announceReason(null, true), null);
    assert.equal(announceReason({ draft: false, approved: true, changed: true }, true), null);
    assert.equal(announceReason({ draft: false, approved: false, changed: true }, false), null);
    assert.equal(announceReason({ draft: false, approved: true, changed: false }, false), null);
  });

  it("takes only pull request outcomes marked for announcing", () => {
    const prs = announcements([
      { label: "a", outcome: { kind: "pr", url: URL1, draft: false, announce: "new", facts: LOCKFILE.facts } },
      { label: "b", outcome: { kind: "pr", url: URL2, draft: true, announce: null, facts: MAJOR.facts } },
      { label: "c", outcome: { kind: "pr", url: URL3, draft: false } },
      { label: "d", outcome: { kind: "none", reason: "x" } },
    ]);
    assert.deepEqual(prs, [LOCKFILE]);
  });
});

describe("the announcement queue", () => {
  it("queues the pull requests due now and leaves the state alone when there are none", () => {
    const state = queueAnnouncement(emptyState(), 12, [LOCKFILE], NOW);
    assert.deepEqual(pendingAnnouncement(state, 12), { prs: [LOCKFILE], queuedAt: NOW.toISOString(), attempts: 0, nextAt: NOW.toISOString(), lastError: null });
    const empty = emptyState();
    assert.equal(queueAnnouncement(empty, 12, [], NOW), empty);
  });

  it("merges with a pending announcement by URL, the newer reason winning, and keeps the attempt", () => {
    const attempted = recordAttempt(emptyState(), 12, { bodyHash: "h", headSha: "s", attemptedAt: "t", outcome: "pr-opened", prUrls: [URL1] });
    const first = queueAnnouncement(attempted, 12, [LOCKFILE, MAJOR], NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const second = queueAnnouncement(first, 12, [{ ...LOCKFILE, reason: "re-review" }], later);
    assert.deepEqual(pendingAnnouncement(second, 12)!.prs, [MAJOR, { ...LOCKFILE, reason: "re-review" }]);
    assert.equal(pendingAnnouncement(second, 12)!.nextAt, later.toISOString());
    assert.equal(second.tickets["12"]!.attempt!.prUrls[0], URL1);
  });

  it("backs off from five minutes, doubling up to two hours", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map((attempts) => retryDelay(attempts) / 60_000), [5, 10, 20, 40, 80, 120, 120]);
  });
});

describe("the message", () => {
  it("splits re-reviews from new pull requests", () => {
    assert.deepEqual(messageGroups([LOCKFILE, { ...MAJOR, reason: "re-review" }, SECOND_MAJOR]), [
      { reReview: false, prs: [LOCKFILE, SECOND_MAJOR] },
      { reReview: true, prs: [{ ...MAJOR, reason: "re-review" }] },
    ]);
    assert.deepEqual(messageGroups([MAJOR]), [{ reReview: false, prs: [MAJOR] }]);
  });

  it("falls back to the title for one pull request and to a fixed sentence for several", () => {
    assert.equal(fallbackSentence([MAJOR]), "Upgrade vite to 6.4.4 (major)");
    assert.equal(fallbackSentence([LOCKFILE, MAJOR]), "Fix 2 vulnerable packages in package-lock.json and upgrade vite to 6.4.4 (major)");
    assert.equal(fallbackSentence([LOCKFILE, MAJOR, SECOND_MAJOR]), "Fix 2 vulnerable packages in package-lock.json and upgrade vite and svelte-check across a major version");
    assert.equal(fallbackSentence([LOCKFILE, { ...LOCKFILE, url: URL3 }]), "Fix 4 vulnerable packages in 2 lockfiles");
  });

  it("renders the linked ticket, the sentence and one linked URL per line, escaping text", () => {
    const html = renderMessage({ ticket: 12, ticketUrl: "https://github.com/acme-org/acme-tickets/issues/12", sentence: "Fix <b>a</b> & b", reReview: false, urls: [URL1, URL2] });
    assert.equal(
      html,
      `<a href="https://github.com/acme-org/acme-tickets/issues/12">12</a> - Fix &lt;b&gt;a&lt;/b&gt; &amp; b<br><a href="${URL1}">${URL1}</a><br><a href="${URL2}">${URL2}</a>`,
    );
    assert.match(renderMessage({ ticket: 12, ticketUrl: "u", sentence: "Upgrade vite", reReview: true, urls: [URL1] }), /^<a href="u">12<\/a> - Re-review: Upgrade vite<br>/);
  });

  it("reads only github.com pull request URLs", () => {
    assert.deepEqual(pullLocation(URL1), { org: "acme-org", repo: "acme-api", number: 1 });
    for (const url of ["https://github.com/acme-org/acme-api/pull/1/files", "http://github.com/acme-org/acme-api/pull/1", "https://evil.example/acme-org/acme-api/pull/1", "https://github.com/acme-org/acme-api/issues/1"]) {
      assert.equal(pullLocation(url), null, url);
    }
  });
});

describe("the model-written sentence", () => {
  it("accepts a plain sentence that uses only names, versions and counts from the facts", () => {
    const prs = [LOCKFILE, MAJOR];
    assert.equal(checkSentence("Fix 2 vulnerable packages in package-lock.json and upgrade vite to 6.4.4", prs), "Fix 2 vulnerable packages in package-lock.json and upgrade vite to 6.4.4");
    assert.equal(checkSentence('"Upgrade vite to 6 and patch minimist and left-pad."', prs), "Upgrade vite to 6 and patch minimist and left-pad");
  });

  it("rejects links, mentions, markup, several lines, overlong text and names or versions not in the facts", () => {
    const prs = [LOCKFILE, MAJOR];
    for (const text of [
      "",
      "Upgrade vite, see https://evil.example",
      "Upgrade vite, see www.evil.example",
      "Upgrade vite @channel",
      "Upgrade **vite**",
      "Upgrade [vite](x)",
      "Upgrade vite <b>now</b>",
      "Upgrade vite\nand more",
      `Upgrade vite ${"and more ".repeat(20)}`,
      "Upgrade vite to 7.0.0",
      "Upgrade react-dom and vite",
      "Fix 7 vulnerable packages",
    ]) {
      assert.equal(checkSentence(text, prs), null, text);
    }
  });

  it("gives the model only host facts and falls back when its sentence fails the check or the call fails", async () => {
    const seen: ChatMessage[][] = [];
    const model = (reply: string | Error) => ({
      async chat(messages: ChatMessage[]) {
        seen.push(messages);
        if (reply instanceof Error) throw reply;
        return { message: { role: "assistant" as const, content: reply }, usage: { promptTokens: 0, outputTokens: 0, durationMs: 0, truncated: false } };
      },
    });
    assert.equal(await writeSentence(model("Fix minimist and left-pad and upgrade vite to 6.4.4"), "acme-api", [LOCKFILE, MAJOR]), "Fix minimist and left-pad and upgrade vite to 6.4.4");
    assert.equal(seen[0]![1]!.content, sentenceFacts("acme-api", [LOCKFILE, MAJOR]));
    assert.match(seen[0]![1]!.content, /- major upgrade in web\/package-lock\.json: vite 5\.4\.21 to 6\.4\.4 \(title: Upgrade vite to 6\.4\.4 \(major\)\)/);
    assert.equal(await writeSentence(model("Click https://evil.example"), "acme-api", [MAJOR]), "Upgrade vite to 6.4.4 (major)");
    assert.equal(await writeSentence(model(new Error("ollama down")), "acme-api", [MAJOR]), "Upgrade vite to 6.4.4 (major)");
    assert.equal(await writeSentence(null, "acme-api", [MAJOR]), "Upgrade vite to 6.4.4 (major)");
  });
});

describe("re-checking before posting", () => {
  it("keeps only open, ready pull requests in the org by the bot", async () => {
    const pulls: Record<string, PullDetails> = {
      [URL1]: details(URL1),
      [URL2]: details(URL2, { draft: true }),
      [URL3]: details(URL3, { author: "someone" }),
    };
    const closed = { ...LOCKFILE, url: "https://github.com/acme-org/acme-api/pull/4" };
    pulls[closed.url] = details(closed.url, { state: "merged" });
    const foreign = { ...LOCKFILE, url: "https://github.com/other-org/acme-api/pull/5" };
    const deps = { org: "acme-org", bot: "acme-proseco", pull: async (location: { org: string; repo: string; number: number }) => pulls[`https://github.com/${location.org}/${location.repo}/pull/${location.number}`]! };
    assert.deepEqual(await stillAnnounceable(deps, [LOCKFILE, MAJOR, SECOND_MAJOR, closed, foreign]), [LOCKFILE]);
  });
});

interface Delivery {
  deps: DeliveryDeps;
  state: State;
  sent: string[];
  gaveUp: [number, string][];
  log: string[];
}

function delivery(state: State, options: { now?: Date; send?: (html: string, count: number) => Promise<void>; pulls?: Record<string, PullDetails> } = {}): Delivery {
  const result: Delivery = { deps: undefined as never, state, sent: [], gaveUp: [], log: [] };
  result.deps = {
    org: "acme-org",
    bot: "acme-proseco",
    ticketUrl: (ticket) => `https://github.com/acme-org/acme-tickets/issues/${ticket}`,
    pull: async (location) => {
      const url = `https://github.com/${location.org}/${location.repo}/pull/${location.number}`;
      return options.pulls?.[url] ?? details(url);
    },
    sentence: async (_repo, prs) => fallbackSentence(prs),
    loadState: () => result.state,
    saveState: (next) => void (result.state = next),
    send: async (html) => {
      if (options.send) await options.send(html, result.sent.length);
      result.sent.push(html);
    },
    gaveUp: async (ticket, reason) => void result.gaveUp.push([ticket, reason]),
    now: () => options.now ?? NOW,
    log: (line) => void result.log.push(line),
  };
  return result;
}

describe("delivering announcements", () => {
  it("posts a due announcement and clears it", async () => {
    const run = delivery(queueAnnouncement(emptyState(), 12, [LOCKFILE, MAJOR], NOW));
    await deliverAnnouncements(run.deps);
    assert.equal(run.sent.length, 1);
    assert.match(run.sent[0]!, /^<a href="https:\/\/github\.com\/acme-org\/acme-tickets\/issues\/12">12<\/a> - Fix 2 vulnerable packages/);
    assert.equal(pendingAnnouncement(run.state, 12), undefined);
    assert.match(run.log[0]!, /#12 announced in Teams/);
  });

  it("leaves an announcement that is not due yet", async () => {
    const run = delivery(queueAnnouncement(emptyState(), 12, [LOCKFILE], new Date(NOW.getTime() + 60_000)));
    await deliverAnnouncements(run.deps);
    assert.deepEqual(run.sent, []);
    assert.ok(pendingAnnouncement(run.state, 12));
  });

  it("drops pull requests that were closed or made draft meanwhile, and posts nothing when none is left", async () => {
    const run = delivery(queueAnnouncement(emptyState(), 12, [LOCKFILE], NOW), { pulls: { [URL1]: details(URL1, { state: "closed" }) } });
    await deliverAnnouncements(run.deps);
    assert.deepEqual(run.sent, []);
    assert.equal(pendingAnnouncement(run.state, 12), undefined);
  });

  it("keeps a failed announcement with a later retry, and only the pull requests not yet posted", async () => {
    const state = queueAnnouncement(emptyState(), 12, [LOCKFILE, { ...MAJOR, reason: "re-review" }], NOW);
    const run = delivery(state, {
      send: async (_html, count) => {
        if (count === 1) throw new Error("Teams post failed: 403 Forbidden BotNotInConversationRoster");
      },
    });
    await deliverAnnouncements(run.deps);
    assert.equal(run.sent.length, 1);
    const pending = pendingAnnouncement(run.state, 12)!;
    assert.deepEqual(pending.prs, [{ ...MAJOR, reason: "re-review" }]);
    assert.equal(pending.attempts, 1);
    assert.equal(pending.nextAt, new Date(NOW.getTime() + 5 * 60_000).toISOString());
    assert.match(pending.lastError!, /BotNotInConversationRoster/);
    assert.deepEqual(run.gaveUp, []);
  });

  it("gives up after a day, notes it on the ticket and clears it", async () => {
    const state = queueAnnouncement(emptyState(), 12, [LOCKFILE], NOW);
    const run = delivery(state, {
      now: new Date(NOW.getTime() + GIVE_UP_MS),
      send: async () => {
        throw new Error("Teams sign-in failed: 401");
      },
    });
    await deliverAnnouncements(run.deps);
    assert.deepEqual(run.gaveUp, [[12, "Teams sign-in failed: 401"]]);
    assert.equal(pendingAnnouncement(run.state, 12), undefined);
    assert.match(run.log[0]!, /giving up/);
  });

  it("retries when re-checking a pull request fails", async () => {
    const run = delivery(queueAnnouncement(emptyState(), 12, [LOCKFILE], NOW));
    run.deps.pull = async () => {
      throw new Error("read pull request #1 failed: 502");
    };
    await deliverAnnouncements(run.deps);
    assert.deepEqual(run.sent, []);
    assert.equal(pendingAnnouncement(run.state, 12)!.attempts, 1);
  });
});
