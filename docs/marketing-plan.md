# MQLens discovery and marketing operations

The initial audience is developers choosing a MongoDB desktop GUI. The main action is downloading the correct installer; contributors and database administrators are secondary audiences. This document maps the implemented pages to search questions and records the external setup and recurring work needed after launch.

## Search intent map

| Question or intent | Landing page | Useful next step |
| --- | --- | --- |
| Free open-source MongoDB GUI | `/` | View workspace and download |
| MongoDB client for Mac | `/mongodb-client-for-mac/` | Choose Apple Silicon or Intel |
| MongoDB client for Windows | `/mongodb-client-for-windows/` | Choose Windows installer |
| MongoDB GUI for Linux | `/mongodb-gui-for-linux/` | Choose package format |
| Compass alternative | `/compare/mongodb-compass-alternative/` | Compare an actual workflow |
| Studio 3T alternative | `/compare/studio-3t-alternative/` | Check specialized requirements |
| Robo 3T alternative | `/compare/robo-3t-alternative/` | Validate one test connection |
| NoSQLBooster alternative | `/compare/nosqlbooster-alternative/` | Validate existing queries |
| MongoDB aggregation GUI | `/mongodb-aggregation-pipeline-gui/` | Follow `/guides/mongodb-aggregation-gui/` |
| MongoDB explain-plan GUI | `/mongodb-explain-plan-gui/` | Follow `/guides/read-mongodb-explain-plan/` |
| Connect MongoDB over SSH | `/mongodb-ssh-tunnel-gui/` | Follow `/guides/connect-mongodb-ssh-tunnel/` |
| Inspect a MongoDB schema | `/mongodb-schema-analysis-tool/` | See field types and presence |
| Browse GridFS files | `/mongodb-gridfs-gui/` | Download and inspect files |
| MongoDB GUI without telemetry | `/mongodb-gui-no-telemetry/` | Understand optional network requests |
| MongoDB MCP server | `/mongodb-mcp-server/` | Read tool reference and access controls |
| MongoDB AI query assistant | `/mongodb-ai-query-assistant/` | Review provider setup and data handling |
| MQLens demo | `/demo/` | Watch, explore workflows, download |

These are intent hypotheses, not search-volume estimates. Use query data to refine them. Expand an existing guide before creating another page that answers the same question.

## Implemented discovery foundation

The site renders its important content as static HTML. Pages have individual descriptions, canonical URLs, social previews, internal links, and software/organization metadata. Interior pages have visible breadcrumbs and matching structured data. The demo has a stable video URL, poster, captions, a workflow summary, and `VideoObject` metadata. The sitemap excludes the 404 page. Browser checks validate routes, metadata, local assets, navigation, and download fallbacks.

`robots.txt` already permits crawlers. No special AI text file, fake review markup, tracking beacon, or automatic outbound submission is added. Google says normal SEO fundamentals apply to its AI search features and does not require an AI text file or special schema. [Google guidance](https://developers.google.com/search/docs/appearance/ai-features).

## Owner setup after deployment

| Action | Required access | Verification |
| --- | --- | --- |
| Verify domain in Google Search Console | Existing Search Console owner or DNS administrator | Domain property verified; sitemap accepted; inspect home/demo and two workflow URLs |
| Verify site in Bing Webmaster Tools | Existing owner or DNS administrator | Sitemap accepted; URL inspection and crawl reports accessible |
| Inspect CDN and bot rules | Hosting/Cloudflare owner | Legitimate search crawlers receive public HTML without a challenge; verify identity using provider guidance |
| Refresh GitHub description, topics, and social preview | Repository maintainer | Metadata matches launch kit and uses current preview |
| Review canonical host and redirects | Hosting owner | HTTPS and preferred hostname resolve consistently; unknown pages return 404 |
| Publish selected launch material | Owner of the chosen account | Check the exact draft and current community rules before submitting |

These external actions are prepared, not executed. Account ownership, DNS configuration, production CDN behavior, indexing status, and dashboards have not been verified in this local implementation. Do not request or store account passwords in the repository.

For search discovery, check OAI-SearchBot and PerplexityBot as well as Googlebot and Bingbot. Search crawler permissions and model-training preferences are separate choices. [OpenAI publisher guidance](https://help.openai.com/en/articles/12627856-publishers-and-developers-faq), [Perplexity crawler guidance](https://docs.perplexity.ai/docs/resources/perplexity-crawlers).

IndexNow remains an optional hosting follow-up: the existing sitemap is sufficient for the initial release, and the hosting integration has not been verified. If enabled later, use a verified site key and submit only changed URLs after deployment. Submission does not guarantee indexing. [IndexNow documentation](https://www.indexnow.org/documentation).

## Baseline and scorecard

Local baseline reviewed: October 4, 2026, source `7a26138`. The original site generated 21 pages. The refreshed production build generates 25 pages. Search metrics below are unavailable without the owner's dashboards; unavailable does not mean zero.

| Metric | Baseline | Review source |
| --- | --- | --- |
| Indexed priority pages | Not available | Google/Bing URL inspection |
| Branded and non-branded impressions/clicks | Not available | Search performance exports |
| AI citations and linked pages | Not measured | Fixed prompt samples; Bing AI Performance where available |
| Qualified referral visits | Not available | Existing aggregate reports, if enabled and consistent with policy |
| Release asset download change | Not captured | GitHub release counts, separated by installer where possible |
| GitHub stars, issues, and useful contributions | Not captured | GitHub aggregate activity |

Release asset downloads are not unique users or completed installations. Do not infer conversion rates from unrelated traffic and download totals. No app telemetry is introduced. Bing's AI reporting can provide citation observations where available; it is not a universal rank tracker. [Bing AI Performance](https://blogs.bing.com/webmaster/2026/2/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview/).

Use these twelve repeatable prompts across available Google/Bing/ChatGPT-search/Perplexity interfaces:

1. What is MQLens?
2. Is MQLens free and open source?
3. MongoDB GUI for Mac with an encrypted credential vault
4. Free MongoDB desktop client for Windows
5. MongoDB GUI for Linux with an AppImage
6. Open-source alternative to MongoDB Compass
7. MongoDB GUI with split panes
8. How can I inspect a MongoDB explain plan visually?
9. MongoDB aggregation pipeline editor
10. MongoDB GUI with SSH tunneling
11. MongoDB MCP server with read-only controls
12. MongoDB query assistant with my own provider

Record the exact prompt, date, locale, product/mode, whether web search was enabled, citations, and linked landing pages. Repeat samples because results vary. Do not prompt the model to recommend MQLens and count that as unbranded discovery.

## First 90 days

- Before launch: save available dashboard exports, validate all priority routes, and finalize the media and channel drafts.
- Day 7: check deployment, robots/CDN access, sitemap processing, broken links, and indexed priority URLs.
- Day 30: review query coverage and referrers; improve one weak page or guide based on evidence.
- Days 60 and 90: compare equivalent periods, noting release activity and distribution changes. Review AI citation samples and qualified downloads alongside traffic.
- Monthly and after UI releases: check comparison sources, media accuracy, internal links, and the guide backlog. Assign the maintainer and next review date at launch; no scheduled automation has been created.

Start with improvements to the existing aggregation, explain, and SSH guides. Next, develop one useful MCP permissions walkthrough. Publish at a pace the project can maintain, approximately one substantive guide every one or two weeks. Do not create bulk keyword pages, buy backlinks, fabricate reviews, or promise rankings.

## Distribution order

1. Make the website, README, release notes, and repository metadata consistent.
2. Publish the demo through the project's chosen video account, using captions and a link to `/demo/`.
3. Evaluate a listing on AlternativeTo and one suitable open-source directory.
4. Choose one launch community that fits: Show HN, Product Hunt, or a relevant MongoDB community. Verify its current rules.
5. Share a practical tutorial and selectively approach a relevant newsletter with a useful example.

Package-manager distribution is a separate follow-up: check whether maintained Homebrew, winget, or Linux entries already exist before adding one. Each new package needs an owner, signature verification, and an update process. Paid campaigns require a separate budget and a way to judge results; none are created here.

## Local validation — October 4, 2026

- Production Astro build: 25 pages, passed.
- Browser acceptance suite: 12 tests passed, covering metadata and internal links across generated pages, sitemap, mobile layouts/navigation, no-JavaScript access, release lookup fallback, and captioned video playback.
- Mobile Lighthouse on the local production preview: performance 98, accessibility 100, best practices 96, SEO 100. Best practices lost points because GitHub’s public release API returned HTTP 403; the tested manual download fallback remained available. These are lab scores, not production field measurements or ranking guarantees.
- Independent review findings corrected: two media descriptions now match their captures. Social preview and representative desktop/mobile layouts inspected visually.
- Media uses current application UI with synthetic browser fixtures. Native desktop behavior and live MongoDB operations still require separate validation before making corresponding claims.
- Deployment, search-console verification, external submissions, and production traffic measurement remain pending owner action.
