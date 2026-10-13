# Resumable uploads

Resumable uploads send a file in chunks. If the connection drops, the upload continues from where it stopped instead of starting over. Keel speaks the [TUS](https://tus.io) protocol at the same address as Supabase, so [tus-js-client](https://github.com/tus/tus-js-client), Uppy and other TUS clients work unchanged.

Use them for big files (videos, archives, anything over a few megabytes), for uploads from phones, and whenever you want a progress bar.

```text
http://localhost:8000/my-app/storage/v1/upload/resumable
```

## Upload with tus-js-client

```bash
npm install tus-js-client
```

```js
import * as tus from 'tus-js-client'

const { data: { session } } = await keel.auth.getSession()

function uploadFile(bucketName, objectName, file) {
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: 'http://localhost:8000/my-app/storage/v1/upload/resumable',
      headers: {
        authorization: `Bearer ${session.access_token}`,
        'x-upsert': 'true', // replace the file if it exists (optional)
      },
      metadata: {
        bucketName,
        objectName,
        contentType: file.type,
        cacheControl: '3600',
      },
      chunkSize: 6 * 1024 * 1024,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      onProgress: (sent, total) => console.log(`${Math.round((sent / total) * 100)}%`),
      onError: reject,
      onSuccess: resolve,
    })

    // Continue an earlier, unfinished upload of the same file, if there is one
    upload.findPreviousUploads().then((previous) => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0])
      upload.start()
    })
  })
}

await uploadFile('videos', `${session.user.id}/holiday.mp4`, file)
```

When the last byte arrives, the file becomes a normal object: list it, download it and serve it like any other.

### Metadata

TUS sends these in the `Upload-Metadata` header. tus-js-client encodes them for you.

| Key | Required | Description |
|---|---|---|
| `bucketName` | yes | The bucket to upload into |
| `objectName` | yes | The file's path in the bucket, for example `8d2b…/holiday.mp4` |
| `contentType` | no | The file's type. Default `application/octet-stream`. Stored [cleaned up](/storage/uploads#content-types) and checked against the bucket's allowed types. |
| `cacheControl` | no | Seconds browsers may cache the file. Default `3600`. |
| `metadata` | no | A JSON string with your own metadata, stored like the `metadata` option of `upload()` |

### Headers

| Header | Description |
|---|---|
| `authorization` | `Bearer <token>`: a user's access token, or the anon or service role key. Required on every request. |
| `x-upsert` | `true` to replace an existing file at the same path. Without it, the upload is refused with `409` if the path is taken. Only read when the upload is created. |

You don't need an `apikey` header for storage requests. If you send one without `authorization`, Keel uses it as the token.

## Chunk size

Keel accepts chunks of any size and keeps whatever part of a chunk arrived before a connection dropped. A chunk size of **6 MB** is a good default: small enough that a retry is cheap, large enough to keep the number of requests down. It's also the size Supabase requires, so the same code works on both.

Without `chunkSize`, tus-js-client sends the whole file in one request. That still works, and a dropped connection still resumes from the last byte Keel received.

## Resuming

tus-js-client remembers unfinished uploads in the browser's local storage. `findPreviousUploads()` and `resumeFromPreviousUpload()` pick one up after a page reload. The client asks Keel how much it already has (a `HEAD` request) and sends only the rest.

An upload can only be continued by the **same user** who started it. Any valid token for that user works, so you can refresh the token during a long upload. Access tokens expire after an hour by default, so for very long uploads set the header on each request instead of once:

```js
const upload = new tus.Upload(file, {
  // ...same options as above, without the authorization header
  onBeforeRequest: async (req) => {
    const { data: { session } } = await keel.auth.getSession()
    req.setHeader('authorization', `Bearer ${session.access_token}`)
  },
})
```

Another user's token gets `404` for the upload, as if it didn't exist.

### Expiry

Unfinished uploads expire **24 hours after they were started**, whether or not they're still progressing. Keel's responses include an `Upload-Expires` header with the exact time. After that, the next request for the upload fails with `410 Upload expired` and the partial file is deleted. Keel also sweeps out expired uploads once an hour.

### Canceling

`upload.abort(true)` stops the upload and tells Keel to delete the partial file right away. `upload.abort()` only pauses it, so it can be resumed later.

## Policies are checked up front

When an upload is created, Keel checks everything it can **before any data is sent**: that the bucket exists, the declared size against the size limits, the content type against the bucket's allowed types, and your storage policies (with a trial insert that's rolled back). A refused upload fails immediately:

| Status | Message | Why |
|---|---|---|
| 403 | `new row violates row-level security policy` | No policy allows this user to create the file |
| 404 | `Bucket not found` | `bucketName` is wrong |
| 409 | `The resource already exists` | The path is taken and `x-upsert` isn't `true` |
| 413 | `The object exceeded the maximum allowed size` | The file is bigger than the bucket's or the server's limit |
| 415 | `mime type video/x-msvideo is not supported` | `contentType` isn't one of the bucket's allowed types, or isn't a single valid `type/subtype` |

The policies are checked again, for real, when the last byte arrives and the file is saved as the uploader. A new upload needs only an `insert` policy; with `x-upsert: true` it also needs `select` and `update` (see [what each operation needs](/storage/access-control#what-each-operation-needs)).

## Upload with Uppy

[Uppy](https://uppy.io) gives you a ready-made upload widget with drag and drop, previews and progress. Its Tus plugin talks to Keel directly:

```js
import Uppy from '@uppy/core'
import Dashboard from '@uppy/dashboard'
import Tus from '@uppy/tus'

const { data: { session } } = await keel.auth.getSession()

const uppy = new Uppy()
  .use(Dashboard, { inline: true, target: '#uploader' })
  .use(Tus, {
    endpoint: 'http://localhost:8000/my-app/storage/v1/upload/resumable',
    headers: { authorization: `Bearer ${session.access_token}` },
    chunkSize: 6 * 1024 * 1024,
    uploadDataDuringCreation: true,
    removeFingerprintOnSuccess: true,
    allowedMetaFields: ['bucketName', 'objectName', 'contentType', 'cacheControl'],
  })

uppy.on('file-added', (file) => {
  file.meta = {
    ...file.meta,
    bucketName: 'videos',
    objectName: `${session.user.id}/${file.name}`,
    contentType: file.type,
  }
})
```

## Limits

| | |
|---|---|
| Largest file | The smaller of `KEEL_STORAGE_MAX_FILE_SIZE` (500 MB by default with the installer and on ZimaOS, 50 MB when built from source) and the bucket's `file_size_limit`. See [Configuration](/self-hosting/configuration). |
| Chunk size | Any |
| Unfinished uploads | Deleted 24 hours after they were started |
| File size | Must be known up front (`Upload-Defer-Length` isn't supported) |
| Parallel requests | One at a time per upload. A second request while one is writing gets `423`. |
| TUS version and extensions | 1.0.0 with `creation`, `creation-with-upload`, `termination` and `expiration` |

Partial uploads are kept in the project's `.uploads` folder in Keel's storage folder until they finish or expire. The raw HTTP requests are listed in the [Storage API reference](/api/storage#resumable-uploads-tus).
