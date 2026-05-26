// ── TaskFlow Supabase Configuration ────────────────────────────────────────
//
// STEP 1 — Create a free project at https://supabase.com
//
// STEP 2 — Run this SQL in Supabase → SQL Editor → New query:
// ───────────────────────────────────────────────────────────────────────────
// create table tasks (
//   id text primary key,
//   user_id uuid references auth.users not null,
//   title text not null default '',
//   description text default '',
//   priority text default 'medium',
//   completed boolean default false,
//   created_at bigint default 0,
//   due_date text default '',
//   due_time text default '',
//   reminder_enabled boolean default false,
//   alarm_triggered boolean default false,
//   color text default '#60a5fa'
// );
// alter table tasks enable row level security;
// create policy "own tasks" on tasks
//   for all using (auth.uid() = user_id)
//   with check (auth.uid() = user_id);
// alter publication supabase_realtime add table tasks;
// ───────────────────────────────────────────────────────────────────────────
//
// STEP 3 — Authentication → Providers → Google → Enable
//   (Add your Google OAuth Client ID + Secret from console.cloud.google.com)
//
// STEP 4 — Authentication → URL Configuration → add these Redirect URLs:
//   https://sissanjeev-cmd.github.io/taskflow-pwa/
//   http://localhost:4321
//
// STEP 5 — Settings → API → copy the two values below
// ───────────────────────────────────────────────────────────────────────────

export const SUPABASE_URL      = 'REPLACE_WITH_YOUR_PROJECT_URL';
export const SUPABASE_ANON_KEY = 'REPLACE_WITH_YOUR_ANON_KEY';
