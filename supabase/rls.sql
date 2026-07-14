-- ============================================================
-- Kael — Row Level Security setup
-- ============================================================
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query).
--
-- WHY: The bot's backend (src/supabase.js) connects using the SUPABASE_KEY.
-- If that key is the service_role key, it bypasses RLS entirely — the bot
-- keeps working exactly as before. What RLS actually protects you from is
-- Supabase's built-in PostgREST API being callable directly by anyone who
-- has your project's anon/public key (e.g. if it ever leaks, or if someone
-- inspects your frontend network requests). With RLS enabled and no
-- permissive policies for anon/authenticated, those requests are refused.
--
-- IMPORTANT: after running this, SUPABASE_KEY in your .env MUST be the
-- service_role key (Project Settings → API → service_role secret), not the
-- anon/public key, or the bot itself will stop being able to read/write.
-- Never expose the service_role key to a browser or public client.
-- ============================================================

-- 1. Enable RLS on every table the bot uses
ALTER TABLE public.personal_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_routines      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_tasks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interaction_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_usage           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_jobs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lists               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_entries     ENABLE ROW LEVEL SECURITY;

-- 2. No policies are created for anon / authenticated roles on purpose.
-- With RLS enabled and zero policies, every role EXCEPT service_role is
-- denied by default — which is exactly what we want for a single-tenant,
-- backend-only bot. service_role always bypasses RLS regardless of policies.
--
-- If you later add a scenario where the anon key legitimately needs to read
-- something (e.g. a public status page querying Supabase directly instead
-- of through /api/status), add a narrow, explicit policy such as:
--
-- CREATE POLICY "public read-only usage stats"
--   ON public.api_usage
--   FOR SELECT
--   TO anon
--   USING (true);
--
-- Prefer routing everything through the Express API (src/server.js) instead,
-- so access rules stay in one place (application code) rather than split
-- across the DB and the app.

-- 3. Sanity check — confirms RLS is on for all 11 tables (rowsecurity = true)
SELECT relname AS table_name, relrowsecurity AS rls_enabled
FROM pg_class
WHERE relname IN (
  'personal_reminders', 'daily_routines', 'recurring_tasks',
  'special_events', 'contacts', 'interaction_logs',
  'api_usage', 'system_jobs', 'notes', 'lists', 'finance_entries'
)
ORDER BY relname;
