# Overview

Keel Storage keeps files for your apps: profile pictures, photos, PDFs, videos, backups. Files live in **buckets**, are uploaded and served over the same API as Supabase Storage, and access is decided by Postgres policies, like the rest of your data.

```js
import { createClient } from '@supabase/supabase-js'

const keel = createClient('http://localhost:8000/my-app', 'YOUR_ANON_KEY')

// Upload the signed-in user's avatar into a folder named after their user ID
const { data: { user } } = await keel.auth.getUser()
const { error } = await keel.storage
  .from('avatars')
  .upload(`${user.id}/avatar.png`, file, { upsert: true })

// Link to it from an <img> tag (avatars is a public bucket)
const { data } = keel.storage.from('avatars').getPublicUrl(`${user.id}/avatar.png`)
console.log(data.publicUrl)
// http://localhost:8000/my-app/storage/v1/object/public/avatars/8d2b…/avatar.png
```

This example needs a public `avatars` bucket and a policy that lets users write to their own folder. [Uploading files](/storage/uploads) and [Access control](/storage/access-control) show how to set both up.

## Buckets and objects

A **bucket** is a named container for files, like a top-level folder with its own settings. A file in a bucket is called an **object**, and its **path** (also called its name or key) is everything after the bucket name:

```text
avatars / 8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/avatar.png
└ bucket  └ path ─────────────────────────────────────────┘
```

Folders aren't real things: a slash in a path makes one appear. Uploading `invoices/2026/march.pdf` creates the folders `invoices` and `2026` as a side effect, and they disappear when their last file is deleted.

| | Rules |
|---|---|
| **Bucket names** | 1 to 100 characters: letters, digits, spaces, `.`, `_` and `-`, starting with a letter or digit. `public`, `authenticated`, `sign`, `info`, `list`, `move`, `copy`, `upload` and `render` are reserved. |
| **Paths** | Up to 1024 characters. Can't start with `/`, contain `\`, or have `.` or `..` as a folder name. |

Each project has its own buckets. A bucket called `avatars` in `my-app` has nothing to do with one in another project.

## Public and private buckets

Every bucket is either public or private. The difference is only about **reading** files:

| | Public bucket | Private bucket (default) |
|---|---|---|
| Download | Anyone with the URL, no key needed | Needs a [signed URL](/storage/serving-files#signed-urls), or a token whose policies allow it |
| Upload, replace, delete, list | Needs a policy (or the service role key) | Needs a policy (or the service role key) |
| Typical use | Avatars, product photos, blog images | Invoices, private documents, user uploads |

Public files are served from `/storage/v1/object/public/<bucket>/<path>`, which skips your policies entirely. Anyone who knows or guesses a path can download the file, so keep anything personal in a private bucket.

## Policies decide who can do what

Uploads, downloads, listings and deletes run as the caller's Postgres role (`anon`, `authenticated` or `service_role`), with the user's token available to SQL. Your [row level security](/database/row-level-security) policies on the `storage.objects` table then decide what's allowed:

```sql
create policy "Users manage their own folder" on storage.objects
  for all to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
```

Without a policy, only the service role key (and Studio) can upload, list or delete files. See [Access control](/storage/access-control) for more patterns.

## File metadata in `storage.objects`

Keel stores a row for every file in the `storage.objects` table of the project's database, and one for every bucket in `storage.buckets`. The layout matches Supabase, so you can query and join it like any other table:

```sql
select name, metadata->>'mimetype' as type, (metadata->>'size')::bigint as bytes, owner_id, created_at
from storage.objects
where bucket_id = 'avatars'
order by created_at desc;
```

| Column | What it holds |
|---|---|
| `id` | The object's UUID |
| `bucket_id` | The bucket it's in |
| `name` | Its path, for example `8d2b…/avatar.png` |
| `owner_id` | ID of the user who uploaded it (text), or null for uploads made with only the anon or service role key |
| `owner` | The same ID as a `uuid` (kept for compatibility) |
| `metadata` | Set by Keel, including `size`, `mimetype`, `eTag`, `cacheControl` and `lastModified` |
| `user_metadata` | Your own JSON, from the `metadata` upload option |
| `created_at`, `updated_at` | Timestamps |

Change files through the Storage API, not by editing these tables: a row without its file on disk (or the reverse) shows up as a missing or invisible file.

## Where files live on disk

The bytes aren't in Postgres. They're in Keel's storage folder, in folders named after IDs rather than file names:

```text
<storage root>/<database>/<bucket>/<object id>/<version>
```

| Install | Storage root on the host |
|---|---|
| Installer, or the compose file set up by hand | `storage/` in the install folder, such as `/opt/keel/storage` |
| ZimaOS (installer or App Store) | `/DATA/AppData/keel/storage` |
| Built from source | The `keel-storage` Docker volume (`keel_keel-storage`) |

Inside the containers, it's mounted at `/var/lib/keel/storage`.

Each project's folder also has a `.tmp` folder for uploads in progress and an `.uploads` folder for unfinished [resumable uploads](/storage/resumable-uploads). Because folder names come from IDs, a file name like `../../etc/passwd` can't reach outside the storage root.

::: warning Turn on full backups to keep your files
Keel's nightly project backups are `pg_dump` files of each database. They include `storage.objects` but not the files themselves. [Full backups](/self-hosting/backups#full-backups) (on once `KEEL_BACKUP_PASSPHRASE` is set) hold every uploaded file as well, encrypted, and can be copied to an S3 bucket off the server.
:::

## Size and type limits

| Limit | Default | Set with |
|---|---|---|
| Largest file, whole server | 500 MB with the installer and on ZimaOS, 50 MB when built from source | `KEEL_STORAGE_MAX_FILE_SIZE` (bytes) in `.env`, see [Configuration](/self-hosting/configuration) |
| Largest file, per bucket | No extra limit | The bucket's `file_size_limit` |
| Allowed file types, per bucket | Any | The bucket's `allowed_mime_types`, for example `['image/*', 'application/pdf']` |

The effective size limit is the smaller of the server limit and the bucket limit. Uploads over it fail with `413` and the message `The object exceeded the maximum allowed size`. Uploads whose content type isn't on the bucket's list fail with `415` and `mime type text/html is not supported`. A content type that isn't a single valid `type/subtype` also fails with `415` (see [content types](/storage/uploads#content-types)). These checks also apply to [resumable uploads](/storage/resumable-uploads), before any data is sent, and to copies, against the destination bucket.

## Storage in Studio

Open **Storage** in Studio's dock to manage files without writing code:

- **Buckets** appear as chips along the top, with a globe icon for public buckets and a lock for private ones. The **+** chip opens the **New bucket** form: **Name**, **Public bucket**, **Max file size** (for example `5MB`) and **Allowed types**.
- **Upload** files with the button or by dragging them onto the file list. **New folder** creates a folder at the current path. Studio uploads use the service role, so they ignore your policies (not the bucket's size and type limits) and overwrite a file that has the same name.
- Click a file to see its path, type, size and last update, a preview for images, its **Public URL** (public buckets only) and a **Signed URL (valid 1 hour)**, plus **Download** and **Delete** buttons.
- The gear icon opens **Bucket settings**: switch **Public bucket** on or off, see the file count and total size, and **Delete bucket** (which deletes all its files).

Studio's side panel shows how much space the project's files take up in total.

## What's not supported yet

Keel covers the Storage API that `supabase-js` uses for buckets, uploads, downloads, signed URLs, resumable uploads and image transformations. These Supabase features aren't available:

- The S3-compatible API, vector buckets and analytics buckets
- Moving a file to a different bucket with `move()` (copying between buckets works)
- `listV2()`, `purgeCache()` and file versions (`versionId`)

See [Supabase compatibility](/reference/compatibility) for the full list.

## Next steps

<div class="cards">
  <a class="card" href="./uploads"><strong>Uploading files</strong><span>Buckets, uploads, listing, moving and signed upload URLs.</span></a>
  <a class="card" href="./resumable-uploads"><strong>Resumable uploads</strong><span>Big files that survive dropped connections, with TUS.</span></a>
  <a class="card" href="./serving-files"><strong>Serving files</strong><span>Public URLs, signed URLs, downloads and caching.</span></a>
  <a class="card" href="./image-transformations"><strong>Image transformations</strong><span>Resize and convert images on the fly.</span></a>
  <a class="card" href="./access-control"><strong>Access control</strong><span>Storage policies for folders, teams and file types.</span></a>
</div>
