# Defaults

Defaults are a saved copy of the rows in a project's tables: the starting data your app needs, such as its categories, plans or example content. Once they're saved, **Restore defaults** puts every table back to exactly those rows, whatever happened since. Your app's users and their uploaded files stay as they are.

Use it to undo a mistake (like deleting the default categories), to reset a test or demo project, or to start over while you build.

## Save your defaults

1. In Studio, pick the project in the project switcher, then open **Project settings** from the same menu. (Or press <kbd>⌘K</kbd> and type **defaults**.)
2. Under **Defaults**, click **Save current data as defaults**.

Keel saves the rows of every table at that moment. Do it when your tables hold the data you want to come back to: right after your app's setup or migrations have added their starting rows, before real users add their own.

Save again whenever the starting data changes, for example after adding a table with rows of its own. Studio tells you when a table was created after the defaults were saved.

## Restore defaults

1. Open **Project settings** for the project, as above.
2. Under **Defaults**, click **Restore defaults** and confirm.

What happens:

- **Every table goes back to the saved rows.** Rows added since are removed, changed rows get their saved values back, and deleted rows return with the same ids, so links between tables keep working.
- **Tables created after you saved are emptied.** Studio lists them before you confirm.
- **Id counters carry on** after the restored rows, so new rows don't collide with them.
- **Users, files and settings aren't touched**: sign-in accounts, uploaded files and their records, policies, functions and the table structure stay as they are. If you've added a column since saving, the restored rows get the column's default value.
- **Keel makes a backup first.** To undo a restore, open the Backups drawer and restore the backup marked **Before restoring defaults**.

It all happens in one transaction: if something stops the restore, nothing changes. The most likely reason is a saved row that points at something that's gone, such as a user deleted since the defaults were saved. Studio names the table; bring those rows back, or save the defaults again without them.

## Good to know

- **Which tables**: every table you create, in `public` or your own schemas. Keel's own tables (users, storage, realtime) and extensions' tables aren't included.
- **Backups don't include the defaults**, and restoring a backup keeps the saved defaults as they are.
- **Size**: the defaults are a full copy of your rows, stored in the project's database. Save them while your tables hold starting data rather than months of real data.
- **Delete defaults** removes the saved copy; your tables stay as they are.

## From SQL

Studio uses two functions in the project's database, which you can also run in the [SQL editor](/studio/sql-editor) or with `./keel psql`. They need the `postgres` superuser: the project's owner role, which coding agents get in `KEEL_DB_URL`, can't run them, so an agent asks you to save or restore defaults in Studio.

```sql
select _keel_defaults.save();     -- the current rows become the defaults
select _keel_defaults.restore();  -- every table goes back to them
```

`restore()` doesn't make a backup first; Studio does. For `save()` to see all tables at the same moment while your app is running, run it in a repeatable read transaction:

```sql
begin isolation level repeatable read;
select _keel_defaults.save();
commit;
```
