const KEYWORDS = new Set(
  `select from where join left right inner outer full cross on and or not as group by order having limit offset
  insert into values update set delete returning create table view index unique primary key foreign references
  alter add drop column constraint default null is in exists between like ilike case when then else end distinct
  union all intersect except with recursive asc desc nulls first last true false begin commit rollback grant revoke
  to policy using check enable disable row level security function returns language trigger execute procedure
  schema extension if replace cascade restrict sequence type enum materialized refresh analyze explain vacuum
  for each before after instead of lateral over partition window filter array cast coalesce count sum avg min max
  publication truncate identity generated always stored do declare plpgsql sql security definer invoker stable immutable volatile
  serial bigserial text int int2 int4 int8 integer bigint smallint boolean bool uuid jsonb json timestamptz timestamp date time numeric real double precision varchar char bytea
  authenticated anon service_role public`
    .split(/\s+/)
    .filter(Boolean),
);

export type Token = { t: string; c: string };

/** A small SQL tokenizer for syntax highlighting (not a parser). */
export function tokenize(src: string): Token[][] {
  const lines: Token[][] = [[]];
  const push = (t: string, c: string) => {
    const parts = t.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ t: p, c });
    });
  };
  const re = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\$[a-zA-Z_]*\$[\s\S]*?(?:\$[a-zA-Z_]*\$|$))|(\b\d+(?:\.\d+)?\b)|([a-zA-Z_][a-zA-Z0-9_]*)(?=\s*\()|([a-zA-Z_][a-zA-Z0-9_]*)|(\s+)|([(),.;=<>!+\-*/:%|&[\]{}^~@#?]+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const [tok, com, str, ident, dollar, num, fn, word, ws, punc] = m;
    if (com) push(tok, 'tk-com');
    else if (str || dollar) push(tok, 'tk-str');
    else if (ident) push(tok, '');
    else if (num) push(tok, 'tk-num');
    else if (fn) push(tok, KEYWORDS.has(fn.toLowerCase()) ? 'tk-kw' : 'tk-fn');
    else if (word) push(tok, KEYWORDS.has(word.toLowerCase()) ? 'tk-kw' : '');
    else if (ws) push(tok, '');
    else if (punc) push(tok, 'tk-punc');
    else push(tok, '');
  }
  return lines;
}

/** Returns the statement under the cursor, for "run selection/current statement". */
export function statementAt(src: string, cursor: number): string {
  let start = src.lastIndexOf(';', cursor - 1) + 1;
  let end = src.indexOf(';', cursor);
  if (end < 0) end = src.length;
  return src.slice(start, end + 1).trim();
}
