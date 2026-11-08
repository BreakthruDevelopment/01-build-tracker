# Board design review

Captured from a local production build with the existing 30-app demo seed.
Counts, activity, and summaries are sample data, not production observations.

| Screenshot | Viewport | Content |
| --- | --- | --- |
| [Desktop board](board-desktop.png) | 1440 × 1100 | Shared header, introduction, totals, filters, and active table |
| [Phone board](board-375.png) | 375 × 1200 | Stacked totals and wrapped filter controls |
| [Phone active apps](board-cards-375.png) | 375 × 1200 | Compact cards and full-width summaries |
| [Expanded phone backlog](backlog-375.png) | 375px viewport | Planned entries without health/CI placeholders |
| [Phone app details](app-detail-375.png) | 375 × 1200 | Public detail view |
| [Phone admin](admin-375.png) | 375 × 1200 | Configuration booleans and sync controls |

Browser checks covered filter submission and URL preservation, clearing filters,
backlog collapse/expansion, table/cards, dark mode, anonymous admin redirect (307),
unknown app (404), admin controls, and public/private control separation. All
visible interactive targets were at least 44px in both dimensions, no page overflow
was found at 375px or desktop, and no browser runtime errors were observed.
