# OpenSequence: agent guide

Email sequences that a person approves before anything is sent. A campaign has
an angle (who it writes to and why) and steps: emails, calls, LinkedIn steps and
tasks, each a few days after the last. People join a campaign; each of their
steps becomes a touch: a draft to approve, an email that went out, a task to do.

## Who does what

- **You**: find people who fit a campaign and add them, with what you found in
  their `notes`; research and write the drafts that wait for research; read the
  replies and suggest next steps; set up a campaign when asked.
- **The app**: sends, from the mailbox picked in Settings, inside the sending
  hours and under the daily cap; writes follow-ups from the thread; reads what
  comes back and stops or pauses people (a reply stops them and, if the campaign
  says so, everyone at their company; an out-of-office answer pauses them; a
  bounce or "remove me" stops them for good); stops anyone who books a meeting;
  writes sends, replies and meetings onto the CRM contact.
- **Never approve and never send.** Approving is a person's job: the API answers
  403 if you try. Never email a campaign's people from Gmail yourself either: the
  app wouldn't know, and its stop rules wouldn't apply.

## The research queue (your main job)

When a person picks you as the research agent in Settings, the app hands you
this work itself: a task with up to 10 touch ids and these same steps. Without
a pick, work the queue when you are asked to:

1. `GET /api/touches?status=research` lists drafts waiting for research (paged).
2. For each one, `GET /api/touches/{id}`: the person, the step's instructions,
   what we sell (`what_we_sell`) and the thread so far. Read the campaign's
   angle with `GET /api/campaigns/{campaign.id}`, and what the CRM knows about
   them with `GET /api/touches/{id}/crm`: its `notes` with tone `warn` (their
   company is a customer, a call is booked, a deal is open) mean this is no cold
   email. Say so in `rationale`, and write for it or leave it to the person.
3. Research the person and their company: their website, recent news, job
   posts, their LinkedIn profile. Find one or two specific facts you can link
   to, that connect to the angle. Skip anything you can't source.
4. Write the email: plain text, under 120 words, greeting them by first name. No
   signature and no opt-out line (both are added when it goes out), and never a
   placeholder like [Name]. When `starts_thread` is true it needs a short subject.
   When `person.inbox` is true the email goes to a company's general address
   (info@, contact@): no first name. Greet the team, say who it is for, and ask
   who handles it.
5. Hand it in: `PUT /api/touches/{id}/draft`
   `{ "subject": "...", "body": "...", "rationale": "why this angle, what you left out", "sources": [{ "title": "...", "url": "https://...", "note": "what it says" }] }`.
   It lands in To approve for a person.
6. A draft a person sent back returns to the queue with `review_note`: do what it says.

## Adding people

A campaign can also fill itself from an OpenProspector list (`PATCH /api/campaigns/{id}`
`{ "source": { "app_id", "list_id", "daily", "per_company" } }`, or `null` to stop; the
lists are at `GET /api/sources`). Set one up when the person asks for a campaign that keeps
filling; the app takes the people itself, each hour, up to the number a day.

- `POST /api/people` `{ "people": [{ "email", "first_name", "last_name", "title", "company", "linkedin_url", "notes" }], "campaign_id": "..." }`,
  up to 500 at a time. An address already here is filled in, not duplicated.
  Put the evidence in `notes`, with links: the writer works from it.
- People already here: `POST /api/campaigns/{id}/enroll` `{ "emails": [...] }`.
- Skipped people come back with the reason: asked not to be emailed, bounced,
  already in another live campaign, or the wrong kind of address for the
  campaign (below). Don't work around it.

### Company inboxes (info@, contact@)

A company's general address is not a person. A campaign writes to named people
(the default) or to such inboxes, never both: set `"audience": "inboxes"` when
creating it (or with `PATCH`) only when the person asks to write to companies'
general addresses. Its drafts have no first name, it takes one inbox per
company, and its list asks for no email lookups, since an inbox comes with its
address. People carry `inbox: true` when their address is one.

## Setting up a campaign

- `POST /api/campaigns` `{ "name", "angle", "audience"?, "steps"? }` creates a draft. Without
  steps it gets a researched first email and three follow-ups (days 0, 3, 7 and
  14). A step is `{ "wait_days", "channel": "email" | "call" | "linkedin" | "task", "writer": "research" | "thread", "instructions" }`.
- Starting it (`PATCH /api/campaigns/{id}` `{ "status": "active" }`) is for when
  the person asks. Nothing is sent until each email is approved anyway.
- Signatures: a campaign uses the workspace defaults, one for first emails and
  one for follow-ups. If the person wants others for this campaign, list them
  with `GET /api/signatures` and pick with `PATCH /api/campaigns/{id}`
  `{ "signature_id", "reply_signature_id" }` (an id, `"none"`, or `null` for the
  default). Writing or changing a signature is the person's, in Settings.

## Replies

- `GET /api/replies` lists replies nobody has dealt with. `intent` and `summary`
  are the app's AI reading; read `excerpt` yourself before suggesting anything.
- `intent: "unsubscribe"` has already marked the person as never to be emailed.
  `maybe_opt_out: true` means it might be a request to stop: point it out and
  leave the call to the person (`POST /api/people/{id}/unsubscribe` is theirs to make).
- Mark one done (`POST /api/replies/{id}/handled`) only when the person says so.

## Pages

- `/`: the review queue, the screen to show for "what's waiting" (screenshot-friendly).
- `/replies`, `/campaigns/{id}`, `/people/{id}`, `/settings`.

## Reading failures

- 403 on approve, settings or signatures: those are a person's, by design
  (picking the research agent is a setting too).
- 409 on a draft: the touch isn't waiting for one any more (someone wrote it, or
  the person replied and the step was skipped).
- Nothing is going out: `GET /api/overview` → `sending.last_error` (no mailbox
  picked, the mailbox isn't connected) and `ready`.

## Costs

- The app's AI writes follow-ups and reads replies on the workspace's Clawnify
  credits. Your research is your own run.
