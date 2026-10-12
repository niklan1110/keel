import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresUrl } from './pgurl.js';

const db = { user: 'my_app_owner', host: '192.168.1.20', port: 5432, database: 'my_app' };

test('postgresUrl asks for TLS when Postgres has it on', () => {
  assert.equal(postgresUrl({ ...db, tls: true }), 'postgresql://my_app_owner:<password>@192.168.1.20:5432/my_app?sslmode=require');
});

test('postgresUrl leaves sslmode out when Postgres runs without TLS', () => {
  assert.equal(postgresUrl({ ...db, tls: false }), 'postgresql://my_app_owner:<password>@192.168.1.20:5432/my_app');
});

test('postgresUrl puts an IPv6 address in brackets', () => {
  assert.equal(postgresUrl({ ...db, host: 'fd00::20', tls: true }), 'postgresql://my_app_owner:<password>@[fd00::20]:5432/my_app?sslmode=require');
});

test('postgresUrl percent-encodes the user and database', () => {
  assert.equal(postgresUrl({ ...db, user: 'a@b', database: 'x/y', tls: false }), 'postgresql://a%40b:<password>@192.168.1.20:5432/x%2Fy');
});
