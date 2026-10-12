# Image transformations

Keel can resize, crop and compress images as they're served, so you can upload one large photo and show thumbnails, avatars and previews without storing a copy of each size. Add a `transform` option when you get an image's URL or download it.

```js
const { data } = keel.storage.from('photos').getPublicUrl('beach.jpg', {
  transform: { width: 400, height: 300, resize: 'cover', quality: 75 },
})

console.log(data.publicUrl)
// http://localhost:8000/my-app/storage/v1/render/image/public/photos/beach.jpg?width=400&height=300&resize=cover&quality=75
```

```html
<img src="http://localhost:8000/my-app/storage/v1/render/image/public/photos/beach.jpg?width=400&height=300" alt="" />
```

The original file stays untouched. Each request is resized on the fly by the `keel-imgproxy` service.

## Options

| Option | Values | Description |
|---|---|---|
| `width` | 1 to 2500 | Width in pixels. Larger values are treated as 2500, and `0` means not set. |
| `height` | 1 to 2500 | Height in pixels. Larger values are treated as 2500, and `0` means not set. |
| `resize` | `cover` (default), `contain`, `fill` | How to fit the image into `width` × `height`, see below |
| `quality` | 20 to 100, default `80` | Compression quality for JPEG and WebP output. Lower is smaller and blurrier. |
| `format` | `origin` | Keep the original format instead of converting to WebP, see [Output format](#output-format) |

Give only `width` or only `height` to scale the image and keep its proportions. Give both to fit it into a box:

| `resize` | Result |
|---|---|
| `cover` | Fills the whole box and crops what sticks out, keeping the center. Good for thumbnails and avatars. |
| `contain` | Fits the whole image inside the box, keeping its proportions. One side may be smaller than asked. |
| `fill` | Stretches the image to exactly the box size, distorting it if the proportions differ. |

## Where you can use `transform`

### Public images

`getPublicUrl()` with `transform` returns a `/render/image/public/` URL. Like other public URLs, it needs no key and works in `<img>` tags.

### Private images with the user's token

`download()` with `transform` fetches the resized image through your policies and returns a `Blob`:

```js
const { data, error } = await keel.storage
  .from('photos')
  .download(`${user.id}/cat.jpg`, { transform: { width: 200, height: 200 } })

document.querySelector('#avatar').src = URL.createObjectURL(data)
```

### Private images with a signed URL

Pass `transform` to `createSignedUrl()`. The URL points at the image renderer (`/render/image/sign/…`) and serves the resized image:

```js
const { data } = await keel.storage
  .from('photos')
  .createSignedUrl(`${user.id}/cat.jpg`, 3600, { transform: { width: 200, height: 200 } })

document.querySelector('#thumb').src = data.signedUrl
```

The size is part of the signed token: adding `&width=…` to the URL doesn't change it. `createSignedUrls()` (for several files) doesn't take a `transform` option.

## Output format

When the browser says it accepts WebP (all current browsers do for images), Keel converts the result to **WebP**, which is usually much smaller than JPEG or PNG. Other clients, such as `curl` or `fetch` in Node.js, get the image in its original format.

To always keep the original format, pass `format: 'origin'`:

```js
keel.storage.from('photos').getPublicUrl('logo.png', {
  transform: { width: 120, format: 'origin' },
})
```

Other `format` values are ignored. AVIF output isn't available.

Source images can be JPEG, PNG, WebP, GIF or AVIF, along with the other formats [imgproxy](https://imgproxy.net) reads.

## Using the URLs directly

The transform URLs take the same options as query parameters, so you can build them in any language or template:

```text
<API URL>/storage/v1/render/image/public/<bucket>/<path>?width=400&height=300&resize=contain&quality=70
<API URL>/storage/v1/render/image/authenticated/<bucket>/<path>?width=400
<API URL>/storage/v1/render/image/sign/<bucket>/<path>?token=…
```

The `authenticated` URL needs an `Authorization: Bearer` header, like other [authenticated downloads](/storage/serving-files#downloading-with-a-token). Full details are in the [Storage API reference](/api/storage#image-transformations).

For example, a [Next.js image loader](https://nextjs.org/docs/app/api-reference/components/image#loader) that serves every `<Image>` from Keel at the size the page needs:

```js
// image-loader.js
const base = 'http://localhost:8000/my-app/storage/v1/render/image/public'

export default function keelLoader({ src, width, quality }) {
  return `${base}/${src}?width=${width}&quality=${quality || 75}`
}
```

```js
// next.config.js
module.exports = {
  images: { loader: 'custom', loaderFile: './image-loader.js' },
}
```

```jsx
<Image src="photos/beach.jpg" alt="Beach" width={800} height={600} />
```

## Caching and limits

| | |
|---|---|
| Largest source image | 50 megapixels (for example 8000 × 6250). Larger images fail with `422`. |
| Width and height | 1 to 2500 pixels |
| Quality | 20 to 100 |
| Caching | Resized images aren't stored. Every request is resized again, and browsers cache the result for the original file's `cacheControl` time. |

Resizing takes CPU time on your server. For a page that shows many images, keep sizes to a handful of fixed values (so browsers can cache them) rather than a different width for every layout.

Transformed responses don't support `download`, byte ranges or `ETag` revalidation. Use the regular file URL for those.

### Errors

| Status | Error | Why |
|---|---|---|
| 400 | `Object not found` | The bucket isn't public (on a `public` URL) |
| 404 | `Object not found` | No such file, or the user can't read it |
| 422 | `Unable to transform this image` | The file isn't an image imgproxy can read, or it's too large |
| 503 | `Image transformation service (keel-imgproxy) is not running` | The `keel-imgproxy` container is stopped |

## Behind the scenes

Transformations are done by [imgproxy](https://imgproxy.net), running as the `keel-imgproxy` container (it's in Studio's stack card). It reads files from the storage folder read-only and isn't published on any port: only `keel-storage` talks to it. When `IMGPROXY_KEY` and `IMGPROXY_SALT` are set (in a source checkout, `./keel init` generates them), Keel signs each request it sends to imgproxy.

If you don't need image transformations, you can stop `keel-imgproxy` to save memory. Everything else in Storage keeps working, and `/render/image/` URLs answer `503`.
