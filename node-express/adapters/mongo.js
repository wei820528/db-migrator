// MongoDB adapter — NoSQL.
//
// Dump format: JSONL, one event per line. EJSON canonical preserves BSON
// types (ObjectId, Date, Binary, NumberLong, Decimal128, …).
//   {"op":"header","adapter":"mongo","db":"<name>","generated":"...","collections":[...]}
//   {"op":"collection","name":"users","options":{...},"indexes":[{key,name,unique,...}]}
//   {"op":"insert","coll":"users","doc":{...}}     // one per line
//   …
//
// "Tables" = collections. Database selection works (server returns admin DB list).

const fs = require('fs');
const readline = require('readline');

let MongoClient, EJSON;
try {
  ({ MongoClient } = require('mongodb'));
  ({ EJSON } = require('bson'));     // bson is a peer dep of mongodb
} catch (e) {
  // Defer the error to first use; allows the module to load for tests / listing.
  MongoClient = null; EJSON = null;
}

function requireDriver() {
  if (!MongoClient) throw new Error('mongodb driver not installed. Run: npm install mongodb');
}

// Build a connection URI from our flat conn object.
// Supports:
//   - c.uri directly, OR
//   - c.host already looking like a full URI ("mongodb://..." / "mongodb+srv://...") — used as-is
//   - { host, port, user, password, database, authSource, tls, srv } — assembled into mongodb://
function buildUri(c) {
  if (c.uri) return c.uri;
  if (typeof c.host === 'string' && /^mongodb(\+srv)?:\/\//i.test(c.host)) {
    // User pasted a full Atlas/MongoDB URI into the host field
    if (c.user && !c.host.includes('@')) {
      const userInfo = `${encodeURIComponent(c.user)}:${encodeURIComponent(c.password || '')}@`;
      return c.host.replace(/^(mongodb(\+srv)?:\/\/)/i, `$1${userInfo}`);
    }
    return c.host;
  }
  const userInfo = c.user ? `${encodeURIComponent(c.user)}:${encodeURIComponent(c.password || '')}@` : '';
  const proto = c.srv ? 'mongodb+srv' : 'mongodb';
  const host = c.srv ? c.host : `${c.host}:${Number(c.port) || 27017}`;
  const params = [];
  if (c.authSource) params.push(`authSource=${encodeURIComponent(c.authSource)}`);
  if (c.tls || c.ssl) params.push('tls=true');
  const query = params.length ? `?${params.join('&')}` : '';
  return `${proto}://${userInfo}${host}/${query}`;
}

async function withClient(conn, fn) {
  requireDriver();
  const client = new MongoClient(buildUri(conn), { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try { return await fn(client); }
  finally { await client.close(); }
}

async function testConnection(conn) {
  return withClient(conn, async (client) => {
    const admin = client.db().admin();
    const info = await admin.serverInfo().catch(() => ({ version: '?' }));
    let databases = [];
    try {
      const list = await admin.listDatabases();
      databases = list.databases.map((d) => d.name).filter((n) => !['admin', 'local', 'config'].includes(n));
    } catch {
      // user may not have admin rights — fall back to whatever's in `conn.database`
      if (conn.database) databases = [conn.database];
    }
    return { ok: true, version: 'MongoDB ' + (info.version || '?'), databases };
  });
}

async function listTables(conn) {
  return withClient(conn, async (client) => {
    if (!conn.database) throw new Error('database name required');
    const db = client.db(conn.database);
    const cols = await db.listCollections({}, { nameOnly: false }).toArray();
    // Cheap row estimate via collStats — best effort
    const out = [];
    for (const c of cols) {
      if (c.type === 'view') continue;
      let est = null;
      try { est = (await db.command({ collStats: c.name })).count; } catch {}
      out.push({ name: c.name, rowEstimate: est });
    }
    return out;
  });
}

async function dump(conn, options, outFilePath, onProgress) {
  return withClient(conn, async (client) => {
    if (!conn.database) throw new Error('database name required');
    const db = client.db(conn.database);

    const all = (await db.listCollections({}, { nameOnly: false }).toArray()).filter((c) => c.type !== 'view');
    const wanted = options.tables?.length
      ? all.filter((c) => options.tables.includes(c.name))
      : all;
    onProgress?.(`Dumping ${wanted.length} collection(s) from ${conn.database}`);

    const stream = fs.createWriteStream(outFilePath, { encoding: 'utf8' });
    const writeLine = (obj) => stream.write(EJSON.stringify(obj, { relaxed: false }) + '\n');

    writeLine({
      op: 'header',
      adapter: 'mongo',
      db: conn.database,
      generated: new Date().toISOString(),
      collections: wanted.map((c) => c.name),
    });

    for (const coll of wanted) {
      onProgress?.(`> ${coll.name}`);

      // Schema: options + indexes
      const indexes = await db.collection(coll.name).indexes().catch(() => []);
      writeLine({
        op: 'collection',
        name: coll.name,
        options: coll.options || {},
        indexes: indexes.filter((i) => i.name !== '_id_'),  // _id_ is auto-created
      });

      if (options.noData) continue;

      // Stream documents
      const cur = db.collection(coll.name).find({}, { batchSize: 500 });
      let n = 0;
      for await (const doc of cur) {
        writeLine({ op: 'insert', coll: coll.name, doc });
        n++;
        if (n % 5000 === 0) onProgress?.(`  ${coll.name}: ${n} docs...`);
      }
      onProgress?.(`  ${coll.name}: ${n} docs done`);
    }

    await new Promise((r) => stream.end(r));
    onProgress?.('Done');
    return { outFilePath };
  });
}

async function restore(conn, dumpPath, onProgress) {
  return withClient(conn, async (client) => {
    if (!conn.database) throw new Error('database name required');
    const db = client.db(conn.database);

    const rl = readline.createInterface({
      input: fs.createReadStream(dumpPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    const BATCH = 1000;
    let buf = [];
    let bufColl = null;
    let totalInserts = 0;
    let createdColls = 0;

    async function flush() {
      if (!buf.length) return;
      await db.collection(bufColl).insertMany(buf, { ordered: false }).catch((e) => {
        // duplicate key on _id is expected if user re-imports — soft warn
        if (e.code !== 11000) throw e;
        onProgress?.(`  ${bufColl}: some docs duplicate _id, skipped`);
      });
      totalInserts += buf.length;
      buf = []; bufColl = null;
    }

    for await (const line of rl) {
      const trim = line.trim();
      if (!trim) continue;
      let evt;
      try { evt = EJSON.parse(trim, { relaxed: false }); }
      catch (e) { throw new Error(`Bad JSON in dump line: ${e.message}`); }

      if (evt.op === 'header') {
        onProgress?.(`Restoring ${evt.collections?.length || 0} collection(s) into ${conn.database}`);
        continue;
      }
      if (evt.op === 'collection') {
        await flush();
        try { await db.collection(evt.name).drop(); } catch {}
        try {
          await db.createCollection(evt.name, evt.options || {});
          createdColls++;
        } catch (e) {
          onProgress?.(`  ${evt.name}: createCollection error (continuing): ${e.message}`);
        }
        if (Array.isArray(evt.indexes) && evt.indexes.length) {
          try { await db.collection(evt.name).createIndexes(evt.indexes); }
          catch (e) { onProgress?.(`  ${evt.name}: index error: ${e.message}`); }
        }
        onProgress?.(`> ${evt.name} (re-created)`);
        continue;
      }
      if (evt.op === 'insert') {
        if (bufColl && bufColl !== evt.coll) await flush();
        bufColl = evt.coll;
        buf.push(evt.doc);
        if (buf.length >= BATCH) await flush();
      }
    }
    await flush();
    onProgress?.(`Restore complete: ${createdColls} collection(s), ${totalInserts} docs`);
    return { ok: true };
  });
}

// NoSQL-specific: parse collection names from our JSONL dump
function parseTableNamesFromDump(dumpPath) {
  const text = fs.readFileSync(dumpPath, 'utf8');
  const names = new Set();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e.op === 'collection' && e.name) names.add(e.name);
      else if (e.op === 'insert' && e.coll) names.add(e.coll);
    } catch {}
  }
  return [...names];
}

// NoSQL-specific filter — keeps only `collection` + `insert` events whose collection
// is in the wanted set. `header` is always kept (re-written with filtered list).
function filterDumpByTables(dumpText, wanted) {
  const want = new Set(wanted);
  const out = [];
  let kept = 0, skipped = 0;
  for (const line of dumpText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e; try { e = JSON.parse(t); } catch { continue; }
    if (e.op === 'header') {
      out.push(JSON.stringify({ ...e, collections: (e.collections || []).filter((c) => want.has(c)) }));
      continue;
    }
    const coll = e.op === 'collection' ? e.name : e.op === 'insert' ? e.coll : null;
    if (coll && want.has(coll)) { out.push(line); kept++; }
    else skipped++;
  }
  return { sql: out.join('\n') + '\n', kept, skipped };
}

module.exports = {
  type: 'mongo',
  testConnection,
  listTables,
  dump,
  restore,
  parseTableNamesFromDump,
  filterDumpByTables,
};
