# MQLens launch kit

These are drafts for the project owner to adapt and publish after deployment. Nothing has been submitted or sent.

## Consistent product description

**Name:** MQLens

**One line:** A free, open-source desktop workspace to browse, query, and understand MongoDB.

**Short description:** MQLens brings document browsing, aggregation pipelines, explain plans, and split panes into one MongoDB desktop app for macOS, Windows, and Linux. Credentials are encrypted locally. AI assistance and MCP access are optional.

**Long description:** Explore MongoDB documents as a table, tree, or JSON, build aggregation pipelines, and inspect explain plans without leaving your workspace. MQLens supports SSH and TLS connections, schema analysis, index management, GridFS, and an embedded mongosh shell. Arrange your work with split panes and detachable tabs. Connection settings are encrypted locally, and read-only or destructive-operation controls help you work deliberately. The app is free under Apache-2.0, requires no account, and collects no app telemetry. Optional AI providers and agent clients have their own data handling and usage requirements.

**Website:** https://mqlens.com/

**Download:** https://mqlens.com/#download

**Demo:** https://mqlens.com/demo/

**Source:** https://github.com/mqlens/mqlens-mongodb

**Suggested GitHub topics:** mongodb, mongodb-gui, database-client, aggregation, tauri, rust, react, mcp, open-source.

**Assets:** `website/public/og.png`, `website/public/favicon.svg`, `website/public/screenshots/mqlens-workspace.png`, `website/public/screenshots/mqlens-aggregation.png`, `website/public/screenshots/mqlens-explain-plan.png`, `website/public/demo.mp4`, `assets/demo.gif`. Interface previews use synthetic data; do not present fixture statistics as benchmarks.

## Release announcement draft

MQLens has a new website and a clearer introduction to the workspace. The updated demo shows document browsing, aggregation pipelines, and explain plans, with current screenshots throughout the site and README.

If you're looking for a free MongoDB desktop GUI, you can explore the demo and find an installer for macOS, Windows, or Linux at https://mqlens.com/. MQLens is open source under Apache-2.0.

Feedback on the workflows and getting-started experience is welcome through the repository's issue tracker.

## Show HN draft

**Title:** Show HN: MQLens, an open-source desktop workspace for MongoDB

**Link:** https://mqlens.com/

**First comment:** I'm building MQLens, a free MongoDB desktop app with document browsing, aggregation pipelines, explain plans, split panes, and optional AI/MCP workflows. It's built with Tauri, Rust, React, and TypeScript. Connection credentials are encrypted locally and the app has no telemetry. The site includes a short interface demo with synthetic data. I'd appreciate feedback on the query workflow and what makes a database GUI useful in your day-to-day work.

Use the first-person version only when the posting account belongs to the builder. Check the current Show HN rules and adapt the introduction before posting; do not request votes.

## Directory or Product Hunt draft

**Tagline:** Browse, query, and understand MongoDB.

**Description:** A free, open-source MongoDB desktop workspace for macOS, Windows, and Linux. Explore documents, build aggregations, inspect explain plans, and arrange your work in split panes. Local credential encryption and optional AI/MCP workflows are included.

**Suggested gallery order:** Workspace, document table, aggregation, explain plan, MCP controls.

Check current submission eligibility, field limits, listing ownership, and license information on the chosen platform. Avoid publishing duplicate listings.

## Video upload draft

**Title:** MQLens demo: browse MongoDB documents, build aggregations, and inspect explain plans

**Description:** A short look at the MQLens desktop interface using synthetic sample data. Explore documents, switch views, build an aggregation, and inspect a query plan. The demo is a UI walkthrough, not a performance benchmark.

Download: https://mqlens.com/#download

Transcript and guide links: https://mqlens.com/demo/

Source: https://github.com/mqlens/mqlens-mongodb

Upload the supplied captions. Add chapters only after checking their timestamps against the encoded video. Use the current poster or workspace screenshot as the thumbnail.

## Tutorial draft outline

**Working title:** Read your first MongoDB explain plan in MQLens

Start with a synthetic collection and a concrete query. Show the filter, the explain view, what the plan stages mean, and the difference between documents examined and returned. Explain when an index might help and why small demo data is not a performance benchmark. Link the runnable demo database recipe, the existing explain guide, and the official MongoDB explain documentation.

## Individual newsletter outreach draft

**Subject:** An open-source MongoDB desktop workspace for your developer tools roundup

Hi [editor name],

Your [specific article or section] covers practical database tools. MQLens is a free Apache-2.0 MongoDB desktop app with document browsing, aggregation pipelines, explain plans, and split panes. The updated demo and screenshots show the current interface: https://mqlens.com/demo/.

If it fits your readers, the source and installers are linked from https://mqlens.com/. I'm happy to provide a concrete walkthrough or answer questions about the project.

[Project maintainer name]

Replace the recipient-specific fields with genuine context before sending. This is a draft, not a mailing list or permission to send messages.
