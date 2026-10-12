-- Event triggers run as whoever issued the DDL, superusers included (Studio's
-- SQL editor and New table, restores). These functions were created without a
-- search_path, so they resolved names through the session's: "$user", public,
-- extensions, where the project's owner role can create functions. An owner's
-- public.format(text, text) then ran as the superuser the next time a
-- superuser created a table or view in public. Pin them to pg_catalog: every
-- name they use outside it is qualified.
alter function _keel.notify_pgrst() set search_path = pg_catalog;
alter function _keel.auto_enable_rls() set search_path = pg_catalog;
alter function _keel.auto_view_security_invoker() set search_path = pg_catalog;
alter function _keel.owner_role() set search_path = pg_catalog;
