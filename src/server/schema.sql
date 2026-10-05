-- UUID text primary keys (not incremental) so ids aren't enumerable.
-- Ids are generated in the app layer with crypto.randomUUID().

-- Settings and the run loop's state. One row.
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,                   -- always 1
  about TEXT NOT NULL DEFAULT '',           -- what we sell, in a sentence: frames every draft
  signature TEXT NOT NULL DEFAULT '',       -- added under every email when it is sent
  daily_cap INTEGER NOT NULL DEFAULT 30,    -- emails a day, all campaigns together
  send_from TEXT NOT NULL DEFAULT '09:00',  -- the sending window, local time
  send_until TEXT NOT NULL DEFAULT '17:00',
  timezone TEXT NOT NULL DEFAULT 'UTC',     -- IANA name, e.g. Europe/Amsterdam
  weekdays_only INTEGER NOT NULL DEFAULT 1,
  crm_app_id TEXT,                          -- a sibling CRM app that sends, replies and meetings are written to
  mailbox TEXT,                             -- the address the connected Gmail sends from
  running_until TEXT,                       -- a run's lease; a second run waits it out
  job_id TEXT,                              -- the next run booked on the platform queue
  next_run_at TEXT,
  last_run_at TEXT,
  last_error TEXT,
  calendar_checked_at TEXT,                 -- when booked meetings were last looked for
  updated_at TEXT DEFAULT (datetime('now'))
);

-- A campaign: who it is for and what it says, and its steps.
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  angle TEXT NOT NULL DEFAULT '',           -- who we write to and why: frames every draft
  status TEXT NOT NULL DEFAULT 'draft',     -- 'draft' | 'active' | 'paused' | 'archived'
  stop_company INTEGER NOT NULL DEFAULT 1,  -- a reply or meeting from anyone at a company stops everyone there
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- One step of a campaign. Step 1 starts a thread; later email steps reply in it.
CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,                -- 1, 2, 3…
  wait_days INTEGER NOT NULL DEFAULT 0,     -- days after the step before (step 1: after joining)
  channel TEXT NOT NULL DEFAULT 'email',    -- 'email' | 'call' | 'linkedin' | 'task'
  writer TEXT NOT NULL DEFAULT 'thread',    -- email steps: 'research' (the agent researches first) | 'thread' (the app's AI writes from the thread)
  instructions TEXT NOT NULL DEFAULT '',    -- what this touch is for
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Someone we write to. One row per address, whichever campaigns they are in.
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,               -- lowercased
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',          -- the company's mail domain; '' for a personal address
  linkedin_url TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',           -- context and evidence for whoever writes to them
  source TEXT NOT NULL DEFAULT 'manual',    -- 'manual' | 'csv' | 'crm' | 'agent'
  crm_contact_id TEXT,                      -- their contact in the connected CRM, once known
  unsubscribed_at TEXT,                     -- asked not to be written to: never added to a campaign again
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- A person in a campaign, and where they are in it.
CREATE TABLE IF NOT EXISTS enrollments (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'paused' | 'replied' | 'meeting' | 'bounced' | 'unsubscribed' | 'stopped' | 'finished'
  step INTEGER NOT NULL DEFAULT 1,          -- the next step to do
  due_at TEXT,                              -- when that step is due
  thread_id TEXT,                           -- the Gmail thread, once the first email is out
  last_sent_at TEXT,
  paused_until TEXT,                        -- an out-of-office reply
  reason TEXT,                              -- why it stopped or paused, in words
  checked_at TEXT,                          -- when the thread was last read for replies
  enrolled_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (campaign_id, person_id)
);

-- One touch: a draft to approve, an email that went out, or a call to make.
CREATE TABLE IF NOT EXISTS touches (
  id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES steps(id) ON DELETE SET NULL,
  position INTEGER NOT NULL,                -- the step's number when the touch was made
  channel TEXT NOT NULL,                    -- 'email' | 'call' | 'linkedin' | 'task'
  status TEXT NOT NULL,                     -- 'research' | 'drafting' | 'review' | 'approved' | 'sent' | 'done' | 'skipped' | 'failed'
  subject TEXT,                             -- the draft as written (step 1 only has a subject)
  body TEXT,
  sent_subject TEXT,                        -- exactly what went out, so edits can be counted
  sent_body TEXT,
  sources TEXT NOT NULL DEFAULT '[]',       -- JSON [{title, url, note}]: what the writer checked
  rationale TEXT,                           -- why this draft, and what was left out
  written_by TEXT,                          -- 'agent' | 'ai' | 'person'
  review_note TEXT,                         -- why a person sent it back
  message_id TEXT,                          -- the Gmail message, once sent
  error TEXT,
  approved_by TEXT,
  approved_at TEXT,
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_steps_campaign ON steps(campaign_id, position);
CREATE INDEX IF NOT EXISTS idx_enrollments_campaign ON enrollments(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_enrollments_person ON enrollments(person_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_due ON enrollments(status, due_at);
CREATE INDEX IF NOT EXISTS idx_touches_enrollment ON touches(enrollment_id, position);
CREATE INDEX IF NOT EXISTS idx_touches_status ON touches(status, created_at);
CREATE INDEX IF NOT EXISTS idx_people_domain ON people(domain);
