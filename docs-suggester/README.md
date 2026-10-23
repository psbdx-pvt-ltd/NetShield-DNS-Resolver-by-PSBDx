# Docs suggester (demo)

When someone opens an issue, find the most relevant page from a **documentation
RSS/Atom feed** and suggest it in a comment. No AI model, no API key, no cost,
no dependencies: plain Node.js (18+).

This is a demo. It points at the Cloudflare blog feed (`https://blog.cloudflare.com/rss/`)
only because it is a public feed that is always available. Point it at your wiki feed
when that exists (see "Use your own feed").

## How it works

```
issue opened
   |
   +--> fast job (existing issue-filter): form checks, version question   <- untouched
   |
   +--> this job (separate, parallel, 3 min timeout):
          1. download the feed (https only, 10 s timeout, 2 MB cap)
          2. read RSS or Atom entries (title, summary, categories, start of content)
          3. score every entry against the issue with BM25 keyword matching
             (title boost, light stemming, synonyms from synonyms.json)
          4. only if the match is strong: post "These docs may help" with 1-2 links
          5. otherwise stay silent
```

A wrong hint looks worse than no hint, so it stays silent unless **at least 2
informative terms match** in the entry's title, tags or summary **and** the score
passes a threshold. Matched terms are printed so you can see why it chose a page.

## Safety

- Feed content and issue text are both untrusted.
- Links are only posted if they are `https` and on the feed's own host
  (or hosts listed in `DOCS_ALLOWED_HOSTS`, comma separated). Look-alike hosts
  (`wiki.example.org.evil.net`), `http:` and `javascript:` links are rejected.
- Titles are escaped: no `@mentions`, no markdown or HTML injection.
- Issue text never goes into a URL or a shell command (it reaches the script
  through environment variables only).
- It can never fail the job: any problem (feed down, bad XML, timeout) becomes
  status `skipped` with a warning, and nothing is posted.

## Try it

Locally (Termux, Linux, anywhere with Node 18+):

```sh
node --test docs-suggester/suggest.test.js          # 16 tests, offline
node docs-suggester/suggest.js \
  --title "php2shell vulnerability and managed rules" \
  --body  "do WAF rules protect us?"                # live feed, prints scores + timings
```

Useful options: `--feed URL`, `--feed-file path.xml` (offline), `--min-score N`,
`--min-terms N`, `--json-out f.json`, `--md-out comment.md`, `--summary file.md`.

On GitHub: pushing to the `demo/docs-suggester` branch runs the tests and a
live-feed check. Open the run, then **Summary**: it shows timings for each step,
what the matcher saw, and the comment it would post. After merging into the default
branch you can also use **Actions -> Docs Suggester (Demo) -> Run workflow** with your
own title and body.

## Timing

The job summary reports, per run: fetch, parse + index, match, and script total.
For real issues it also reports **issue created -> now**, which includes runner
start-up, so you get the real reply delay your users see. The script itself is
fast; almost all of the time is the network fetch plus GitHub starting the runner.
This job runs in parallel with the fast job, so it cannot slow down the version question.

## Use your own feed

Anything that serves RSS 2.0 or Atom works. To get good matches, make each page's
feed entry carry:

- a clear **title**
- a one-sentence **description** that uses the words users would type
- **categories/tags**: error strings the page solves (`UnknownHostException`,
  `port 853`), device brands, modes (`DNS Server Mode`)

Set the feed URL with the repo variable `DOCS_FEED_URL` (Settings -> Secrets and
variables -> Actions -> Variables). If your docs are on another host than the feed,
add it with `DOCS_ALLOWED_HOSTS`.

### Curate `synonyms.json`

Each line maps a word to a shared meaning (`"battery": ["drain", ...]`) so "drains"
finds the battery page. Be careful: **ambiguous words create false matches.** While
testing against a real feed, "hot", "power", "charge" and "language" all matched
unrelated posts ("off the hot path", "powerful", "free of charge", "programming
language") and were removed. Test new synonyms against your real feed before keeping them.

## Limits

- It finds your pages; it cannot reason about a bug nobody documented.
- English keyword stemming only. Bengali text is tokenized but not stemmed, and
  romanized Bengali ("ami app khulte parchi na") will match poorly.
- The best next step for meaning-based matching is a second, separate job that
  uses a small free embedding model. It is intentionally not part of this demo.
