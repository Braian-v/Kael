# Kael

A personal AI assistant that works entirely inside WhatsApp. Set reminders, manage daily routines, save contacts, search the web, and forward messages — all by sending a text.

**Live:** [kael.onrender.com](https://kael.onrender.com)
**Docs:** [kael.onrender.com/documentation](https://kael.onrender.com/documentation)

---

## Quick start

```bash
git clone <your-repo-url>
cd whatsapp-reminder-bot
npm install
cp .env.example .env   # fill in your keys
npm run dev
```

Full setup guide — including Meta webhook configuration, Supabase schema, and Render deployment — is at [kael.onrender.com/documentation](https://kael.onrender.com/documentation).

---

## What it does

| Feature | Example |
|---|---|
| One-off reminders | "Remind me to call the bank at 3 PM" |
| Interval reminders | "Remind me every 30 mins to drink water" |
| Daily routines | "Remind me to drink water every day at 10 AM" |
| Weekly recurring | "Remind me to take out the trash every Tuesday at 8 PM" |
| Monthly recurring | "Remind me to pay rent on the 1st of every month at 9 AM" |
| Edit last reminder | "Actually, make that 6 PM" |
| Birthdays & events | "22nd May is Manu's birthday" |
| Save contacts | "Save mom as 5493511234567" |
| Message contacts | "Tell mom I'll be 10 minutes late" |
| Web search | "Who won the last Copa América?" |
| Delete tasks | "Delete the drink water routine" |
| Conversational chat | "Explain machine learning simply" |
| Follow-up questions | "Who was the captain?" (after asking about a match) |
| Vague time defaults | "Remind me tomorrow morning to call the doctor" → 9:00 AM |

---

## Stack

- **Runtime:** Node.js + Express on Render (free tier)
- **Database:** Supabase (PostgreSQL)
- **Messaging:** Meta WhatsApp Cloud API
- **AI:** Gemini 3 Flash → Gemini 2.5 Flash → Groq Llama 3.3 → OpenRouter GPT-4o-mini
- **Search:** Tavily (primary) + Serper (fallback)
- **Timezone:** America/Argentina/Cordoba (UTC-3, no DST) throughout
- **Uptime monitoring:** UptimeRobot (pings `/api/ping` every 5 min, push alert on downtime)

---

## Database schema

| Table | Purpose |
|---|---|
| `contacts` | Address book |
| `personal_reminders` | One-off and interval reminders |
| `daily_routines` | Daily fixed-time recurring tasks |
| `recurring_tasks` | Weekly and monthly recurring tasks *(added v1.1)* |
| `special_events` | Birthdays and anniversaries |
| `interaction_logs` | Message log + conversational memory source |
| `api_usage` | Daily AI/search quota tracking |
| `system_jobs` | Background job health and heartbeat tracking *(added v1.1.1)* |
| `notes` | Free-form saved notes *(added Fase 3)* |
| `lists` | Named lists — shopping, todo, etc. *(added Fase 3)* |
| `finance_entries` | Income/expense tracking, optionally tagged by business *(added Fase 3)* |

### Row Level Security — run once in Supabase

`supabase/rls.sql` enables RLS on all 11 tables above and denies anon/authenticated
access by default. The bot itself is unaffected as long as `SUPABASE_KEY` is
the service_role key (see the env var table below), which always bypasses RLS.
Paste the file's contents into Supabase → SQL Editor and run it.

### Fase 3 migration — run once in Supabase

```sql
CREATE TABLE notes (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON notes (phone);

CREATE TABLE lists (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT NOT NULL,
  list_name   TEXT NOT NULL,
  item        TEXT NOT NULL,
  is_done     BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON lists (phone, list_name);

CREATE TABLE finance_entries (
  id            BIGSERIAL PRIMARY KEY,
  phone         TEXT NOT NULL,
  entry_type    TEXT NOT NULL CHECK (entry_type IN ('income', 'expense')),
  amount        NUMERIC NOT NULL,
  category      TEXT,
  business_tag  TEXT,
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON finance_entries (phone);
```

After creating these, re-run `supabase/rls.sql` — it now covers all 11 tables (it's idempotent, safe to run again).

### v1.2.0 migration — run once in Supabase

```sql
-- Atomic counter increment for api_usage
CREATE OR REPLACE FUNCTION increment_api_usage(p_date DATE, p_column TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE col_name TEXT := p_column || '_count';
BEGIN
  EXECUTE format(
    'UPDATE api_usage SET %I = COALESCE(%I, 0) + 1 WHERE usage_date = $1',
    col_name, col_name
  ) USING p_date;
END; $$;
```

### v1.1 migration — run once in Supabase

```sql
CREATE TABLE recurring_tasks (
  id               BIGSERIAL PRIMARY KEY,
  phone            TEXT NOT NULL,
  task_name        TEXT NOT NULL,
  reminder_time    TIME NOT NULL,
  recurrence_type  TEXT NOT NULL CHECK (recurrence_type IN ('weekly', 'monthly')),
  day_of_week      INTEGER,
  day_of_month     INTEGER,
  is_active        BOOLEAN DEFAULT TRUE,
  last_fired_date  DATE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- v1.1.1: Job tracking
CREATE TABLE system_jobs (
    job_name TEXT PRIMARY KEY,
    last_fired TIMESTAMPTZ,
    status TEXT DEFAULT 'active'
);

INSERT INTO system_jobs (job_name, status)
VALUES 
    ('Reminder Dispatch', 'active'),
    ('Routine Dispatch', 'active'),
    ('Recurring Task Dispatch', 'active'),
    ('Event Alert', 'active')
ON CONFLICT (job_name) DO NOTHING;
```

---

## Environment variables

See `.env.example` for the full list. Requires keys for: Meta, Supabase, Gemini, Groq, OpenRouter, Tavily, Serper.

| Variable | Required | Purpose |
|---|---|---|
| `VERIFY_TOKEN` | Yes | Meta webhook handshake token |
| `MY_PHONE_NUMBER` | Yes | Your WhatsApp number (digits only, no `+`) |
| `PHONE_NUMBER_ID` | Yes | Meta App → WhatsApp → API Setup |
| `ACCESS_TOKEN` | Yes | Meta permanent access token |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_KEY` | Yes | Supabase **service_role** key (not anon/public) — required so the bot can bypass RLS. Never expose it to a browser/client. |
| `GEMINI_API_KEY` | Yes | Google AI Studio |
| `GROQ_API_KEY` | Yes | Groq console |
| `OPENROUTER_API_KEY` | Yes | OpenRouter |
| `TAVILY_API_KEY` | Yes | Tavily |
| `SERPER_API_KEY` | Yes | Serper.dev |
| `PUBLIC_URL` | Yes | Your app URL, no trailing slash — enables self-ping keep-alive |
| `CRON_SECRET` | Yes | Protects `/api/tick` — set the same value in cron-job.org |
| `WEBHOOK_APP_SECRET` | Yes | Meta App Secret — required; server refuses to start without it |

---

## Testing

```bash
node test.js
```

Runs the full v1.1 integration test suite against your live Supabase instance. Inserts test data, verifies all features, and cleans up after every run. No real WhatsApp messages are sent.

Test suites: Supabase connectivity (7 tables), AI intent parsing (20 cases), reminders, routines, special events, contacts, delete tasks, interval reminders, scheduler logic, usage tracking, server routes + ping shape, conversational memory, missing time UX fix, edit task/undo, WhatsApp markdown formatter, vague time defaults, recurring tasks (weekly + monthly), media handling.

---

## Changelog

### Kael fork — Fase 3
- **Notes:** `save_note` / `query_notes` intents — jot down and search free-form information (`notes` table)
- **Lists:** `list_add` / `list_view` / `list_remove` intents — named lists like shopping or todo (`lists` table)
- **Finance tracking:** `finance_entry` / `finance_query` intents — log income/expenses with optional category and business tag (e.g. Beluz vs. Dulce Meel), query balance by day/week/month/all (`finance_entries` table)
- **Daily summary:** New `runDailySummary()` job — proactively messages the owner every morning (07:00 local) with today's reminders, routines, recurring tasks, events, and pending list counts. Guarded so it's safe to call repeatedly from `/api/tick` without double-sending, and gated to never fire before 07:00 local even if triggered early
- **Snooze:** New `snooze_reminder` intent — postpones a pending reminder, or re-schedules the most recently fired one, by a stated number of minutes

### Kael fork — Fase 1 & 2
- **Rebrand:** Renamed from the original Manvi/Viswanath project to Kael/Braian; removed original creator's branding, favicons, OG tags, and GitHub links
- **Timezone:** Moved from Asia/Kolkata to America/Argentina/Cordoba (fixed UTC-3, no DST) — including a fix to the birthday-alert cron, which was still firing at the old IST-tuned UTC time
- **RLS:** Added `supabase/rls.sql` — enables Row Level Security on all 8 tables, denies anon/authenticated access by default (requires `SUPABASE_KEY` to be the service_role key)
- **Fail-fast secrets:** Server refuses to start without `WEBHOOK_APP_SECRET`; `CRON_SECRET` moved from a query param to the `x-cron-secret` header
- **Message Templates:** New `sendWithTemplateFallback()` — reminders, routines, recurring tasks, event alerts, and third-party `instant_message` sends now fall back to an approved Meta template when the 24h customer-service window is closed (error 131047). See [Message Templates](https://kael.onrender.com/documentation#templates) in the docs
- **Conversational memory:** Bumped from 4 to 8 turns — also fixed a bug where the query was ordered ascending, so it always returned the oldest 4 messages ever sent instead of the most recent ones
- **Robustness:** `.single()` → `.maybeSingle()` where a missing row is expected; ILIKE wildcards (`%`, `_`) escaped in user-supplied search text; JSON extraction from AI responses now uses brace-matching instead of a single greedy regex

### v1.3.0
- **Scheduler reliability:** Atomic claim pattern in all three dispatch functions — `UPDATE WHERE status='pending' RETURNING id` before sending, so two concurrent dispatchers (cron + `/api/tick`) can never send the same reminder twice
- **`Promise.allSettled` in `/api/tick`:** One failing dispatcher no longer blocks the other two
- **Event alert guard:** `eventAlertRunning` flag added — consistent with all other job guards
- **Fail-fast startup:** Server refuses to start if `WEBHOOK_APP_SECRET` is not set
- **Webhook signature hardened:** Buffer length checked before `timingSafeEqual` — no more `try/catch` needed for mismatched-length inputs
- **Status dashboard auto-refresh:** Page now re-fetches `/api/status` every 60 seconds automatically
- **"Synced X sec ago" counter:** Live indicator shows how stale the dashboard data is, updating every second
- **`timeAgo()` timestamps:** Jobs table "Last Run" column now shows "3m ago" / "2h ago" instead of raw UTC ISO strings; timestamps re-render every 30 s without a network call
- **Chart legend accuracy:** Legend line swatches now use exact chart colors (`#3b82f6` / `#f43f5e`); failures swatch shows a dashed pattern matching the chart line
- **Toggle buttons via CSS class:** Removed all inline `style.background` writes — active state driven by `.toggle-btn.active` class
- **Jobs table:** Technical description column removed; only the human-readable layman description is shown
- **Test suite v1.2:** New `security` and `ratelimit` suites; atomic claim test in `scheduler` suite; `/api/tick` 403/200 checks in `routes` suite; `system_jobs` added to connectivity table check

### v1.2.0
- **Webhook signature verification:** All incoming Meta webhooks are now verified via `X-Hub-Signature-256` using `WEBHOOK_APP_SECRET` — rejects spoofed requests
- **Per-user rate limiting:** Max 10 messages/minute per sender — protects AI quota from loops or abuse
- **External cron trigger:** New `GET /api/tick` endpoint (protected by `CRON_SECRET`) — called by cron-job.org every minute to run dispatch jobs regardless of process sleep state
- **Self-ping fixed:** `PUBLIC_URL` trailing slash stripped; self-ping now calls `/api/tick` every 4 min instead of `/api/ping`
- **Parallel delete_task:** Four sequential DB round-trips replaced with one parallel search across all tables
- **Usage tracking optimised:** `getUsage()` bounded to last 90 days; `ensureRowExists()` cached by date (eliminates ~180 redundant DB reads/hour); `track()` uses atomic `increment_api_usage` RPC function
- **Status dashboard fix:** AI Inference Engine label now correctly shows "Offline" when today has no heartbeat, not just "Online"/"Degraded"
- **Startup heartbeat:** `ensureRowExists()` called at server startup — today's `api_usage` row is always created, preventing false "down" entries on idle days

### v1.1.1
- **Downtime Detection:** Status dashboard now visualizes offline gaps in red — see exactly when your bot was down.
- **Job Heartbeats:** Track "Last Run" timestamps for every background task (reminders, routines, etc.) directly on the dashboard.
- **90-Day History:** Visual history grid now shows a full 90-day window with intelligent gap filling.
- **Continuous Tracking:** Bot now auto-creates a daily record even on idle days to ensure true uptime history.
- **Self-Pinging Keep-Alive:** Optional `PUBLIC_URL` setting to prevent hosting platforms (like Render) from sleeping.

### v1.1
- **Conversational memory:** Bot reads last 8 turns from `interaction_logs` before each AI call — enables natural follow-up questions
- **Edit task / Undo:** Say "Actually make that 6 PM" after setting a reminder to update it in-place
- **Weekly recurring tasks:** "Remind me every Tuesday at 8 PM to take out the trash"
- **Monthly recurring tasks:** "Remind me on the 1st of every month at 9 AM to pay rent"
- **Missing time UX fix:** No-time reminder/routine/event now asks "At what time?" instead of guessing
- **Vague time defaults:** "Morning" → 9 AM, "afternoon" → 2 PM, "evening" → 6 PM, "night" → 9 PM
- **WhatsApp markdown formatter:** Search and chat responses now render `*bold*`, `_italic_`, `~strike~` natively in WhatsApp
- **Media handling:** Voice notes, images, videos, documents, and stickers now get a clear "I can only read text" reply instead of silently failing
- **UptimeRobot migration:** Keep-alive and downtime push alerts now handled by UptimeRobot on `/api/ping`

### v1.0
- Initial release: reminders, routines, interval reminders, events, contacts, web search, delete tasks, chat