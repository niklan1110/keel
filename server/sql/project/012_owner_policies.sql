-- The project owner role (<db>_owner, a member of keel_project_owners) works
-- like Supabase's postgres role in its project: it sees and changes every row
-- of storage and realtime. It can't have BYPASSRLS, which would also hold in
-- Keel's control database, so these policies give it that here instead.
-- Tables it creates in public are its own, and row level security doesn't
-- apply to a table's owner.

drop policy if exists keel_project_owner on storage.buckets;
create policy keel_project_owner on storage.buckets for all to keel_project_owners using (true) with check (true);

drop policy if exists keel_project_owner on storage.objects;
create policy keel_project_owner on storage.objects for all to keel_project_owners using (true) with check (true);

drop policy if exists keel_project_owner on realtime.messages;
create policy keel_project_owner on realtime.messages for all to keel_project_owners using (true) with check (true);
