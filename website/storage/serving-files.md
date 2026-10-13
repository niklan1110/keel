# Serving files

Show uploaded files in your app and share them with links. Files in public buckets have permanent public URLs. Files in private buckets are shared with signed URLs that expire, or downloaded with the user's token.

```js
// Public bucket: a permanent URL, no request needed
const { data } = keel.storage.from('avatars').getPublicUrl(`${user.id}/avatar.png`)

// Private bucket: a link that works for one hour
const { data: signed } = await keel.storage
  .from('documents')
  .createSignedUrl(`${user.id}/contract.pdf`, 3600)
```

| You want to | Use |
|---|---|
| Show images from a public bucket in `<img>` tags | [`getPublicUrl()`](#public-urls) |
| Share a private file, or show it in `<img>`, `<video>` or a new tab | [`createSignedUrl()`](#signed-urls) |
| Read a private file's contents in your code | [`download()`](#downloading-with-a-token) |
| Show a smaller version of an image | [Image transformations](/storage/image-transformations) |

## Public URLs

```js
const { data } = keel.storage.from('avatars').getPublicUrl(`${user.id}/avatar.png`)
console.log(data.publicUrl)
// http://localhost:8000/my-app/storage/v1/object/public/avatars/8d2b…/avatar.png
```

```html
<img src="http://localhost:8000/my-app/storage/v1/object/public/avatars/8d2b…/avatar.png" alt="" />
```

Public URLs follow a fixed pattern, so you can also build them yourself:

```text
<API URL>/storage/v1/object/public/<bucket>/<path>
```

`getPublicUrl()` builds the URL in your app without asking the server, so it doesn't check that the file exists or that the bucket is public. Requesting a file in a private bucket this way fails with `400 Object not found`. Anyone can open a public URL, with no key and no sign-in.

::: tip Use an address your users can reach
URLs start with the API URL you passed to `createClient`. If that's `http://localhost:8000/my-app`, the links only work on the server itself. Use your server's network address or domain, as described in [Connecting your app](/guide/connecting#reaching-keel-from-other-devices).
:::

## Signed URLs

A signed URL gives temporary access to one file in a private bucket. Anyone with the link can download the file until it expires, without a key or a sign-in:

```js
const { data, error } = await keel.storage
  .from('documents')
  .createSignedUrl(`${user.id}/contract.pdf`, 60 * 60) // seconds

console.log(data.signedUrl)
// http://localhost:8000/my-app/storage/v1/object/sign/documents/8d2b…/contract.pdf?token=eyJhbGciOi…
```

- **Creating** a signed URL goes through your policies: the user needs read access to the file (a `select` policy). With the service role key, you can sign any file.
- `expiresIn` is in seconds. Pick the shortest time that works: a link can't be revoked once it's out, short of deleting or moving the file.
- The link belongs to the bucket and path, not to the file's contents. Replace the file and the link serves the new version. Move or delete it and the link stops working.
- An expired link fails with `400 "exp" claim timestamp check failed`. A link whose path was edited fails with `400 The url do not match the signature`.

Sign many files in one request with `createSignedUrls()`:

```js
const { data, error } = await keel.storage
  .from('documents')
  .createSignedUrls([`${user.id}/a.pdf`, `${user.id}/b.pdf`], 600)

// data: [{ path, signedUrl, error }, …]
```

Paths the user can't read (or that don't exist) come back with `signedUrl: null` and `error: 'Either the object does not exist or you do not have access to it'`, while the others still get a URL.

## Downloading with a token

`download()` fetches a file with the signed-in user's token, checked against your policies, and gives you a `Blob`:

```js
const { data, error } = await keel.storage.from('documents').download(`${user.id}/notes.txt`)
const text = await data.text()

// Or show a private image without creating a signed URL
const { data: image } = await keel.storage.from('photos').download(`${user.id}/cat.jpg`)
document.querySelector('img').src = URL.createObjectURL(image)
```

Any HTTP client can do the same with the `authenticated` URL and an `Authorization` header:

::: code-group

```js [JavaScript]
const res = await fetch(
  `http://localhost:8000/my-app/storage/v1/object/authenticated/documents/${path}`,
  { headers: { Authorization: `Bearer ${session.access_token}` } },
)
```

```bash [curl]
curl 'http://localhost:8000/my-app/storage/v1/object/authenticated/documents/8d2b…/notes.txt' \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

:::

Because these need a header, you can't put them in an `<img src>` or a link. Use a signed URL there.

`download()` uses the authenticated route even for files in public buckets, so it needs a `select` policy there too. For public files, `fetch(publicUrl)` needs none.

## Forcing a download

Browsers display images, PDFs and videos instead of saving them. Add the `download` option to make the link save the file:

```js
// Saved under the file's own name
keel.storage.from('reports').getPublicUrl('2026/q1.pdf', { download: true })

// Saved under a name you choose
await keel.storage.from('documents').createSignedUrl(path, 600, { download: 'Contract 2026.pdf' })
```

This adds `download` to the URL's query string, and Keel answers with a `Content-Disposition: attachment` header. You can add it to any public, signed or authenticated URL yourself: `?download` for the file's own name, or `?download=report.pdf` for another one (`&download=…` after a signed URL's token).

## Caching

Keel sends these headers with every file:

| Header | Value |
|---|---|
| `Content-Type` | The type stored when the file was uploaded (see [content types](/storage/uploads#content-types)) |
| `Cache-Control` | `max-age=` followed by the `cacheControl` upload option. Default `max-age=3600` (one hour). |
| `ETag` | A hash of the file's contents |
| `Last-Modified` | When the file was last uploaded, replaced or moved |
| `Accept-Ranges` | `bytes` |

When a browser's cached copy runs out, it asks again with `If-None-Match`, and Keel answers `304 Not Modified` without resending the file if it hasn't changed.

Choose `cacheControl` per file when you upload it:

- Files that never change at their path (for example, named with a random ID): a long time, like `'31536000'` (a year).
- Files you overwrite in place, like `avatar.png`: a short time, so users see the new version soon.

### Range requests

Keel supports single byte ranges (`Range: bytes=0-1023`, `bytes=1024-`, `bytes=-500`) and answers with `206 Partial Content`. That's what lets `<video>` and `<audio>` players seek, and download managers resume. A range outside the file gets `416`. Requests for several ranges at once get the whole file.

## Security headers

Files come from your Keel server's address, so a malicious upload could try to run scripts there. Keel blocks that:

- Keel stores only a single, well-formed content type for each file (see [content types](/storage/uploads#content-types)), so a value such as `image/png, text/html` can't pass as an image.
- Every file is sent with `X-Content-Type-Options: nosniff`, so browsers use the stored type instead of guessing from the contents.
- Files whose type a browser might run (HTML, SVG, XML, JavaScript, and any type Keel doesn't know) also get `Content-Security-Policy: sandbox; default-src 'none'`. Opened directly, they display, but scripts don't run, forms can't be sent and nothing else loads, not even the styles inside an SVG. SVGs in `<img>` tags look the same as always.
- Types that browsers only display or download don't get that header: images other than SVG, audio, video, PDF, `text/plain`, `text/csv`, `application/json`, `application/octet-stream`, fonts and archives such as ZIP.

This means storage isn't a place to host a website. To control what users can upload in the first place, set the bucket's allowed types (see [Size and type limits](/storage/overview#size-and-type-limits)).

## File details

Get a file's details without downloading it, or check whether it exists. Both need read access:

```js
const { data } = await keel.storage.from('documents').info(`${user.id}/contract.pdf`)
// { id, name, size, contentType, cacheControl, etag, metadata, lastModified, createdAt, bucketId, version }

const { data: found } = await keel.storage.from('documents').exists(`${user.id}/contract.pdf`)
// true or false
```

## URL formats

All paths are under your API URL, for example `http://localhost:8000/my-app`:

| URL | Who can open it |
|---|---|
| `/storage/v1/object/public/<bucket>/<path>` | Anyone, for files in public buckets |
| `/storage/v1/object/sign/<bucket>/<path>?token=…` | Anyone with the link, until it expires |
| `/storage/v1/object/authenticated/<bucket>/<path>` | Requests with a token whose policies allow reading the file |
| `/storage/v1/render/image/…` | The same three, resized: see [Image transformations](/storage/image-transformations) |

Every endpoint, with its parameters and responses, is in the [Storage API reference](/api/storage).
