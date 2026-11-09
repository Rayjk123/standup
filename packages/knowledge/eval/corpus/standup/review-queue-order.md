---
title: "How the Reviews tab orders and filters packets"
tags: [review-packet, console, reviews-tab, ordering]
origin_class: agent
source_kind: spec
last_verified_at: "2026-10-01T00:00:00.000Z"
---
The console's Reviews tab lists the owner's review packets as cards. The collector decides the order; the web list
renders the array it gets from `GET /api/reviews?status=<filter>` as is and never re-sorts it.

## Order

`listReviewPackets` sorts by `created_at` descending, then by `rowid` descending, so two packets created in the same
millisecond still come back in a stable order (the one inserted later first). `updated_at` plays no part: deciding a
packet, answering one of its questions or attaching media does not move its card.

What moves a card is a new row. When a worker enters human review, the collector reuses the launch's open draft or
creates a fresh one, and the worker submits that draft. A draft created for a second round is a new row with a new
`created_at`, so after it is submitted it sits above the packet it replaces. A worker that resubmits the packet that
is already pending writes into the same row: the revision number goes up but the card keeps its place.

The list returns at most 100 packets by default; a caller can ask for up to 500 and no more.

## Filters

The tab offers two filters, Pending (the default) and All.

- **Pending** asks for `status=pending`: packets waiting on the owner's decision.
- **All** leaves the status out, which returns every packet except drafts. A draft only shows up when a caller names
  `draft` explicitly; the tab never does.
- Any other status value is rejected with a 400 that lists the accepted ones (`draft`, `pending`, `approved`,
  `changes_requested`, `superseded`).

## What a submission does to older packets

Submitting a packet for a launch marks every other pending packet for the same owner and launch `superseded`, in the
same transaction. So a launch never has two cards under Pending. Under All the superseded packet keeps its old
position, below the revision that replaced it, with a grey Superseded badge.

The same transaction moves the owner's questions and the workers' answers onto the new revision, removes the
superseded packet's media rows, and revokes its share links (a link to it would show a revision that is no longer
current). Plain remarks stay on the old packet.

## Counts on the card and in the nav

- A card's open-question count is computed only for pending packets: questions that went to the worker and have no
  answer yet. Decided and superseded packets always show zero.
- The tab's badge comes from `GET /api/reviews/pending-count`, which counts the owner's pending packets. Every
  `review:updated` frame sent to the owner is followed by a `reviews:pending` frame with the fresh count, so the
  badge stays live on each of the owner's sockets; the list itself refetches on `review:updated`.
