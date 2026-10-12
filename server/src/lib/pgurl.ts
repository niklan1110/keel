/**
 * A project's connection string as Studio shows it, with "<password>" in
 * place of the password. When Postgres has TLS on, it asks for it with
 * sslmode=require: other machines can only connect over TLS, and drivers that
 * don't try TLS by themselves (node-postgres, for one) would fail without it.
 * keel-db's certificate is self-signed, so require (encrypt, don't verify) is
 * what works everywhere; see website/database/connecting-directly.md.
 */
export function postgresUrl(db: { user: string; host: string; port: number; database: string; tls: boolean }): string {
  const host = db.host.includes(':') ? `[${db.host}]` : db.host;
  const url = `postgresql://${encodeURIComponent(db.user)}:<password>@${host}:${db.port}/${encodeURIComponent(db.database)}`;
  return db.tls ? `${url}?sslmode=require` : url;
}
