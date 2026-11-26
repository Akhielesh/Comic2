# Rate a reply (Comic Studio)

Two quiet ink thumbs under the Director's replies let a person say whether a reply helped. The rating rides the same
mechanism, API and storage as general chat's thumbs (`components/feedback/FeedbackButtons.tsx`): one `user_feedback`
row per opinion, written by the server. No new table, no SQL.

## Which replies carry it

The Director's answer to something the person sent: after each user message (a note sent while the Director worked
counts), the first assistant message with words that background work did not post. A drawing's progress or outcome,
a translation, a publish result and the allowance notice carry `Msg.runAt` and are left out, and so is a reply that is
still streaming. Older comics need nothing new. Rule: `components/comicstudio/conversation/replyRating.ts`
`rateableReplyIds`, computed once per conversation in `ConversationPane`.

The newest such reply always shows its thumbs. On a pointer that can hover, older replies show theirs on hover or
when focus is inside the reply (keyboard), so a long history stays calm; a reply being rated always shows; touch
screens always show them.

## What a person does

| State | What shows |
|---|---|
| Not rated | Thumbs up "Good reply", thumbs down "Could be better" (muted ink toggle buttons in a group named "Rate this reply") |
| Thumbs up | Sent at once. The thumb fills with ink; "Thanks" and Undo |
| Thumbs down | Nothing sent yet. An optional note opens, focused: "What could be better? (optional)", a box "Share this note with DreamStream" (unticked; "Left unticked, only your thumbs-down is sent."), Send and Cancel. Escape is Cancel |
| Send | The thumbs-down is sent, with the note only when the box is ticked. "Thanks" and Undo |
| Undo | The rating is taken back on the server (below); the thumbs are ready again and focus returns to the thumb |
| Couldn't send / Couldn't undo | Said in the status line, with Try again (the same request once more) |

Leaving the comic with the thumbs-down note still open records the thumbs-down once (a ticked note with it), as general
chat does. The status line is a polite live region; a rated thumb keeps focus (it is `aria-disabled`, never removed).
Undo and Try again are one button that stays in place while its request runs (`aria-disabled`, the status line says
"Undoing…" or "Sending…") and when it fails, so keyboard focus never drops to the page: a failed Undo leaves focus on
Try again, a Try again that lands leaves it on Undo, and a finished Undo puts it back on the thumb. No colour anywhere:
ink on paper, the chosen thumb filled.

## Where a rating's state lives

In this page's memory, keyed by comic and message (`conversation/replyRatingMemory.ts`), not inside the row. So the
rating stays as it is while the conversation changes around it: a reply that grows old enough to render offscreen,
the pane mounted again, or a layout swap all show the same "Thanks" and Undo (or the same open note with its words
and its box), and a reply is never rated twice in one visit. A request that lands after its row went away still
settles there. Every row of the conversation keeps one wrapper element (`ConversationPane`: only the offscreen class
changes), so a row is never mounted again just because newer messages arrived. The abandoned thumbs-down is recorded
only when the last control showing that rating really leaves (checked at the end of that commit), never when a row
is only mounted again.

## What is sent

`services/feedback.ts` `submitFeedback` → `POST /api/telemetry/feedback`:
`{ targetType: 'comic_reply', targetId: <message id>, vote, source: 'comic_studio', surface: 'comic_studio_conversation',
sessionId: <comic id>, comment?: <the note, only when shared, ≤ 1,000 characters>, metadata: { cards: <card kinds, ≤ 6>,
nextSteps: <count> } }`. Never the reply's words, the story or a price (`replyRatingInput`). The server stamps the
person, the time and the request as for every vote; the admin Analytics view counts the likes and dislikes and lists
recent dislikes with their shared notes.

## Undo

`POST /api/telemetry/feedback/withdraw` with `{ targetType: 'comic_reply', targetId }` (`server/src/routes/telemetry.ts`,
`server/src/services/telemetryStore.ts` `withdrawFeedback`): signed-in only (401 otherwise), rate-limited, and it
removes only that person's own rows for that one reply. Only the kinds in `WITHDRAWABLE_FEEDBACK_TARGETS` (`apiTypes.ts`)
can be taken back, so general feedback and receipt-bearing reports are never touched. Every request is a click: nothing
is sent on a timer.

## Left out

- A rating is not read back after a reload (`user_feedback` is service-role only), the same as general chat; within
  one visit it is (above).
- No note on a thumbs-up, the same as general chat.

## Tests

`conversation/replyRating.test.ts` (which replies, what is sent), `conversation/ReplyRating.test.tsx` (states, note
consent, Undo, failures, keyboard focus through Undo and Try again, a row mounted again, a late send, hover reveal),
`conversation/ConversationPane.test.tsx` (placement), `conversation/ConversationPane.rating.test.tsx` (a rating and an
open note stay put while six more messages land and when the pane is mounted again; leaving with the note open),
`server/src/services/telemetryStore.test.ts` and `server/src/routes/telemetry.withdraw.test.ts` (Undo's scope).
