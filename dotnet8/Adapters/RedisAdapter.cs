using System.Text;
using System.Text.RegularExpressions;
using DbMigrator.Web.Models;
using StackExchange.Redis;

namespace DbMigrator.Web.Adapters;

// Redis adapter — mirrors node-express/adapters/redis.js exactly so dumps are
// cross-compatible. "Tables" = key namespaces (prefix up to first ':').
public class RedisAdapter : IDatabaseAdapter
{
    public string Type => "redis";

    private static ConnectionMultiplexer Connect(DbConnectionInfo c)
    {
        var opts = new ConfigurationOptions
        {
            EndPoints = { { c.Host ?? "127.0.0.1", c.Port == 0 ? 6379 : c.Port } },
            Password = string.IsNullOrEmpty(c.Password) ? null : c.Password,
            User = string.IsNullOrEmpty(c.User) ? null : c.User,
            DefaultDatabase = int.TryParse(c.Database, out var d) ? d : 0,
            Ssl = c.Ssl,
            ConnectTimeout = 8000,
            AbortOnConnectFail = false,
        };
        return ConnectionMultiplexer.Connect(opts);
    }

    public async Task<TestResult> TestConnectionAsync(DbConnectionInfo conn)
    {
        try
        {
            using var mux = Connect(conn);
            var server = mux.GetServer(mux.GetEndPoints().First());
            var info = await server.InfoAsync("server");
            var version = "?";
            foreach (var g in info)
                foreach (var kv in g)
                    if (kv.Key == "redis_version") version = kv.Value;
            // Redis has 0..15 logical DBs by default — expose them all as selectable "databases"
            var dbs = Enumerable.Range(0, 16).Select(i => i.ToString()).ToList();
            return new TestResult { Ok = true, Version = $"Redis {version}", Databases = dbs };
        }
        catch (Exception ex) { return new TestResult { Ok = false, Error = ex.Message }; }
    }

    public async Task<List<TableInfo>> ListTablesAsync(DbConnectionInfo conn)
    {
        using var mux = Connect(conn);
        var dbIdx = int.TryParse(conn.Database, out var d) ? d : 0;
        var server = mux.GetServer(mux.GetEndPoints().First());
        var buckets = new Dictionary<string, long>();
        await foreach (var key in server.KeysAsync(database: dbIdx, pageSize: 500))
        {
            var k = (string)key!;
            var i = k.IndexOf(':');
            var ns = i > 0 ? k[..i] + ":*" : "_root";
            buckets[ns] = buckets.GetValueOrDefault(ns) + 1;
        }
        return buckets.Select(kv => new TableInfo { Name = kv.Key, RowEstimate = kv.Value }).ToList();
    }

    public async Task DumpAsync(DbConnectionInfo conn, ExportOptions options, string outFilePath,
                                Action<string>? onProgress, CancellationToken ct)
    {
        using var mux = Connect(conn);
        var dbIdx = int.TryParse(conn.Database, out var d) ? d : 0;
        var db = mux.GetDatabase(dbIdx);
        var server = mux.GetServer(mux.GetEndPoints().First());

        await using var stream = new StreamWriter(outFilePath, false, Encoding.UTF8);
        await stream.WriteLineAsync($"# DB Migrator dump (Redis db={dbIdx})");
        await stream.WriteLineAsync($"# Generated: {DateTime.UtcNow:O}");
        await stream.WriteLineAsync("# Adapter: redis");
        await stream.WriteLineAsync($"SELECT {dbIdx}");
        await stream.WriteLineAsync();

        var patterns = options.Tables.Count > 0
            ? options.Tables.Select(t => t == "_root" ? "[^:]*" : t).ToList()
            : new List<string> { "*" };

        onProgress?.Invoke($"Dumping pattern(s): {string.Join(", ", patterns)}");

        long total = 0;
        foreach (var pat in patterns)
        {
            ct.ThrowIfCancellationRequested();
            await foreach (var key in server.KeysAsync(database: dbIdx, pattern: pat, pageSize: 500))
            {
                await DumpKey(db, stream, (string)key!, onProgress);
                total++;
                if (total % 1000 == 0) onProgress?.Invoke($"  {total} key(s)...");
            }
        }
        onProgress?.Invoke($"Done: {total} key(s) dumped");
    }

    private static async Task DumpKey(IDatabase db, StreamWriter stream, string key, Action<string>? onProgress)
    {
        var type = await db.KeyTypeAsync(key);
        var ttl = await db.KeyTimeToLiveAsync(key);

        switch (type)
        {
            case RedisType.String:
                var v = await db.StringGetAsync(key);
                await stream.WriteLineAsync($"SET {Q(key)} {Q(v.ToString())}");
                break;
            case RedisType.List:
                var items = await db.ListRangeAsync(key);
                if (items.Length > 0)
                    await stream.WriteLineAsync($"RPUSH {Q(key)} {string.Join(" ", items.Select(x => Q(x.ToString())))}");
                break;
            case RedisType.Set:
                var members = await db.SetMembersAsync(key);
                if (members.Length > 0)
                    await stream.WriteLineAsync($"SADD {Q(key)} {string.Join(" ", members.Select(x => Q(x.ToString())))}");
                break;
            case RedisType.SortedSet:
                var entries = await db.SortedSetRangeByRankWithScoresAsync(key);
                if (entries.Length > 0)
                {
                    var parts = entries.Select(e => $"{e.Score.ToString(System.Globalization.CultureInfo.InvariantCulture)} {Q(e.Element.ToString())}");
                    await stream.WriteLineAsync($"ZADD {Q(key)} {string.Join(" ", parts)}");
                }
                break;
            case RedisType.Hash:
                var h = await db.HashGetAllAsync(key);
                if (h.Length > 0)
                {
                    var flat = h.SelectMany(e => new[] { Q(e.Name.ToString()), Q(e.Value.ToString()) });
                    await stream.WriteLineAsync($"HSET {Q(key)} {string.Join(" ", flat)}");
                }
                break;
            case RedisType.None: return;
            default:
                onProgress?.Invoke($"  skipped unsupported type \"{type}\" for key {key}");
                return;
        }
        if (ttl.HasValue) await stream.WriteLineAsync($"PEXPIRE {Q(key)} {(long)ttl.Value.TotalMilliseconds}");
    }

    public async Task RestoreAsync(DbConnectionInfo conn, string sqlFilePath,
                                   Action<string>? onProgress, CancellationToken ct)
    {
        using var mux = Connect(conn);
        var dbIdx = int.TryParse(conn.Database, out var d) ? d : 0;
        var db = mux.GetDatabase(dbIdx);

        using var reader = new StreamReader(sqlFilePath);
        string? line;
        long n = 0;
        while ((line = await reader.ReadLineAsync(ct)) != null)
        {
            var t = line.Trim();
            if (t.Length == 0 || t.StartsWith('#')) continue;
            var parts = SplitCmd(t);
            if (parts.Count == 0) continue;
            try
            {
                var cmd = parts[0].ToUpperInvariant();
                var args = parts.Skip(1).Select(s => (RedisValue)s).ToArray();
                await db.ExecuteAsync(cmd, args.Cast<object>().ToArray());
                n++;
                if (n % 500 == 0) onProgress?.Invoke($"  {n} cmds...");
            }
            catch (Exception e) { onProgress?.Invoke($"  {parts[0]} failed: {e.Message}"); }
        }
        onProgress?.Invoke($"Restore complete: {n} commands run");
    }

    public List<string> ParseTableNamesFromDump(string sqlFilePath)
    {
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            { "SET", "RPUSH", "LPUSH", "SADD", "HSET", "ZADD", "PEXPIRE" };
        var seen = new HashSet<string>();
        foreach (var raw in File.ReadAllLines(sqlFilePath))
        {
            var t = raw.Trim();
            if (t.Length == 0 || t.StartsWith('#') || Regex.IsMatch(t, "^SELECT\\b", RegexOptions.IgnoreCase)) continue;
            var parts = SplitCmd(t);
            if (parts.Count < 2 || !allowed.Contains(parts[0])) continue;
            var key = parts[1];
            var i = key.IndexOf(':');
            seen.Add(i > 0 ? key[..i] + ":*" : "_root");
        }
        return seen.ToList();
    }

    public FilterResult? FilterDumpByTables(string dumpText, List<string> wanted)
    {
        var want = new HashSet<string>(wanted);
        var lines = new List<string>();
        int kept = 0, skipped = 0;
        foreach (var raw in dumpText.Split('\n'))
        {
            var t = raw.Trim();
            if (t.Length == 0 || t.StartsWith('#') || Regex.IsMatch(t, "^SELECT\\b", RegexOptions.IgnoreCase))
            { lines.Add(raw); continue; }
            var parts = SplitCmd(t);
            if (parts.Count < 2) { lines.Add(raw); continue; }
            var key = parts[1];
            var i = key.IndexOf(':');
            var ns = i > 0 ? key[..i] + ":*" : "_root";
            if (want.Contains(ns)) { lines.Add(raw); kept++; }
            else skipped++;
        }
        return new FilterResult(string.Join("\n", lines) + "\n", kept, skipped);
    }

    // ----- helpers (same rules as the Node version) -----

    public static string Q(string s)
    {
        if (Regex.IsMatch(s, @"^[A-Za-z0-9_:\-./]+$")) return s;
        return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n") + "\"";
    }

    public static List<string> SplitCmd(string line)
    {
        var outList = new List<string>();
        var cur = new StringBuilder();
        bool inQ = false, esc = false;
        foreach (var ch in line)
        {
            if (esc)
            {
                if (ch == 'n') cur.Append('\n');
                else if (ch == 't') cur.Append('\t');
                else cur.Append(ch);
                esc = false; continue;
            }
            if (ch == '\\') { esc = true; continue; }
            if (ch == '"') { inQ = !inQ; continue; }
            if (!inQ && char.IsWhiteSpace(ch)) { if (cur.Length > 0) { outList.Add(cur.ToString()); cur.Clear(); } continue; }
            cur.Append(ch);
        }
        if (cur.Length > 0) outList.Add(cur.ToString());
        return outList;
    }
}
