# Storage

The Storage API manages buckets and files. It follows the Supabase Storage API, so `keel.storage` in supabase-js uses it for you (see the [Storage guide](/storage/overview)). This page is for other languages, scripts and debugging.

Paths are relative to your API URL, for example `http://localhost:8000/my-app`. In paths, `:bucket` is a bucket ID and `:path` is a file's path inside it, which may contain slashes (`8d2b…/photos/cat.jpg`). Encode each part of a path for the URL, but keep the slashes.

## Authentication

Send a token in the `Authorization` header:

| Token | Acts as | Storage policies |
|---|---|---|
| A user's access token | `authenticated`, with `auth.uid()` set | Apply |
| The anon key | `anon` | Apply |
| The service role key | `service_role` | Bypassed |

```bash
-H "Authorization: Bearer USER_ACCESS_TOKEN"
```

If there's no `Authorization` header, Keel uses the `apikey` header as the token. Unlike the other APIs, storage doesn't require `apikey`, so public URLs, signed URLs and signed upload URLs work without any key. supabase-js sends both headers, which is fine.

| Status | Error | Message | Cause |
|---|---|---|---|
| 400 | `Unauthorized` | `headers must have required property 'authorization'` | No token on an endpoint that needs one |
| 400 | `Unauthorized` | `Invalid JWT` | The token isn't valid for this project |
| 400 | `Unauthorized` | `"exp" claim timestamp check failed` | The token has expired |

## Errors

Errors are JSON with the HTTP status repeated as a string:

```json
{ "statusCode": "409", "error": "Duplicate", "message": "The resource already exists" }
```

| Status | Error | Typical cause |
|---|---|---|
| 400 | `InvalidKey` | The file path is invalid (see [path rules](/storage/overview#buckets-and-objects)) |
| 400 | `Invalid Input` | Invalid bucket name or file size limit |
| 403 | `Unauthorized` | A storage policy refused the change (`new row violates row-level security policy`) |
| 404 | `Bucket not found`, `not_found` | No such bucket or file, or the caller's policies hide it |
| 409 | `Duplicate` | A bucket or file already exists with that name |
| 413 | `Payload too large` | The file is over the bucket's or the server's size limit |
| 415 | `invalid_mime_type` | The file's type isn't in the bucket's allowed types, or isn't a single valid `type/subtype` |

## Buckets

Creating, reading, changing and deleting buckets runs through the policies on `storage.buckets`. There are none by default, so in practice these endpoints need the service role key.

A bucket looks like this:

```json
{
  "id": "avatars",
  "name": "avatars",
  "owner": "",
  "public": true,
  "file_size_limit": 2097152,
  "allowed_mime_types": ["image/*"],
  "created_at": "2026-10-01T09:30:00.000Z",
  "updated_at": "2026-10-01T09:30:00.000Z"
}
```

`owner` is the ID of the user who created the bucket, or an empty string. `file_size_limit` is in bytes, and `null` means no bucket limit (the server-wide limit still applies). `allowed_mime_types` is `null` when any type is allowed.

### <code class="method get">GET</code> /storage/v1/bucket

Lists buckets.

| Name | Type | Description |
|---|---|---|
| `search` | query string | Only buckets whose name contains this text (not case-sensitive) |
| `limit` | query string | Number of buckets, up to 1000. Default 1000. |
| `offset` | query string | Buckets to skip. Default 0. |
| `sortColumn` | query string | `id`, `name`, `created_at` or `updated_at`. Default `name`. |
| `sortOrder` | query string | `asc` (default) or `desc` |

```bash
curl 'http://localhost:8000/my-app/storage/v1/bucket' \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY"
```

Returns an array of buckets.

### <code class="method get">GET</code> /storage/v1/bucket/:id

Returns one bucket, or `404 Bucket not found`.

```bash
curl 'http://localhost:8000/my-app/storage/v1/bucket/avatars' \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY"
```

### <code class="method post">POST</code> /storage/v1/bucket

Creates a bucket.

| Name | Type | Description |
|---|---|---|
| `id` | string | **Required** (or `name`). The bucket's ID: 1 to 100 letters, digits, spaces, `.`, `_` and `-`, starting with a letter or digit. `public`, `authenticated`, `sign`, `info`, `list`, `move`, `copy`, `upload` and `render` are reserved. |
| `name` | string | Display name. Defaults to `id`. |
| `public` | boolean | Serve files without checks at `/object/public/…`. Default `false`. |
| `file_size_limit` | number or string | Largest file in bytes, or a string such as `"5MB"` (units `B`, `KB`, `MB`, `GB`, in steps of 1024). `null`, `0` or missing: no bucket limit. |
| `allowed_mime_types` | string[] | Allowed content types, such as `["image/*", "application/pdf"]`. `null` or empty: any type. |

```bash
curl -X POST 'http://localhost:8000/my-app/storage/v1/bucket' \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": "avatars", "public": true, "file_size_limit": "2MB", "allowed_mime_types": ["image/*"]}'
```

```json
{ "name": "avatars" }
```

Fails with `409 Duplicate` if the bucket exists, and `403` if the caller isn't allowed to create buckets.

### <code class="method put">PUT</code> /storage/v1/bucket/:id

Changes a bucket's settings. Fields you leave out keep their value.

| Name | Type | Description |
|---|---|---|
| `public` | boolean | Make the bucket public or private |
| `file_size_limit` | number, string or `null` | New size limit, or `null` to remove it |
| `allowed_mime_types` | string[] or `null` | New allowed types, or `null` (or `[]`) to allow any type |

```bash
curl -X PUT 'http://localhost:8000/my-app/storage/v1/bucket/avatars' \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"public": false, "file_size_limit": null}'
```

```json
{ "message": "Successfully updated" }
```

### <code class="method post">POST</code> /storage/v1/bucket/:id/empty

Deletes all files in the bucket that the caller may delete (all of them with the service role key).

```bash
curl -X POST 'http://localhost:8000/my-app/storage/v1/bucket/avatars/empty' \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY"
```

```json
{ "message": "Successfully emptied" }
```

### <code class="method delete">DELETE</code> /storage/v1/bucket/:id

Deletes an empty bucket. Fails with `409 The bucket you tried to delete is not empty` if it still has files, and `403` if the caller isn't allowed to delete it.

```bash
curl -X DELETE 'http://localhost:8000/my-app/storage/v1/bucket/avatars' \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY"
```

```json
{ "message": "Successfully deleted" }
```

## Uploading

### <code class="method post">POST</code> /storage/v1/object/:bucket/:path

Uploads a new file. Needs an `insert` policy on `storage.objects`; with `x-upsert: true` it also needs `select` and `update` (see [Access control](/storage/access-control#what-each-operation-needs)).

Send the file in one of two ways:

- **Raw body**: the file's bytes, with its type in `Content-Type`.
- **Multipart form** (`multipart/form-data`): one file part, whose own content type is used, plus optional form fields `cacheControl`, `metadata` and `contentType`. This is what supabase-js sends for `File` and `Blob` uploads. The `contentType` field is checked like the header.

| Name | Type | Description |
|---|---|---|
| `Content-Type` | header | The file's type (raw body). Default `application/octet-stream`. Must be one valid `type/subtype`; it's stored lowercased, keeping only a `charset` on `text/*` types (see [content types](/storage/uploads#content-types)). |
| `Cache-Control` | header | `max-age=<seconds>` to serve the file with (raw body). Default `max-age=3600`. |
| `x-upsert` | header | `true` to replace an existing file. Otherwise an existing file causes `409`. |
| `x-metadata` | header | Your own metadata (raw body): a JSON object, base64-encoded. Stored in `user_metadata`. |
| `cacheControl` | form field | Seconds to cache the file (multipart). A value that isn't a number of seconds falls back to `3600`. |
| `metadata` | form field | Your own metadata as a JSON string (multipart) |

::: code-group

```bash [Raw body]
curl -X POST 'http://localhost:8000/my-app/storage/v1/object/avatars/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/avatar.png' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: image/png" \
  -H "Cache-Control: max-age=3600" \
  -H "x-upsert: true" \
  --data-binary @avatar.png
```

```bash [Multipart]
curl -X POST 'http://localhost:8000/my-app/storage/v1/object/avatars/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/avatar.png' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -F cacheControl=3600 \
  -F 'file=@avatar.png;type=image/png'
```

:::

```json
{
  "Id": "3f6c1d8e-5b2a-4c7e-9f10-2a4b6c8d0e1f",
  "Key": "avatars/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/avatar.png"
}
```

Can fail with `400 InvalidKey`, `403`, `404 Bucket not found`, `409 Duplicate`, `413` or `415`.

### <code class="method put">PUT</code> /storage/v1/object/:bucket/:path

Replaces an existing file. Takes the same body and headers as `POST` (without `x-upsert`) and fails with `404` if there's no file at the path. Needs `select` and `update` policies.

```bash
curl -X PUT 'http://localhost:8000/my-app/storage/v1/object/avatars/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/avatar.png' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @new-avatar.png
```

Returns `{ "Id": "…", "Key": "…" }` like `POST`.

## Downloading

All download endpoints send the file with `Content-Type`, `Cache-Control`, `ETag`, `Last-Modified`, `Accept-Ranges: bytes` and `X-Content-Type-Options: nosniff`, plus `Content-Security-Policy: sandbox; default-src 'none'` for every type that isn't known to be inert (HTML, SVG, XML, JavaScript and unknown types get it; see [Security headers](/storage/serving-files#security-headers)). They support:

| Name | Type | Description |
|---|---|---|
| `download` | query string | Add `Content-Disposition: attachment`. Empty (`?download`) uses the file's own name; `?download=report.pdf` sets one. |
| `Range` | header | One byte range, such as `bytes=0-1023`. Answered with `206`, or `416` if it's outside the file. |
| `If-None-Match` | header | The file's `ETag`. Answered with `304 Not Modified` if it hasn't changed. |

`HEAD` works on each of them and returns only the headers.

### <code class="method get">GET</code> /storage/v1/object/public/:bucket/:path

Downloads a file from a public bucket. No token needed. Files in private buckets get `400 Object not found`.

```bash
curl -O 'http://localhost:8000/my-app/storage/v1/object/public/avatars/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/avatar.png'
```

### <code class="method get">GET</code> /storage/v1/object/authenticated/:bucket/:path

Downloads a file with the caller's token, through the `select` policies. `GET /storage/v1/object/:bucket/:path` does the same (it's what supabase-js `download()` uses).

```bash
curl 'http://localhost:8000/my-app/storage/v1/object/authenticated/documents/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/notes.txt' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

Returns `404 Object not found` if the file doesn't exist or the caller can't read it.

### <code class="method head">HEAD</code> /storage/v1/object/:bucket/:path

Checks that a file exists and that the caller can read it, without downloading it: `200` with the download headers, or `404`. supabase-js `exists()` uses this.

```bash
curl -I 'http://localhost:8000/my-app/storage/v1/object/documents/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/notes.txt' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

### <code class="method get">GET</code> /storage/v1/object/info/:bucket/:path

Returns a file's details. Also available as `/object/info/authenticated/:bucket/:path` (same thing) and `/object/info/public/:bucket/:path` (no token, public buckets only).

```bash
curl 'http://localhost:8000/my-app/storage/v1/object/info/documents/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/notes.txt' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

```json
{
  "id": "3f6c1d8e-5b2a-4c7e-9f10-2a4b6c8d0e1f",
  "name": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/notes.txt",
  "version": "b7e2c0a4-1d3f-4e5a-8b6c-9d0e1f2a3b4c",
  "size": 11,
  "content_type": "text/plain;charset=UTF-8",
  "cache_control": "max-age=3600",
  "etag": "\"5eb63bbbe01eeed093cb22bb8f5acdc3\"",
  "metadata": null,
  "last_modified": "2026-10-01T09:31:12.345Z",
  "created_at": "2026-10-01T09:31:12.345Z",
  "bucket_id": "documents"
}
```

`metadata` is your own metadata from the upload.

## Managing files

### <code class="method post">POST</code> /storage/v1/object/list/:bucket

Lists the files and folders directly inside a folder, through the `select` policies.

| Name | Type | Description |
|---|---|---|
| `prefix` | string | The folder to list, such as `8d2b…/photos`. Empty for the top level. |
| `limit` | number | Entries to return, 1 to 1000. Default 100. |
| `offset` | number | Entries to skip. Default 0. |
| `sortBy` | object | `{ "column": "name", "order": "asc" }`. `column` is `name`, `created_at`, `updated_at` or `last_accessed_at`; `order` is `asc` or `desc`. |
| `search` | string | Only entries whose name starts with this text (not case-sensitive) |

```bash
curl -X POST 'http://localhost:8000/my-app/storage/v1/object/list/documents' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prefix": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b", "limit": 100, "offset": 0, "sortBy": {"column": "name", "order": "asc"}}'
```

```json
[
  {
    "name": "invoices",
    "id": null,
    "updated_at": null,
    "created_at": null,
    "last_accessed_at": null,
    "metadata": null
  },
  {
    "name": "notes.txt",
    "id": "3f6c1d8e-5b2a-4c7e-9f10-2a4b6c8d0e1f",
    "updated_at": "2026-10-01T09:31:12.345Z",
    "created_at": "2026-10-01T09:31:12.345Z",
    "last_accessed_at": "2026-10-01T09:31:12.345Z",
    "metadata": {
      "eTag": "\"5eb63bbbe01eeed093cb22bb8f5acdc3\"",
      "size": 11,
      "mimetype": "text/plain;charset=UTF-8",
      "cacheControl": "max-age=3600",
      "lastModified": "2026-10-01T09:31:12.345Z",
      "contentLength": 11,
      "httpStatusCode": 200
    }
  }
]
```

Folders have `id: null`.

### <code class="method post">POST</code> /storage/v1/object/move

Renames or moves a file within its bucket. Needs `select` and `update` policies.

| Name | Type | Description |
|---|---|---|
| `bucketId` | string | **Required.** The bucket |
| `sourceKey` | string | **Required.** The file's current path |
| `destinationKey` | string | **Required.** The new path |
| `destinationBucket` | string | Must be the same as `bucketId` if given: moving between buckets isn't supported |

```bash
curl -X POST 'http://localhost:8000/my-app/storage/v1/object/move' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bucketId": "documents", "sourceKey": "8d2b…/draft.pdf", "destinationKey": "8d2b…/final.pdf"}'
```

```json
{ "message": "Successfully moved" }
```

Fails with `404` if the source isn't found (or the caller can't change it), and `409` if the destination exists.

### <code class="method post">POST</code> /storage/v1/object/copy

Copies a file, within a bucket or into another one. The copy belongs to the caller. Needs `select` on the source and `insert` on the copy. The destination bucket's size limit (`413`) and allowed types (`415`) apply, as for an upload.

| Name | Type | Description |
|---|---|---|
| `bucketId` | string | **Required.** The source bucket |
| `sourceKey` | string | **Required.** The source path |
| `destinationKey` | string | **Required.** The path of the copy |
| `destinationBucket` | string | The bucket for the copy. Defaults to `bucketId`. |

```bash
curl -X POST 'http://localhost:8000/my-app/storage/v1/object/copy' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bucketId": "documents", "sourceKey": "8d2b…/template.docx", "destinationKey": "8d2b…/letter.docx"}'
```

```json
{
  "Id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "Key": "documents/8d2b…/letter.docx"
}
```

### <code class="method delete">DELETE</code> /storage/v1/object/:bucket

Deletes several files. Needs `select` and `delete` policies. Paths the caller can't delete, or that don't exist, are skipped.

| Name | Type | Description |
|---|---|---|
| `prefixes` | string[] | **Required.** Exact file paths to delete (not folder prefixes, despite the name) |

```bash
curl -X DELETE 'http://localhost:8000/my-app/storage/v1/object/documents' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prefixes": ["8d2b…/old.pdf", "8d2b…/older.pdf"]}'
```

Returns the deleted files:

```json
[
  {
    "name": "8d2b…/old.pdf",
    "id": "3f6c1d8e-5b2a-4c7e-9f10-2a4b6c8d0e1f",
    "bucket_id": "documents",
    "owner": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b",
    "version": "b7e2c0a4-1d3f-4e5a-8b6c-9d0e1f2a3b4c",
    "metadata": { "size": 48213, "mimetype": "application/pdf", "…": "…" },
    "user_metadata": null,
    "created_at": "2026-10-01T09:31:12.345Z",
    "updated_at": "2026-10-01T09:31:12.345Z",
    "last_accessed_at": "2026-10-01T09:31:12.345Z"
  }
]
```

### <code class="method delete">DELETE</code> /storage/v1/object/:bucket/:path

Deletes one file. Returns `{ "message": "Successfully deleted" }`, or `404` if the file doesn't exist or the caller can't delete it.

```bash
curl -X DELETE 'http://localhost:8000/my-app/storage/v1/object/documents/8d2b…/old.pdf' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

## Signed URLs

Signed URLs are JWTs signed with the project's secret and tied to one bucket and path. The `signedURL` and `url` values in responses are relative to `/storage/v1`: put `http://localhost:8000/my-app/storage/v1` in front of them.

### <code class="method post">POST</code> /storage/v1/object/sign/:bucket/:path

Creates a download link for one file. The caller needs `select` access to it.

| Name | Type | Description |
|---|---|---|
| `expiresIn` | number | Seconds until the link expires. Default 60. |
| `transform` | object | Image transformation to store in the token, used by `/render/image/sign/…` (see [Image transformations](/storage/image-transformations)) |

```bash
curl -X POST 'http://localhost:8000/my-app/storage/v1/object/sign/documents/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/contract.pdf' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expiresIn": 3600}'
```

```json
{
  "signedURL": "/object/sign/documents/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/contract.pdf?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
}
```

With `transform`, the URL points at `/render/image/sign/` instead and serves the resized image. The transform is fixed by the token; query parameters can't change it.

### <code class="method post">POST</code> /storage/v1/object/sign/:bucket

Creates download links for several files at once.

| Name | Type | Description |
|---|---|---|
| `paths` | string[] | **Required.** File paths in the bucket |
| `expiresIn` | number | Seconds until the links expire. Default 60. |

```bash
curl -X POST 'http://localhost:8000/my-app/storage/v1/object/sign/documents' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expiresIn": 600, "paths": ["8d2b…/a.pdf", "8d2b…/missing.pdf"]}'
```

```json
[
  { "error": null, "path": "8d2b…/a.pdf", "signedURL": "/object/sign/documents/8d2b…/a.pdf?token=eyJ…" },
  { "error": "Either the object does not exist or you do not have access to it", "path": "8d2b…/missing.pdf", "signedURL": null }
]
```

### <code class="method get">GET</code> /storage/v1/object/sign/:bucket/:path

Downloads a file with a signed link. No other token needed. Supports `download`, `Range` and `If-None-Match` like the other [download endpoints](#downloading).

| Name | Type | Description |
|---|---|---|
| `token` | query string | **Required.** The token from the signing endpoint |

| Status | Error | Message |
|---|---|---|
| 400 | `InvalidSignature` | `Missing token`, or `The url do not match the signature` (the token is for another file) |
| 400 | `InvalidJWT` | `"exp" claim timestamp check failed` (expired) or `Invalid signature` |
| 404 | `not_found` | The file was deleted or moved |

### <code class="method post">POST</code> /storage/v1/object/upload/sign/:bucket/:path

Creates a signed upload URL for one path, valid for 2 hours. The caller's policies are checked now, with a trial insert that's rolled back. The upload itself skips policies.

| Name | Type | Description |
|---|---|---|
| `x-upsert` | header | `true` to let the URL replace an existing file |

```bash
curl -X POST 'http://localhost:8000/my-app/storage/v1/object/upload/sign/uploads/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/scan.pdf' \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY"
```

```json
{
  "url": "/object/upload/sign/uploads/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/scan.pdf?token=eyJ…",
  "token": "eyJ…"
}
```

### <code class="method put">PUT</code> /storage/v1/object/upload/sign/:bucket/:path

Uploads a file with a signed upload URL. No other token needed. Takes the same raw or multipart body as a [regular upload](#uploading). The bucket's size and type limits apply, and the file's owner is whoever created the URL.

| Name | Type | Description |
|---|---|---|
| `token` | query string | **Required.** The token from the signing endpoint |

```bash
curl -X PUT 'http://localhost:8000/my-app/storage/v1/object/upload/sign/uploads/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/scan.pdf?token=eyJ…' \
  -H "Content-Type: application/pdf" \
  --data-binary @scan.pdf
```

```json
{
  "Key": "uploads/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/scan.pdf",
  "Id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f"
}
```

A second upload to the same path fails with `409` unless the URL was created with `x-upsert: true`.

## Image transformations

Resized versions of images, made by imgproxy (see [Image transformations](/storage/image-transformations)). All three endpoints take the same query parameters:

| Name | Type | Description |
|---|---|---|
| `width` | query string | 1 to 2500 pixels. `0` means not set. |
| `height` | query string | 1 to 2500 pixels. `0` means not set. |
| `resize` | query string | `cover` (default), `contain` or `fill` |
| `quality` | query string | 20 to 100. Default 80. |
| `format` | query string | `origin` to keep the original format. Otherwise the result is WebP when the request's `Accept` header includes `image/webp`. |

Responses have the image's `Content-Type`, the original file's `Cache-Control` and `X-Content-Type-Options: nosniff` (and the sandboxing `Content-Security-Policy` if the result is an SVG). Errors: `422 transformation_failed` if the file can't be transformed, `503 transformation_unavailable` if `keel-imgproxy` isn't running.

### <code class="method get">GET</code> /storage/v1/render/image/public/:bucket/:path

A resized image from a public bucket. No token needed.

```bash
curl -o thumb.webp 'http://localhost:8000/my-app/storage/v1/render/image/public/photos/beach.jpg?width=400&height=300&resize=cover' \
  -H "Accept: image/webp"
```

### <code class="method get">GET</code> /storage/v1/render/image/authenticated/:bucket/:path

A resized image, read with the caller's token through the `select` policies.

```bash
curl -o thumb.jpg 'http://localhost:8000/my-app/storage/v1/render/image/authenticated/photos/8d2b…/cat.jpg?width=200' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

### <code class="method get">GET</code> /storage/v1/render/image/sign/:bucket/:path

A resized image with a signed link. Uses the `transform` stored in the token; query parameters can't change it. `createSignedUrl()` with a `transform` option returns a URL for this endpoint.

| Name | Type | Description |
|---|---|---|
| `token` | query string | **Required.** A token from `POST /storage/v1/object/sign/:bucket/:path` |

## Resumable uploads (TUS)

[TUS 1.0.0](https://tus.io/protocols/resumable-upload) endpoints for big files, with the `creation`, `creation-with-upload`, `termination` and `expiration` extensions. Every request needs the `Authorization` header, and an upload can only be continued with a token for the user (and role) that created it. Responses include `Tus-Resumable: 1.0.0` and `Cache-Control: no-store`. See [Resumable uploads](/storage/resumable-uploads) for client examples.

### <code class="method post">POST</code> /storage/v1/upload/resumable

Creates an upload. Keel checks the bucket, size, content type and storage policies before accepting it.

| Name | Type | Description |
|---|---|---|
| `Upload-Length` | header | **Required.** The file's total size in bytes. `Upload-Defer-Length` isn't supported. |
| `Upload-Metadata` | header | **Required.** Comma-separated `key base64(value)` pairs: `bucketName` and `objectName` (required), `contentType`, `cacheControl`, `metadata` (a JSON string) |
| `Tus-Resumable` | header | `1.0.0` |
| `x-upsert` | header | `true` to replace an existing file |
| `Content-Type` | header | `application/offset+octet-stream` when sending the first bytes in the body (creation with upload) |

```bash
curl -i -X POST 'http://localhost:8000/my-app/storage/v1/upload/resumable' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: 10485760" \
  -H "Upload-Metadata: bucketName dmlkZW9z,objectName OGQyYjZmMmUtMGMxYS00ZjllLTlhNjMtNWMwZjFlMmQzYTRiL2hvbGlkYXkubXA0,contentType dmlkZW8vbXA0"
```

```http
HTTP/1.1 201 Created
Tus-Resumable: 1.0.0
Location: /my-app/storage/v1/upload/resumable/EHxlgIzf9vQSe1d-hgbMj_R_1VgwUtAG
Upload-Expires: Sun, 04 Oct 2026 09:30:00 GMT
```

`Location` is the upload's URL, used by the requests below. It is a path without a host: resolve it against the address you sent the `POST` to (tus-js-client and Uppy do), so uploads work from any address Keel is reached on. With a body, the response also has `Upload-Offset`. The upload expires 24 hours after it was created.

Can fail with `400` (missing `Upload-Length`, bad `objectName`), `403` (policies), `404 Bucket not found`, `409 Duplicate`, `413` or `415`.

### <code class="method head">HEAD</code> /storage/v1/upload/resumable/:id

Returns how many bytes Keel has, so a client knows where to continue.

```bash
curl -I 'http://localhost:8000/my-app/storage/v1/upload/resumable/EHxlgIzf9vQSe1d-hgbMj_R_1VgwUtAG' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Tus-Resumable: 1.0.0"
```

```http
HTTP/1.1 200 OK
Tus-Resumable: 1.0.0
Upload-Offset: 6291456
Upload-Length: 10485760
Upload-Expires: Sun, 04 Oct 2026 09:30:00 GMT
```

`404` means the upload doesn't exist, has finished, or belongs to someone else. `410` means it has expired.

### <code class="method patch">PATCH</code> /storage/v1/upload/resumable/:id

Appends bytes. When the last byte arrives, the file is saved as a regular object (with the uploader's policies checked again) and the upload URL stops working.

| Name | Type | Description |
|---|---|---|
| `Upload-Offset` | header | **Required.** Where these bytes start. Must equal the current offset. |
| `Content-Type` | header | **Required.** `application/offset+octet-stream` |
| `Tus-Resumable` | header | `1.0.0` |

```bash
curl -i -X PATCH 'http://localhost:8000/my-app/storage/v1/upload/resumable/EHxlgIzf9vQSe1d-hgbMj_R_1VgwUtAG' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Offset: 6291456" \
  -H "Content-Type: application/offset+octet-stream" \
  --data-binary @chunk-2.bin
```

```http
HTTP/1.1 204 No Content
Tus-Resumable: 1.0.0
Upload-Offset: 10485760
Upload-Expires: Sun, 04 Oct 2026 09:30:00 GMT
```

| Status | Cause |
|---|---|
| 409 | `Upload-Offset` doesn't match what Keel has. Send a `HEAD` and continue from its offset. |
| 413 | The bytes go past `Upload-Length` |
| 415 | Wrong `Content-Type` |
| 423 | Another request is writing to this upload |

If the connection drops in the middle, Keel keeps the bytes that arrived. Clients that can't send `PATCH` can send `POST` with `X-HTTP-Method-Override: PATCH`.

### <code class="method delete">DELETE</code> /storage/v1/upload/resumable/:id

Cancels an unfinished upload and deletes what was received. Returns `204`.

```bash
curl -X DELETE 'http://localhost:8000/my-app/storage/v1/upload/resumable/EHxlgIzf9vQSe1d-hgbMj_R_1VgwUtAG' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Tus-Resumable: 1.0.0"
```

## Health

### <code class="method get">GET</code> /storage/v1/health

Returns `{ "status": "ok" }` when the storage service is running. No token needed.
