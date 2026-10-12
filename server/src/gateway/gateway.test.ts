import assert from 'node:assert/strict';
import test from 'node:test';
import { routeShape, withoutApiKey } from './index.js';

test('withoutApiKey drops only the apikey parameter and keeps the rest as sent', () => {
  assert.equal(withoutApiKey(''), '');
  assert.equal(withoutApiKey('?apikey=abc'), '');
  assert.equal(withoutApiKey('?select=*&apikey=abc'), '?select=*');
  assert.equal(withoutApiKey('?apikey=abc&title=ilike.*a%20b*&order=id.desc'), '?title=ilike.*a%20b*&order=id.desc');
  assert.equal(withoutApiKey('?apikeys=eq.1&apikey'), '?apikeys=eq.1');
  assert.equal(withoutApiKey('?or=(a.eq.1,b.eq.2)'), '?or=(a.eq.1,b.eq.2)');
});

test('the request log shows the route, not object names or IDs', () => {
  const id = '4b6f1c2e-8d3a-4f5b-9c7d-0e1f2a3b4c5d';
  assert.equal(routeShape(`/my-app/storage/v1/object/avatars/${id}/me.png`), '/my-app/storage/v1/object/avatars/*');
  assert.equal(routeShape(`/my-app/storage/v1/object/public/avatars/${id}/holiday.jpg?download`), '/my-app/storage/v1/object/public/avatars/*');
  assert.equal(routeShape(`/my-app/storage/v1/object/upload/sign/docs/${id}/cv.pdf`), '/my-app/storage/v1/object/upload/sign/docs/*');
  assert.equal(routeShape('/my-app/storage/v1/render/image/public/avatars/a/b.png?width=10'), '/my-app/storage/v1/render/image/public/avatars/*');
  assert.equal(routeShape('/my-app/storage/v1/object/list/avatars'), '/my-app/storage/v1/object/list/avatars');
  assert.equal(routeShape('/my-app/storage/v1/upload/resumable/c29tZS11cGxvYWQ'), '/my-app/storage/v1/upload/resumable/:id');
  assert.equal(routeShape('/my-app/storage/v1/bucket'), '/my-app/storage/v1/bucket');
  assert.equal(routeShape(`/my-app/auth/v1/admin/users/${id}`), '/my-app/auth/v1/admin/users/:id');
  assert.equal(routeShape('/my-app/auth/v1/token?grant_type=password'), '/my-app/auth/v1/token');
  assert.equal(routeShape('/my-app/rest/v1/todos?select=*&email=eq.ada@example.com'), '/my-app/rest/v1/todos');
  assert.equal(routeShape(`/my-app/functions/v1/hello/users/${id}`), '/my-app/functions/v1/hello/*');
  assert.equal(routeShape('/'), '/');
  assert.equal(routeShape('/favicon.ico'), '/*');
  assert.equal(routeShape('/wp-admin/setup.php'), '/wp-admin/*');
});

test('a bucket named like a route word does not put the next segment in the log', () => {
  const id = '4b6f1c2e-8d3a-4f5b-9c7d-0e1f2a3b4c5d';
  // Buckets called public, image or info, read and written the plain way.
  assert.equal(routeShape(`/my-app/storage/v1/object/public/${id}/me.png`, 'POST'), '/my-app/storage/v1/object/public/*');
  assert.equal(routeShape(`/my-app/storage/v1/object/info/${id}/me.png`, 'DELETE'), '/my-app/storage/v1/object/info/*');
  assert.equal(routeShape(`/my-app/storage/v1/object/image/${id}/me.png`, 'GET'), '/my-app/storage/v1/object/image/*');
  assert.equal(routeShape(`/my-app/storage/v1/object/public/image/${id}/me.png`, 'GET'), '/my-app/storage/v1/object/public/image/*');
  // Read as the info route of the bucket named by the next segment; an ID there is still masked.
  assert.equal(routeShape(`/my-app/storage/v1/object/info/public/${id}/me.png`, 'GET'), '/my-app/storage/v1/object/info/public/:id/*');
  assert.equal(routeShape(`/my-app/storage/v1/object/sign/info/${id}/me.png`, 'POST'), '/my-app/storage/v1/object/sign/info/*');
  assert.equal(routeShape('/my-app/storage/v1/object/move', 'POST'), '/my-app/storage/v1/object/move');
  assert.equal(routeShape(`/my-app/storage/v1/render/image/authenticated/image/${id}/a.png`, 'GET'), '/my-app/storage/v1/render/image/authenticated/image/*');
  assert.equal(routeShape(`/my-app/storage/v1/bucket/avatars/empty`, 'POST'), '/my-app/storage/v1/bucket/avatars/*');
  assert.equal(routeShape(`/my-app/storage/v1/${id}/x`, 'GET'), '/my-app/storage/v1/*');
});
