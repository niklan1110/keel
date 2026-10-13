# Access control

Who can upload, download, list and delete files is decided by [row level security](/database/row-level-security) policies on the `storage.objects` table, written in SQL like the policies on your own tables. Policies written for Supabase Storage work in Keel unchanged.

```sql
-- Each signed-in user can upload, read, replace and delete files
-- in a folder named after their user ID, and nowhere else.
create policy "Users manage their own folder" on storage.objects
  for all to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);
```

Run policies like this in Studio's [SQL editor](/studio/sql-editor). They take effect immediately.

## How it works

Every storage request runs inside Postgres as the caller's role, decided by the token it sends:

| Request made with | Role | Policies |
|---|---|---|
| Only the anon key (no one signed in) | `anon` | Apply |
| A signed-in user's access token | `authenticated` | Apply, and `auth.uid()` is the user's ID |
| The service role key | `service_role` | Skipped: full access |

Each file is a row in `storage.objects`, so uploading inserts a row, downloading selects it, and so on. Row level security is on for `storage.objects` and `storage.buckets`, and new projects have **no storage policies**. Until you add some, only the service role key and Studio can work with files (and anyone can read files in public buckets).

## What each operation needs

| Operation | Policies needed on `storage.objects` |
|---|---|
| `upload()`, resumable upload | `insert` |
| `upload()` or resumable upload with `upsert: true` | `insert`, `select` and `update` |
| `update()` | `select` and `update` |
| `download()`, `info()`, `exists()`, `list()` | `select` |
| `createSignedUrl()`, `createSignedUrls()` | `select` |
| `createSignedUploadUrl()` | `insert` (with `upsert: true`: `insert`, `select` and `update`) |
| `move()` | `select` and `update` |
| `copy()` | `select` on the source, `insert` on the copy |
| `remove()`, `emptyBucket()` | `select` and `delete` |
| Opening a public URL, signed URL or signed upload URL | None |

These are the same rules as on Supabase. An `insert`-only policy is enough for a drop box: users can upload, but not see or change what they uploaded. A `for all` policy covers every operation at once.

Operations that can't see a file behave as if it doesn't exist: `download()` returns `404`, `list()` leaves it out, and `remove()` skips it.

## Helper functions

Policies usually look at the file's path. Keel has the same helpers as Supabase:

| Function | Returns | For `'8d2b…/receipts/march.PDF'` |
|---|---|---|
| `storage.foldername(name)` | The folders, as a `text[]` | `{8d2b…,receipts}` |
| `storage.filename(name)` | The last part of the path | `march.PDF` |
| `storage.extension(name)` | The text after the last dot of the file name | `PDF` |

Postgres arrays start at 1, so `(storage.foldername(name))[1]` is the top folder. `storage.extension` keeps the original case, so compare with `lower(...)`. A file name without a dot returns the whole name.

Policies can also use the columns of `storage.objects`: `bucket_id`, `name`, `owner_id` (the uploader's user ID as text), `metadata` and `user_metadata`. And the auth helpers work as usual: `auth.uid()`, `auth.role()`, `auth.email()` and `auth.jwt()`.

## Examples

### Profile pictures

A public bucket for avatars, where each user can only change their own:

```sql
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);

create policy "Users manage their own avatar" on storage.objects
  for all to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
```

Users upload to `${user.id}/avatar.png`. Everyone else sees the picture through its public URL, which doesn't need a policy.

### Files only the uploader can see

Instead of folders, use the `owner_id` column, which Keel fills in from the uploader's token:

```sql
create policy "Uploaders manage their receipts" on storage.objects
  for all to authenticated
  using (bucket_id = 'receipts' and owner_id = auth.uid()::text)
  with check (bucket_id = 'receipts' and owner_id = auth.uid()::text);
```

Users can't set `owner_id` themselves. Replacing a file makes the replacing user its owner.

### Shared read access

Everyone who's signed in can read the files in `handbook`. Only the service role key (your server, or Studio) can add or change them:

```sql
create policy "Signed-in users read the handbook" on storage.objects
  for select to authenticated
  using (bucket_id = 'handbook');
```

To include visitors who aren't signed in, use `to anon, authenticated`. For a whole bucket of files anyone may read, a public bucket is simpler and faster.

### Team folders

Members of a team share a folder named after the team's ID. Membership lives in your own table:

```sql
create table team_members (
  team_id uuid not null,
  user_id uuid not null references auth.users on delete cascade,
  primary key (team_id, user_id)
);

-- The storage policy reads this table as the user, so they must see their own memberships.
create policy "Users see their memberships" on team_members
  for select to authenticated
  using (user_id = auth.uid());

create policy "Team members manage team files" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'teams'
    and (storage.foldername(name))[1] in (select team_id::text from team_members where user_id = auth.uid())
  )
  with check (
    bucket_id = 'teams'
    and (storage.foldername(name))[1] in (select team_id::text from team_members where user_id = auth.uid())
  );
```

Files go to `<team id>/…`, for example `6f1c…/plans/2026.pdf`.

### Only certain file types

Allow uploads of images only, by file extension:

```sql
create policy "Users upload images to their folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp', 'gif')
  );

create policy "Users read their photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
```

A policy only sees the file name. To check the file's actual content type, set the bucket's allowed types as well (`allowedMimeTypes: ['image/*']`, see [Uploading files](/storage/uploads#create-a-bucket)), which Keel enforces before the file is saved, and again when a file is copied into the bucket.

### Bucket policies

Buckets have policies too. With none, only the service role can create, change, delete or list buckets. To let your app list them, for example to show a bucket picker:

```sql
create policy "Anyone can see buckets" on storage.buckets
  for select using (true);
```

## Public buckets

Making a bucket public skips policies for **reading** only, through these URLs:

- `/storage/v1/object/public/<bucket>/<path>` (what `getPublicUrl()` returns)
- `/storage/v1/render/image/public/<bucket>/<path>` (resized images)
- `/storage/v1/object/info/public/<bucket>/<path>`

Every other operation in a public bucket, including `list()`, `download()` and every kind of write, still goes through your policies. And since public URLs skip them, no policy can hide a file in a public bucket from someone who knows its path.

## The service role key

The service role key bypasses row level security completely: it can read, write and delete any file in any bucket, and manage buckets. Studio uses it for its Storage drawer. Use it only in code that runs on your server, in edge functions or in scripts, never in a browser or app.

To let a client do one specific thing it otherwise couldn't, have your server hand out a [signed URL](/storage/serving-files#signed-urls) or a [signed upload URL](/storage/uploads#signed-upload-urls) instead of a policy.

## Troubleshooting

If an upload fails with `new row violates row-level security policy`, or a file you uploaded doesn't show up:

- **Is the user signed in?** A policy `to authenticated` doesn't apply to requests made with only the anon key.
- **Is there an `insert` policy for this bucket and path?** A new upload needs only that, see [What each operation needs](#what-each-operation-needs). To see the file in `list()` or download it afterwards, the user also needs a `select` policy.
- **Does the path match?** With folder policies, the first folder must be exactly the user's ID: `${user.id}/file.png`, not `/${user.id}/file.png` or `users/${user.id}/file.png`.
- **Replacing a file?** `upsert` also needs `select` and `update` policies, and `update()` needs `select` and `update`.
- **Is `bucket_id` right?** Bucket IDs are case-sensitive.

You can see every policy on storage with:

```sql
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'storage';
```
