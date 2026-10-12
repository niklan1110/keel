# Uploading files

Create a bucket, upload files into it from a browser or a server, and organize them with list, move, copy and remove. Everything on this page uses `keel.storage` from `@supabase/supabase-js`.

```js
const { data, error } = await keel.storage
  .from('avatars')
  .upload(`${user.id}/avatar.png`, file, { upsert: true })

// data: { id: '…', path: '8d2b…/avatar.png', fullPath: 'avatars/8d2b…/avatar.png' }
```

## Create a bucket

Create buckets in Studio (**Storage**, then **+**) or from code with the service role key:

```js
import { createClient } from '@supabase/supabase-js'

const admin = createClient('http://localhost:8000/my-app', 'YOUR_SERVICE_ROLE_KEY', {
  auth: { persistSession: false },
})

const { data, error } = await admin.storage.createBucket('avatars', {
  public: true,
  fileSizeLimit: '2MB',
  allowedMimeTypes: ['image/*'],
})
```

| Option | Type | Description |
|---|---|---|
| `public` | boolean | Anyone with a file's URL can download it. Default `false`. |
| `fileSizeLimit` | number or string | Largest file in this bucket: bytes (`2097152`) or a string with a unit (`'500KB'`, `'2MB'`, `'1.5GB'`). Units are `B`, `KB`, `MB` and `GB`, in steps of 1024. The server-wide `KEEL_STORAGE_MAX_FILE_SIZE` still applies. |
| `allowedMimeTypes` | string[] | Content types the bucket accepts. Exact (`'application/pdf'`) or wildcard (`'image/*'`). Empty or missing means any type. |

The bucket name is also its ID. See [bucket name rules](/storage/overview#buckets-and-objects).

`storage.buckets` has row level security switched on and no policies, so only the service role key (and Studio) can create, change or delete buckets, and `listBuckets()` returns an empty list for other keys. That's usually what you want. If your app does need to see buckets, add a policy on `storage.buckets` (see [Access control](/storage/access-control#bucket-policies)).

### Manage buckets

```js
await admin.storage.updateBucket('avatars', { public: true, fileSizeLimit: '5MB' })
const { data: bucket } = await admin.storage.getBucket('avatars')
const { data: buckets } = await admin.storage.listBuckets()

await admin.storage.emptyBucket('avatars')   // deletes every file in it
await admin.storage.deleteBucket('avatars')  // only works on an empty bucket
```

`deleteBucket` fails with `The bucket you tried to delete is not empty` until you empty the bucket. Studio's **Delete bucket** does both steps for you.

## Upload a file

```js
const { data, error } = await keel.storage
  .from('avatars')
  .upload(`${user.id}/avatar.png`, file, {
    cacheControl: '3600',
    upsert: false,
  })
```

| Option | Default | Description |
|---|---|---|
| `upsert` | `false` | Replace the file if one already exists at this path. Without it, uploading to a taken path fails with `409 The resource already exists`. |
| `contentType` | `text/plain;charset=UTF-8` | The file's type, stored and sent back as `Content-Type` when it's downloaded (see [content types](#content-types)). Only used for `ArrayBuffer`, `Buffer`, string and stream uploads: a `File` or `Blob` always uses its own `type`. |
| `cacheControl` | `'3600'` | How many seconds browsers may cache the file. Served as `Cache-Control: max-age=3600`. A value that isn't a number of seconds (such as `'1h'`) falls back to `3600`. |
| `metadata` | none | Your own JSON object, stored in `user_metadata` and returned by `info()`. |

### Content types

Keel checks the type an upload declares and stores a cleaned-up version:

- It must be one `type/subtype`, such as `image/png`. A list (`image/png, text/html`), a wildcard, or a value with stray characters is refused with `415`.
- The type is lowercased, and parameters are dropped, except `charset` on `text/*` types: `Text/Plain; charset=UTF-8; format=flowed` is stored as `text/plain;charset=UTF-8`.
- The bucket's allowed types are checked against this stored type.

Files are served with the stored type. Types a browser could run, such as HTML and SVG, are served in a sandbox (see [Security headers](/storage/serving-files#security-headers)).

### Choosing paths

Put each user's files in a folder named after their user ID, such as `${user.id}/avatar.png`. Storage policies can then compare the first folder with `auth.uid()`, which is the most common way to keep users' files apart (see [Access control](/storage/access-control)). Other tips:

- Use a fixed name (`avatar.png`) with `upsert: true` when each user has one of something, or a unique name (`${crypto.randomUUID()}.jpg`) when they can have many.
- Leading and trailing slashes are removed, and repeated slashes are collapsed: `/a//b.png` is stored as `a/b.png`.
- Paths are case-sensitive: `Photo.JPG` and `photo.jpg` are two different files.

### From a browser file input

```html
<input type="file" id="avatar" accept="image/*" />
```

```js
document.querySelector('#avatar').addEventListener('change', async (event) => {
  const file = event.target.files[0]
  if (!file) return

  const { data: { user } } = await keel.auth.getUser()
  const extension = file.name.split('.').pop()
  const { error } = await keel.storage
    .from('avatars')
    .upload(`${user.id}/avatar.${extension}`, file, { upsert: true })

  if (error) alert(error.message)
})
```

The browser fills in the file's type (`image/png`, `image/jpeg`, …) from its name, and Keel stores it.

### From Node.js

Read the file into a `Buffer` and pass `contentType`, since a `Buffer` has no type of its own:

```js
import { readFile } from 'node:fs/promises'

const pdf = await readFile('./invoice-1042.pdf')
const { error } = await admin.storage
  .from('invoices')
  .upload('2026/invoice-1042.pdf', pdf, { contentType: 'application/pdf' })
```

For big files, pass a stream instead. Keel writes it to disk as it arrives:

```js
import { createReadStream } from 'node:fs'

await admin.storage
  .from('backups')
  .upload('photos-2026.tar.gz', createReadStream('./photos-2026.tar.gz'), {
    contentType: 'application/gzip',
  })
```

For files over a few megabytes, especially from phones or slow networks, consider [resumable uploads](/storage/resumable-uploads): a dropped connection then costs one chunk instead of the whole file.

### Errors

| Status | Message | Why |
|---|---|---|
| 400 | `Invalid key: …` | The path breaks the [path rules](/storage/overview#buckets-and-objects) |
| 403 | `new row violates row-level security policy` | No policy allows this upload |
| 404 | `Bucket not found` | The bucket doesn't exist |
| 409 | `The resource already exists` | A file is already at this path and `upsert` is off |
| 413 | `The object exceeded the maximum allowed size` | Over the bucket's or the server's size limit |
| 415 | `mime type image/gif is not supported` | The type isn't in the bucket's allowed types |
| 415 | `invalid mime type "image/png, text/html"` | The type isn't a single valid `type/subtype` (see [content types](#content-types)) |

## Replace a file

`update()` replaces an existing file and fails with `404` if there's nothing at the path. `upload()` with `upsert: true` creates or replaces:

```js
await keel.storage.from('avatars').update(`${user.id}/avatar.png`, newFile)
```

Browsers that cached the old file can keep showing it until its `cacheControl` time runs out. For files that change often, use a short `cacheControl` or upload each version to a new path.

## List files

`list()` returns the files and folders directly inside a folder:

```js
const { data, error } = await keel.storage.from('documents').list(`${user.id}/invoices`, {
  limit: 100,
  offset: 0,
  sortBy: { column: 'created_at', order: 'desc' },
  search: 'march',
})
```

| Option | Default | Description |
|---|---|---|
| `limit` | `100` | Entries to return, up to 1000 |
| `offset` | `0` | Entries to skip, for paging |
| `sortBy` | `{ column: 'name', order: 'asc' }` | `column` is `name`, `created_at`, `updated_at` or `last_accessed_at`. `order` is `asc` or `desc`. |
| `search` | none | Only entries whose name starts with this text (not case-sensitive), as on Supabase |

Each entry has `name`, `id`, `created_at`, `updated_at`, `last_accessed_at` and `metadata` (with `size` and `mimetype`). Folders are entries with `id: null`. Listing runs through your policies, so users only see files they're allowed to read.

## Move and rename

```js
await keel.storage.from('documents').move(`${user.id}/draft.pdf`, `${user.id}/final.pdf`)
```

Moving only renames the file's database row, so it's instant even for big files. The destination must be in the same bucket and must not exist yet. Moving to another bucket isn't supported: copy the file, then remove the original.

## Copy

```js
await keel.storage.from('documents').copy(`${user.id}/template.docx`, `${user.id}/letter.docx`)

// Into another bucket
await keel.storage.from('documents').copy('report.pdf', '2026/report.pdf', {
  destinationBucket: 'archive',
})
```

The copy belongs to the user who made it. It fails with `409` if the destination exists. The destination bucket's limits apply as they would to an upload: a file that's too big fails with `413`, and one whose type isn't in the bucket's allowed types fails with `415`.

## Delete files

```js
const { data, error } = await keel.storage
  .from('documents')
  .remove([`${user.id}/old.pdf`, `${user.id}/older.pdf`])
// data: the deleted files
```

`remove()` takes exact paths, not folders. Paths that don't exist or that the user may not delete are skipped, so compare `data.length` with what you asked for. To delete a folder, `list()` its contents (and those of any subfolders) and remove them.

## Download a file

```js
const { data, error } = await keel.storage.from('documents').download(`${user.id}/final.pdf`)
// data is a Blob
const text = await data.text()
```

`download()` sends the user's token and goes through your policies, even for files in a public bucket. To show files in `<img>` tags or share links, use URLs instead: see [Serving files](/storage/serving-files).

## Signed upload URLs

A signed upload URL lets someone upload one specific file without a token or a policy of their own. Create it on your server (or in an edge function), where you've decided the upload is allowed, and hand it to the client:

```js
// Server: create the URL with the service role key
const { data, error } = await admin.storage
  .from('uploads')
  .createSignedUploadUrl(`${userId}/scan.pdf`)
// data: { signedUrl, token, path }
```

```js
// Client: upload with the token, no sign-in needed
const { data, error } = await keel.storage
  .from('uploads')
  .uploadToSignedUrl(path, token, file)
```

- The URL is valid for **2 hours** and works for that one path only.
- Pass `{ upsert: true }` to `createSignedUploadUrl` to allow replacing an existing file. Without it, a second upload to the same path fails with `409`.
- Policies are checked when the URL is **created**, against whoever creates it. The upload itself skips them, but the bucket's size and type limits still apply.
- The uploaded file's owner is the user who created the URL (none if it was the service role key).

Any HTTP client can use the signed URL with a `PUT`:

```bash
curl -X PUT 'SIGNED_UPLOAD_URL' \
  -H 'Content-Type: application/pdf' \
  --data-binary @scan.pdf
```
