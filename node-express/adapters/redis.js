// Redis adapter — flat key-value store.
//
// "Tables" = key namespaces (everything before the first `:` colon — the de-facto
// Redis convention). When the user picks a "table", we dump all keys with that
// prefix. They can also pick `*` to mean everything.
//
// Dump format: text file of commands the Redis CLI / pipeline could consume.
//   # header comment
//   SELECT 0
//   SET k v
//   EXPIRE k 3600
//   HSET h f1 v1 f2 v2
//   SADD s "a" "b"
//   LPUSH l "x" "y" "z"
//   ZADD z 1.5 m1 2.5 m2
//   …
//
// Per-key dump uses DUMP/RESTORE under the hood when supported — but for
// portability across Redis versions/distros we re-emit as logical commands
// (TYPE-driven). Slower but predictable.

const fs = require('fs');
const readline = require('readline');

let Redis;
try { Redis = require('ioredis'); }
catch { Redis = null; }

function requireDriver() {
  if (!Redis) throw new Error('ioredis driver not installed. Run: npm install ioredis');
}

function buildClient(c) {
  requireDriver();
  return new Redis({
    host: c.host || '127.0.0.1',
    port: Number(c.port) || 6379,
    password: c.password || undefined,
    username: c.user || undefined,
    db: Number(c.database || 0),
    tls: (c.tls || c.ssl) ? {} : undefined,
    connectTimeout: 8000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
}

async function withClient(conn, fn) {
  const cli = buildClient(conn);
  await cli.connect();
  try { return await fn(cli); }
  finally { cli.disconnect(); }
}

function quoteArg(s) {
  // Redis CLI-compatible quoting: double-quote, escape `"` and `\`
  const str = String(s);
  if (/^[A-Za-z0-9_:\-./]+$/.test(str)) return str;       // safe bareword
  return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

async function testConnection(conn) {
  return withClient(conn, async (cli) => {
    const info = await cli.info('server');
    const ver = /redis_version:([^\r\n]+)/.exec(info)?.[1] || '?';
    // Redis has 16 logical DBs by default; treat them like "databases"
    const dbcount = parseInt(/maxmemory_policy:|databases:(\d+)/.exec(await cli.config('GET', 'databases').then((r) => `databases:${r[1]}`).catch(() => 'databases:16'))?.[1] || '16');
    const databases = [];
    for (let i = 0; i < Math.min(dbcount, 16); i++) databases.push(String(i));
    return { ok: true, version: 'Redis ' + ver, databases };
  });
}

// Group keys by namespace prefix (up to first `:`); fallback bucket "_root" for unprefixed.
async function listTables(conn) {
  return withClient(conn, async (cli) => {
    const buckets = new Map();
    let cursor = '0';
    do {
      const [next, batch] = await cli.scan(cursor, 'COUNT', 500);
      cursor = next;
      for (const k of batch) {
        const i = k.indexOf(':');
        const ns = i > 0 ? k.slice(0, i) + ':*' : '_root';
        buckets.set(ns, (buckets.get(ns) || 0) + 1);
      }
    } while (cursor !== '0');
    return [...buckets.entries()].map(([name, n]) => ({ name, rowEstimate: n }));
  });
}

async function dump(conn, options, outFilePath, onProgress) {
  return withClient(conn, async (cli) => {
    const dbIdx = Number(conn.database || 0);
    const stream = fs.createWriteStream(outFilePath, { encoding: 'utf8' });

    stream.write(`# DB Migrator dump (Redis db=${dbIdx})\n# Generated: ${new Date().toISOString()}\n# Adapter: redis\n`);
    stream.write(`SELECT ${dbIdx}\n\n`);

    const patterns = options.tables?.length
      ? options.tables.map((t) => t === '_root' ? '[^:]*' : t)   // _root means top-level keys w/o colon
      : ['*'];

    onProgress?.(`Dumping pattern(s): ${patterns.join(', ')}`);

    let total = 0;
    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const [next, keys] = await cli.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        for (const key of keys) {
          await dumpKey(cli, stream, key, onProgress);
          total++;
          if (total % 1000 === 0) onProgress?.(`  ${total} key(s)...`);
        }
      } while (cursor !== '0');
    }

    await new Promise((r) => stream.end(r));
    onProgress?.(`Done: ${total} key(s) dumped`);
    return { outFilePath };
  });
}

async function dumpKey(cli, stream, key, onProgress) {
  const type = await cli.type(key);
  const ttl = await cli.pttl(key);     // ms remaining; -1 = no ttl, -2 = no key
  const Q = quoteArg;

  switch (type) {
    case 'string': {
      const v = await cli.get(key);
      stream.write(`SET ${Q(key)} ${Q(v ?? '')}\n`);
      break;
    }
    case 'list': {
      const items = await cli.lrange(key, 0, -1);
      if (items.length) stream.write(`RPUSH ${Q(key)} ${items.map(Q).join(' ')}\n`);
      break;
    }
    case 'set': {
      const items = await cli.smembers(key);
      if (items.length) stream.write(`SADD ${Q(key)} ${items.map(Q).join(' ')}\n`);
      break;
    }
    case 'zset': {
      const flat = await cli.zrange(key, 0, -1, 'WITHSCORES');
      if (flat.length) {
        const pairs = [];
        for (let i = 0; i < flat.length; i += 2) pairs.push(flat[i + 1] + ' ' + Q(flat[i]));
        stream.write(`ZADD ${Q(key)} ${pairs.join(' ')}\n`);
      }
      break;
    }
    case 'hash': {
      const h = await cli.hgetall(key);
      const flat = Object.entries(h).flatMap(([f, v]) => [Q(f), Q(v)]);
      if (flat.length) stream.write(`HSET ${Q(key)} ${flat.join(' ')}\n`);
      break;
    }
    case 'none': return;
    default: {
      onProgress?.(`  skipped unsupported type "${type}" for key ${key}`);
      return;
    }
  }
  if (ttl > 0) stream.write(`PEXPIRE ${Q(key)} ${ttl}\n`);
}

async function restore(conn, dumpPath, onProgress) {
  return withClient(conn, async (cli) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(dumpPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let n = 0;
    for await (const line of rl) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const parts = splitCmd(t);
      if (!parts.length) continue;
      try {
        await cli.call(parts[0], ...parts.slice(1));
        n++;
        if (n % 500 === 0) onProgress?.(`  ${n} cmds...`);
      } catch (e) {
        onProgress?.(`  ${parts[0]} failed: ${e.message}`);
      }
    }
    onProgress?.(`Restore complete: ${n} commands run`);
    return { ok: true };
  });
}

// Tokenize a Redis-CLI-style line, respecting "..." quoting + \ escapes.
function splitCmd(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  let esc = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (esc) {
      if (ch === 'n') cur += '\n';
      else if (ch === 't') cur += '\t';
      else cur += ch;
      esc = false; continue;
    }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inQ = !inQ; continue; }
    if (!inQ && /\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseTableNamesFromDump(dumpPath) {
  const lines = fs.readFileSync(dumpPath, 'utf8').split('\n');
  const seen = new Set();
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#') || /^SELECT\b/i.test(t)) continue;
    const parts = splitCmd(t);
    if (parts.length < 2) continue;
    const cmd = parts[0].toUpperCase();
    if (!['SET', 'RPUSH', 'LPUSH', 'SADD', 'HSET', 'ZADD', 'PEXPIRE'].includes(cmd)) continue;
    const key = parts[1];
    const i = key.indexOf(':');
    seen.add(i > 0 ? key.slice(0, i) + ':*' : '_root');
  }
  return [...seen];
}

function filterDumpByTables(dumpText, wanted) {
  const want = new Set(wanted);
  const out = [];
  let kept = 0, skipped = 0;
  for (const line of dumpText.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || /^SELECT\b/i.test(t)) { out.push(line); continue; }
    const parts = splitCmd(t);
    if (parts.length < 2) { out.push(line); continue; }
    const key = parts[1];
    const i = key.indexOf(':');
    const ns = i > 0 ? key.slice(0, i) + ':*' : '_root';
    if (want.has(ns)) { out.push(line); kept++; }
    else skipped++;
  }
  return { sql: out.join('\n') + '\n', kept, skipped };
}

module.exports = {
  type: 'redis',
  testConnection,
  listTables,
  dump,
  restore,
  parseTableNamesFromDump,
  filterDumpByTables,
  // exposed for tests
  _internal: { quoteArg, splitCmd },
};
