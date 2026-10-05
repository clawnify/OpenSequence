# OpenSequence: Email Sequences You Approve Before They Send

[![Deploy with Clawnify](https://app.clawnify.com/deploy-button.svg)](https://app.clawnify.com/deploy?repo=clawnify/OpenSequence)

Outbound email campaigns where every email is approved by a person before it goes out. The first email starts from research on the person; follow-ups are written from the thread; a reply, a bounce or a booked meeting stops the sequence by itself. An open-source app template provided by [Clawnify.com](https://clawnify.com).

Built with **React, Tailwind and shadcn/ui** on a **Hono API** and a **SQLite database**.

## How it works

- **Campaigns**: who a campaign writes to and why (its angle), and its steps: emails, calls, LinkedIn steps and tasks, each a set number of days after the last. A new campaign starts with a researched first email and three follow-ups in the same thread.
- **Who writes each email**: a step is either *researched* (the agent picked in Settings looks into the person and their company and hands in a draft with its sources and reasons; the app hands it the work, up to ten people at a time, and wakes it if it is asleep) or *written from the thread* (the app's AI writes a short follow-up from what was already sent).
- **Nothing goes out unapproved**: drafts wait in Review, shown as the email that will be sent, with the signature and opt-out line underneath, what the writer checked, and the thread so far. Approve it, edit it, send it back with a note, or skip the step. Only a signed-in person can approve.
- **Sending**: from a Gmail account you pick, so outreach can go from a mailbox on a separate domain while your main one stays clean. Emails go out inside your sending hours, under a daily cap, spread across the day; a new mailbox can warm up (10 a day the first week, 10 more each week). A follow-up replies in the same thread, from the mailbox that started it.
- **What comes back**: the app reads the mailbox's new mail. A reply stops that person, their other campaigns, and (if the campaign says so) everyone else at their company; personal addresses like gmail.com never count as a company. An out-of-office answer pauses them until they're back, and a bounce stops the address for good. The app's AI reads every reply in a line (interested, not interested, opted out, out of office) for the Replies page. People ask to stop in their own words, in any language, so the opt-out line under your emails can be written however you like; a clear "stop" marks them as never to be emailed again, and a reply too short to tell (a bare "yes" or "no thanks") is flagged for you to decide with one click.
- **Meetings**: a meeting on your calendar with someone in a campaign stops their sequence; a meeting with their colleague stops the company.
- **People**: add them one at a time, from a CSV (names, company, title, LinkedIn, phone and notes are picked up by their headers), from a CRM in the same workspace, or through your agent. One person is in one live campaign at a time.
- **People from a list, every day**: a campaign can take new people from a list in OpenProspector, which keeps filling it from its searches and signals. Each hour the campaign reads the list and takes up to its number a day: only people with a verified email, never the same person twice, and no more than a few per company. Why each person was found comes along in their notes, for the writer. The list looks up just enough emails for what its campaigns take.
- **CRM**: with a CRM app in the same Clawnify workspace, every send, reply and booked meeting is written onto the contact's timeline, so the CRM sees outreach from a mailbox it doesn't sync.

## Pages

- **Review** (home): drafts to approve, drafts waiting for research or being written, calls and tasks to do, and approved emails waiting to go out.
- **Replies**: what came back, with the AI's reading, an excerpt, and a link to the message in Gmail.
- **Campaigns**: each campaign's numbers; its page has the angle, the steps, its signatures and the people in it.
- **People**: everyone, with their campaign and status; a person's page has their emails, tasks and replies.
- **Settings**: the mailbox, sending hours and time zone, daily cap and warm-up, what you sell, the opt-out line, the research agent, the signatures and the CRM. Signatures work as in Gmail: as many as you like, one for first emails and one for follow-ups, and a campaign can pick its own. Edit a signature as you see it or as HTML. Paste a formatted one (from Gmail's signature settings, or copy the mailbox's default from Gmail with a click) and it keeps its links and styling; emails then go out as HTML, the way Gmail sends them.

## For agents

`agent.md` is the agent's procedure: research the people in the queue, hand in drafts with their sources, never approve or send. Every endpoint is described at `/api/openapi.json` and `/llms.txt`.

## Quickstart

```bash
git clone https://github.com/clawnify/OpenSequence.git
cd OpenSequence
pnpm install
pnpm run dev
```

The UI runs on `http://localhost:5173` and the API on `:8787`. Gmail, the calendar, the AI and the CRM come from the Clawnify workspace the app runs in, so locally they read as not connected unless you point the app at a workspace with `CLAWNIFY_TOKEN`.

## Deploy with Clawnify

Click the badge above, or ask your Clawnify agent to deploy `clawnify/OpenSequence`. Then connect Gmail (and Google Calendar) in Clawnify, pick the sending mailbox in Settings, and say what you sell.

## License

MIT
