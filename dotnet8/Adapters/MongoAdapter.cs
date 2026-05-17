using DbMigrator.Web.Models;
using MongoDB.Bson;
using MongoDB.Bson.IO;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;

namespace DbMigrator.Web.Adapters;

// MongoDB adapter — JSONL/EJSON dump format. See node-express/adapters/mongo.js
// for the canonical format spec. Both implementations write the same shape so
// dumps are cross-compatible between the Node and .NET versions.
public class MongoAdapter : IDatabaseAdapter
{
    public string Type => "mongo";

    private static readonly JsonWriterSettings EjsonCanonical = new()
    {
        OutputMode = JsonOutputMode.CanonicalExtendedJson,
        Indent = false,
    };

    private static string BuildUri(DbConnectionInfo c)
    {
        // Full URI pasted into Host field — use as-is
        if (!string.IsNullOrEmpty(c.Host)
            && (c.Host.StartsWith("mongodb://", StringComparison.OrdinalIgnoreCase)
             || c.Host.StartsWith("mongodb+srv://", StringComparison.OrdinalIgnoreCase)))
        {
            if (!string.IsNullOrEmpty(c.User) && !c.Host.Contains('@'))
            {
                var ui = $"{Uri.EscapeDataString(c.User)}:{Uri.EscapeDataString(c.Password ?? "")}@";
                return System.Text.RegularExpressions.Regex.Replace(
                    c.Host, "^(mongodb(\\+srv)?://)", "$1" + ui,
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            }
            return c.Host;
        }
        var userInfo = !string.IsNullOrEmpty(c.User)
            ? $"{Uri.EscapeDataString(c.User)}:{Uri.EscapeDataString(c.Password ?? "")}@"
            : "";
        var port = c.Port == 0 ? 27017 : c.Port;
        var qs = c.Ssl ? "?tls=true" : "";
        return $"mongodb://{userInfo}{c.Host}:{port}/{qs}";
    }

    private static MongoClient Client(DbConnectionInfo conn)
    {
        var settings = MongoClientSettings.FromConnectionString(BuildUri(conn));
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(8);
        return new MongoClient(settings);
    }

    public async Task<TestResult> TestConnectionAsync(DbConnectionInfo conn)
    {
        try
        {
            var client = Client(conn);
            var build = await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("buildInfo", 1));
            var version = build.GetValue("version", "?").ToString();
            var dbs = new List<string>();
            try
            {
                using var cur = await client.ListDatabasesAsync();
                while (await cur.MoveNextAsync())
                    foreach (var d in cur.Current)
                    {
                        var name = d["name"].AsString;
                        if (name is "admin" or "local" or "config") continue;
                        dbs.Add(name);
                    }
            }
            catch
            {
                if (!string.IsNullOrEmpty(conn.Database)) dbs.Add(conn.Database);
            }
            return new TestResult { Ok = true, Version = $"MongoDB {version}", Databases = dbs };
        }
        catch (Exception ex) { return new TestResult { Ok = false, Error = ex.Message }; }
    }

    public async Task<List<TableInfo>> ListTablesAsync(DbConnectionInfo conn)
    {
        if (string.IsNullOrEmpty(conn.Database)) throw new Exception("database name required");
        var db = Client(conn).GetDatabase(conn.Database);
        var cols = (await (await db.ListCollectionsAsync()).ToListAsync())
            .Where(c => !c.Contains("type") || c["type"].AsString != "view")
            .ToList();
        var result = new List<TableInfo>();
        foreach (var c in cols)
        {
            var name = c["name"].AsString;
            long? est = null;
            try
            {
                var stats = await db.RunCommandAsync<BsonDocument>(new BsonDocument("collStats", name));
                est = stats.GetValue("count", BsonInt64.Create(0)).ToInt64();
            }
            catch { }
            result.Add(new TableInfo { Name = name, RowEstimate = est });
        }
        return result;
    }

    public async Task DumpAsync(DbConnectionInfo conn, ExportOptions options, string outFilePath,
                                Action<string>? onProgress, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(conn.Database)) throw new Exception("database name required");
        var db = Client(conn).GetDatabase(conn.Database);

        var all = (await (await db.ListCollectionsAsync(cancellationToken: ct)).ToListAsync(ct))
            .Where(c => !c.Contains("type") || c["type"].AsString != "view")
            .Select(c => c["name"].AsString)
            .ToList();
        var wanted = options.Tables.Count > 0 ? all.Where(options.Tables.Contains).ToList() : all;
        onProgress?.Invoke($"Dumping {wanted.Count} collection(s) from {conn.Database}");

        await using var stream = new StreamWriter(outFilePath, false, System.Text.Encoding.UTF8);

        void WriteLine(BsonDocument d) => stream.WriteLine(d.ToJson(EjsonCanonical));

        WriteLine(new BsonDocument
        {
            { "op", "header" },
            { "adapter", "mongo" },
            { "db", conn.Database },
            { "generated", DateTime.UtcNow.ToString("O") },
            { "collections", new BsonArray(wanted) },
        });

        foreach (var name in wanted)
        {
            ct.ThrowIfCancellationRequested();
            onProgress?.Invoke($"> {name}");

            var coll = db.GetCollection<BsonDocument>(name);
            var indexes = await (await coll.Indexes.ListAsync(ct)).ToListAsync(ct);
            var idxArr = new BsonArray(indexes.Where(i => i["name"].AsString != "_id_"));

            WriteLine(new BsonDocument
            {
                { "op", "collection" },
                { "name", name },
                { "options", new BsonDocument() },   // collection options not easily round-tripped; skip for MVP
                { "indexes", idxArr },
            });

            if (options.NoData) continue;

            using var cur = await coll.FindAsync(new BsonDocument(), new FindOptions<BsonDocument> { BatchSize = 500 }, ct);
            long n = 0;
            while (await cur.MoveNextAsync(ct))
            {
                foreach (var doc in cur.Current)
                {
                    WriteLine(new BsonDocument { { "op", "insert" }, { "coll", name }, { "doc", doc } });
                    n++;
                    if (n % 5000 == 0) onProgress?.Invoke($"  {name}: {n} docs...");
                }
            }
            onProgress?.Invoke($"  {name}: {n} docs done");
        }
        onProgress?.Invoke("Done");
    }

    public async Task RestoreAsync(DbConnectionInfo conn, string sqlFilePath,
                                   Action<string>? onProgress, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(conn.Database)) throw new Exception("database name required");
        var db = Client(conn).GetDatabase(conn.Database);

        const int BATCH = 1000;
        var buf = new List<BsonDocument>();
        string? bufColl = null;
        long totalInserts = 0;
        int createdColls = 0;

        async Task Flush()
        {
            if (buf.Count == 0 || bufColl == null) return;
            try { await db.GetCollection<BsonDocument>(bufColl).InsertManyAsync(buf, new InsertManyOptions { IsOrdered = false }, ct); }
            catch (MongoBulkWriteException) { onProgress?.Invoke($"  {bufColl}: some docs duplicate _id, skipped"); }
            totalInserts += buf.Count;
            buf.Clear(); bufColl = null;
        }

        using var reader = new StreamReader(sqlFilePath);
        string? line;
        while ((line = await reader.ReadLineAsync(ct)) != null)
        {
            var t = line.Trim();
            if (t.Length == 0) continue;
            BsonDocument evt;
            try { evt = BsonDocument.Parse(t); }
            catch (Exception e) { throw new Exception($"Bad JSON in dump line: {e.Message}"); }

            var op = evt.GetValue("op", "").AsString;
            if (op == "header")
            {
                var colCount = evt.GetValue("collections", new BsonArray()).AsBsonArray.Count;
                onProgress?.Invoke($"Restoring {colCount} collection(s) into {conn.Database}");
                continue;
            }
            if (op == "collection")
            {
                await Flush();
                var name = evt["name"].AsString;
                try { await db.DropCollectionAsync(name, ct); } catch { }
                try
                {
                    await db.CreateCollectionAsync(name, cancellationToken: ct);
                    createdColls++;
                }
                catch (Exception e) { onProgress?.Invoke($"  {name}: createCollection error (continuing): {e.Message}"); }

                if (evt.Contains("indexes") && evt["indexes"].IsBsonArray)
                {
                    var coll = db.GetCollection<BsonDocument>(name);
                    foreach (var idxDoc in evt["indexes"].AsBsonArray)
                    {
                        if (!idxDoc.IsBsonDocument) continue;
                        var d = idxDoc.AsBsonDocument;
                        try
                        {
                            var keys = (BsonDocument)d["key"];
                            var opts = new CreateIndexOptions();
                            if (d.Contains("name")) opts.Name = d["name"].AsString;
                            if (d.GetValue("unique", false).ToBoolean()) opts.Unique = true;
                            if (d.GetValue("sparse", false).ToBoolean()) opts.Sparse = true;
                            await coll.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(keys, opts), cancellationToken: ct);
                        }
                        catch (Exception e) { onProgress?.Invoke($"  {name}: index error: {e.Message}"); }
                    }
                }
                onProgress?.Invoke($"> {name} (re-created)");
                continue;
            }
            if (op == "insert")
            {
                var coll = evt["coll"].AsString;
                if (bufColl != null && bufColl != coll) await Flush();
                bufColl = coll;
                buf.Add(evt["doc"].AsBsonDocument);
                if (buf.Count >= BATCH) await Flush();
            }
        }
        await Flush();
        onProgress?.Invoke($"Restore complete: {createdColls} collection(s), {totalInserts} docs");
    }

    public List<string> ParseTableNamesFromDump(string sqlFilePath)
    {
        var names = new HashSet<string>();
        foreach (var line in File.ReadAllLines(sqlFilePath))
        {
            var t = line.Trim();
            if (t.Length == 0) continue;
            try
            {
                var d = BsonDocument.Parse(t);
                var op = d.GetValue("op", "").AsString;
                if (op == "collection" && d.Contains("name")) names.Add(d["name"].AsString);
                else if (op == "insert" && d.Contains("coll")) names.Add(d["coll"].AsString);
            }
            catch { }
        }
        return names.ToList();
    }

    public FilterResult? FilterDumpByTables(string dumpText, List<string> wanted)
    {
        var want = new HashSet<string>(wanted);
        var lines = new List<string>();
        int kept = 0, skipped = 0;
        foreach (var raw in dumpText.Split('\n'))
        {
            var t = raw.Trim();
            if (t.Length == 0) continue;
            BsonDocument d;
            try { d = BsonDocument.Parse(t); }
            catch { continue; }
            var op = d.GetValue("op", "").AsString;
            if (op == "header")
            {
                var filteredCols = new BsonArray();
                if (d.Contains("collections") && d["collections"].IsBsonArray)
                    foreach (var c in d["collections"].AsBsonArray)
                        if (c.IsString && want.Contains(c.AsString)) filteredCols.Add(c);
                d["collections"] = filteredCols;
                lines.Add(d.ToJson(EjsonCanonical));
                continue;
            }
            var coll = op == "collection" ? d.GetValue("name", "").AsString
                     : op == "insert" ? d.GetValue("coll", "").AsString
                     : "";
            if (coll != "" && want.Contains(coll)) { lines.Add(raw); kept++; }
            else skipped++;
        }
        return new FilterResult(string.Join("\n", lines) + "\n", kept, skipped);
    }
}
