# MQLens promotion media

The public screenshots and demo show the current React interface using synthetic browser-harness data. They are UI previews, not evidence of live database performance or native window behavior. No real database, account, API key, or connection secret is used.

## Capture provenance

- Source revision: `7a26138` (the application source at the start of this refresh).
- App package and fixture version: `0.21.0`. The closest repository tag is `mqlens-v0.21.1-252`; the fixture version is not a claim about the latest published release.
- Capture date: October 4, 2026.
- Renderer: Playwright Chromium, 1600 × 1000 CSS pixels, scale 1, dark theme.
- Data: deterministic customer/order fixtures in `scripts/capture-marketing.ts`, using `localhost` and `example.com`. Query replies, plan statistics, AI output, shell replies, and MCP state come from the browser harness.
- Native detached-window and live MongoDB verification: not performed by this capture workflow. Do not label these assets as native multi-window captures or benchmark results.

## Asset inventory

All basenames below live in `website/public/screenshots/`, with a PNG master and WebP display variant.

| Basename | Subject | Placements |
| --- | --- | --- |
| mqlens-workspace | Table and JSON panes | Homepage, README, comparison pages, workspace feature, social preview |
| mqlens-workspace-mobile | Detail captured from the left workspace pane | Mobile homepage |
| mqlens-documents | Customer table | Homepage, platform pages, docs, document feature |
| mqlens-tree | Nested document tree | Detailed gallery or future guide use |
| mqlens-json | Raw document JSON | Detailed gallery or future guide use |
| mqlens-aggregation | Grouped customer/seat totals | Homepage, README, aggregation page and guide |
| mqlens-explain-plan | Plan stages with synthetic statistics | Gallery, README, explain landing page |
| mqlens-visual-builder | Region filter builder | Query feature |
| mqlens-index-detail | Unique email index | Index feature |
| mqlens-schema | Sampled document structure | Gallery, schema landing page |
| mqlens-gridfs | Synthetic files | Gallery, GridFS landing page and feature |
| mqlens-mongosh | Sample shell query | Shell feature |
| mqlens-ai-assistant | Canned sample query draft | Homepage, AI feature and landing page |
| mqlens-data-generation | Generator template | Data generation feature |
| mqlens-mcp | MCP settings, hidden synthetic token | MCP feature and landing page |
| mqlens-safeguards | Read-only connection | Safeguards feature |
| mqlens-connection-manager | Saved local connection | Connection and security features |
| mqlens-new-connection | Localhost setup | Authentication feature |
| mqlens-quick-start | Quick start | Privacy landing page |

The recording exports to `website/public/demo.mp4`, the README animation to `assets/demo.gif`, the poster to `website/public/demo-poster.jpg`, and captions to `website/public/demo-en.vtt`. Video metadata is recorded in `website/src/data/demo.json`. The social preview has an editable SVG master and PNG export at `website/public/og.svg` and `og.png`.

## Repeat the capture

From the repository root, install the locked root and website dependencies and Playwright Chromium. Use Node 22.12 or later.

```sh
npm ci
npm ci --prefix website
npx playwright install chromium
CAPTURE_ONLY=main npm run media:capture
CAPTURE_ONLY=extras npm run media:capture
CAPTURE_ONLY=workspace npm run media:capture
CAPTURE_ONLY=connections npm run media:capture
CAPTURE_ONLY=tools npm run media:capture
CAPTURE_ONLY=safeguards npm run media:capture
node website/scripts/optimize-media.mjs
python3 scripts/render-marketing-video.py /path/to/ffmpeg
```

The capture configuration builds and serves the browser harness. Stop any older preview server on port 4173 before capturing changed application code: local runs may reuse it. An existing ffmpeg with H.264 and GIF support is required only for video export; it is not an app dependency. The encoder slows the recorded walkthrough for legibility, removes audio, and exports web-compatible H.264 with fast-start metadata.

Review the new video, update caption timings to match it, and update the capture date/version in this document and the metadata generator when recapturing. The poster and social image are built from the same screenshot set. The SVG remains editable and includes an embedded workspace image.

## Release review

When a release changes any featured workflow, recapture that workflow and review its captions, video, GIF, poster, and social preview together. Compare the browser preview with the shipped desktop build before public release. Use `docs/demo-database.md` for a real local MongoDB verification run; that seed script resets its dedicated demo database.

Run the website build and `npm run test:website`, open the README preview, and inspect the result on a narrow screen. Check that screenshots are readable and describe the pictured feature. Clear affected hosting caches when replacing static media. Never “refresh” a screenshot by changing its version label or inventing product UI.
