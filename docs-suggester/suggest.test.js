"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const S = require("./suggest.js");

const fx = (n) => path.join(__dirname, "fixtures", n);
const syn = S.loadSynonyms(path.join(__dirname, "synonyms.json"));
const items = S.parseFeed(fs.readFileSync(fx("sample-rss.xml"), "utf8"));
const index = S.buildIndex(items, syn);
const HOSTS = ["wiki.example.org"];
const suggest = (title, body = "") => S.pick(S.rank(index, title, body, syn), HOSTS);
const FEED = "https://wiki.example.org/rss.xml";

test("parses RSS: entities decoded, CDATA unwrapped, tags stripped", () => {
  assert.equal(items.length, 9);
  const evil = items.find((i) => i.link.includes("evil.example.net"));
  assert.equal(evil.title, "Fix & tune battery drain @everyone");
  const dot = items.find((i) => i.link.endsWith("/dot-upstreams/"));
  assert.match(dot.content, /port 853 the app cannot reach/);
  assert.ok(!/[<>]/.test(dot.content));
  assert.deepEqual(dot.categories, ["DNS", "TLS"]);
});

test("parses Atom: rel=alternate link, summary, term categories", () => {
  const a = S.parseFeed(fs.readFileSync(fx("sample-atom.xml"), "utf8"));
  assert.equal(a.length, 2);
  assert.equal(a[0].link, "https://wiki.example.org/blocklist-guide/");
  assert.equal(a[0].title, "Blocklist & filter list guide");
  assert.equal(a[0].summary, "How to add a custom blocklist.");
  assert.deepEqual(a[1].categories, ["DNS", "TLS"]);
});

test("meaning without shared words: 'phone gets hot ... dies' finds the battery page", () => {
  const r = suggest("My phone gets hot and the vpn dies in the background", "huge drain on xiaomi");
  assert.ok(r.length >= 1);
  assert.ok(r[0].item.link.endsWith("/battery-and-background/"), r[0].item.link);
});

test("error string finds the DoT page", () => {
  const r = suggest("Upstream fails", "java.net.UnknownHostException: Unable to resolve host dns.adguard-dns.com on port 853");
  assert.ok(r.length >= 1);
  assert.ok(r[0].item.link.endsWith("/dot-upstreams/"), r[0].item.link);
});

test("unrelated text stays silent", () => {
  assert.deepEqual(suggest("How do I bake sourdough bread at home", "flour water salt"), []);
});

test("one generic word is not enough (needs >= 2 informative terms)", () => {
  assert.deepEqual(suggest("dns", ""), []);
  assert.deepEqual(suggest("app crashes", ""), []);
});

test("hostile links (other domain, javascript:, http:) are never suggested, even if they score best", () => {
  for (const q of [["battery drain autostart fix @everyone", ""], ["Verify APK signature fingerprint now", ""], ["dns over tls dot upstream port 853", "unknownhostexception"]]) {
    const scored = S.rank(index, q[0], q[1], syn);
    assert.ok(scored.slice(0, 2).some((s) => !S.isAllowedLink(s.item.link, HOSTS)), `precondition: a hostile entry should rank high for "${q[0]}"`);
    for (const p of S.pick(scored, HOSTS)) assert.ok(S.isAllowedLink(p.item.link, HOSTS), p.item.link);
  }
});

test("isAllowedLink: https only, exact host or subdomain, no look-alikes", () => {
  assert.ok(S.isAllowedLink("https://wiki.example.org/x", HOSTS));
  assert.ok(S.isAllowedLink("https://fr.wiki.example.org/x", HOSTS));
  assert.ok(!S.isAllowedLink("https://wiki.example.org.evil.net/x", HOSTS));
  assert.ok(!S.isAllowedLink("https://notwiki.example.org/x", HOSTS));
  assert.ok(!S.isAllowedLink("http://wiki.example.org/x", HOSTS));
  assert.ok(!S.isAllowedLink("javascript:alert(1)", HOSTS));
  assert.ok(!S.isAllowedLink("not a url", HOSTS));
});

test("never more than 2 suggestions", () => {
  assert.ok(suggest("dns tls vpn block battery install signature", "everything at once").length <= 2);
});

test("comment is safe: no pings, no markdown/link injection, user sanitised, marker present", () => {
  const c = S.buildComment([{ item: { title: "@everyone [click](http://evil.example) `x` <img src=x>", link: "https://wiki.example.org/a/" }, matched: ["dns", "@admin"] }], "bob\n@admin");
  assert.ok(c.startsWith(S.MARKER));
  assert.ok(!/@everyone/.test(c) && !/@admin/.test(c.split("matched")[1]));
  assert.ok(!/\]\(http:\/\/evil/.test(c));
  assert.ok(!/<img/.test(c));
  assert.match(c, /@bobadmin:/);
});

test("cleanIssueText drops form headers, checkboxes, 'No response' and code fences", () => {
  const { bodyPart } = S.cleanIssueText("t", "### Version Type\n\nStable\n\n- [x] I searched\n_No response_\n```shell\nboom\n```");
  assert.ok(!/###|I searched|No response|```/.test(bodyPart));
  assert.match(bodyPart, /Stable/);
  assert.match(bodyPart, /boom/);
});

test("run(): ok with a good match, with timings and a postable comment", async () => {
  const r = await S.run({ feedUrl: FEED, feedFile: fx("sample-rss.xml"), title: "Battery drain, vpn killed in background", body: "xiaomi", user: "alice" });
  assert.equal(r.status, "ok");
  assert.ok(r.comment.includes("[Fixing battery drain"));
  assert.equal(typeof r.timings.totalMs, "number");
  assert.equal(r.feed.items, 9);
});

test("run(): no-match stays silent", async () => {
  const r = await S.run({ feedUrl: FEED, feedFile: fx("sample-rss.xml"), title: "sourdough bread", body: "" });
  assert.equal(r.status, "no-match");
  assert.equal(r.comment, undefined);
});

test("run(): failures become 'skipped', never throw", async () => {
  const missing = await S.run({ feedUrl: FEED, feedFile: fx("does-not-exist.xml"), title: "x", body: "" });
  assert.equal(missing.status, "skipped");
  const empty = await S.run({ feedUrl: FEED, feedFile: fx("empty.xml"), title: "x", body: "" });
  assert.equal(empty.status, "skipped");
  assert.match(empty.reason, /no readable entries/);
  const http = await S.run({ feedUrl: "http://wiki.example.org/rss.xml", title: "x", body: "" });
  assert.equal(http.status, "skipped");
  assert.match(http.reason, /https/);
  const badUrl = await S.run({ feedUrl: "not a url", title: "x", body: "" });
  assert.equal(badUrl.status, "skipped");
});

test("run(): reports time since the issue was created", async () => {
  const r = await S.run({ feedUrl: FEED, feedFile: fx("sample-rss.xml"), title: "x", body: "", issueCreatedAt: new Date(Date.now() - 5000).toISOString() });
  assert.ok(r.timings.sinceIssueCreatedSec >= 4 && r.timings.sinceIssueCreatedSec <= 9, String(r.timings.sinceIssueCreatedSec));
});

test("speed: indexing + ranking 200 entries is far below a second", () => {
  const big = [];
  for (let i = 0; i < 200; i++) big.push({ title: `Guide ${i} about dns tls vpn topic${i}`, link: `https://wiki.example.org/g${i}/`, summary: "lorem ipsum ".repeat(60) + `unique${i}`, categories: ["DNS"], content: "word ".repeat(300) });
  const t = Date.now();
  const idx = S.buildIndex(big, syn);
  S.rank(idx, "dns tls problem", "x ".repeat(500), syn);
  assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
});
