using System.Text.Json;
using DbMigrator.Web.Models;
using Microsoft.Data.Sqlite;

namespace DbMigrator.Web.Services;

// Scheduled backups — equivalent to node-express/lib/schedules.js.
// Persists in schedules.db (SQLite). Tick loop runs every minute; fires due schedules.

public class ScheduleService : IHostedService, IDisposable
{
    private static readonly string DbPath = Environment.GetEnvironmentVariable("SCHEDULES_DB")
        ?? Path.Combine(AppContext.BaseDirectory, "schedules.db");

    public static readonly string OutputDir = Environment.GetEnvironmentVariable("SCHEDULE_OUTPUT_DIR")
        ?? Path.Combine(AppContext.BaseDirectory, "scheduled-backups");

    private readonly SqliteConnection _db;
    private readonly object _lock = new();
    private readonly EncryptionService _enc;
    private Timer? _tickTimer;

    public Func<Schedule, Task<string>>? Dispatcher { get; set; }   // returns jobId

    public ScheduleService(EncryptionService enc)
    {
        _enc = enc;
        Directory.CreateDirectory(OutputDir);
        _db = new SqliteConnection($"Data Source={DbPath};Cache=Shared");
        _db.Open();
        Exec("PRAGMA journal_mode = WAL");
        Exec(@"
          CREATE TABLE IF NOT EXISTS schedules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            conn_json TEXT NOT NULL,
            conn_pwd_enc TEXT,
            databases_json TEXT NOT NULL,
            expression TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            next_run_at INTEGER,
            last_run_at INTEGER,
            last_status TEXT,
            last_error TEXT,
            last_job_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(active, next_run_at);
        ");
    }

    public Task StartAsync(CancellationToken ct)
    {
        Console.WriteLine($"[schedule] loop started; output dir: {OutputDir}");
        _tickTimer = new Timer(_ => _ = TickAsync(), null, TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(1));
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken ct)
    {
        _tickTimer?.Change(Timeout.Infinite, 0);
        return Task.CompletedTask;
    }

    public void Dispose() { _tickTimer?.Dispose(); _db?.Dispose(); }

    private void Exec(string sql)
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    // ============== Expression parsing ==============
    private record ExprParsed(string Type, long? Ms = null, int? Hh = null, int? Mm = null);

    private static ExprParsed ParseExpression(string expr)
    {
        var s = (expr ?? "").Trim().ToLowerInvariant();
        var m = System.Text.RegularExpressions.Regex.Match(s, @"^every\s+(\d+)\s*(minute|minutes|hour|hours|day|days)$");
        if (m.Success)
        {
            var n = long.Parse(m.Groups[1].Value);
            var unit = m.Groups[2].Value;
            long ms = unit.StartsWith("minute") ? n * 60_000
                    : unit.StartsWith("hour")   ? n * 3_600_000
                    : n * 86_400_000;
            return new ExprParsed("every", Ms: ms);
        }
        m = System.Text.RegularExpressions.Regex.Match(s, @"^daily\s+at\s+(\d{1,2}):(\d{2})$");
        if (m.Success) return new ExprParsed("daily", Hh: int.Parse(m.Groups[1].Value), Mm: int.Parse(m.Groups[2].Value));
        throw new Exception($"Unsupported schedule expression: {expr}. Use \"every N minutes/hours/days\" or \"daily at HH:MM\"");
    }

    private static long NextRunAfter(long now, string expression)
    {
        var p = ParseExpression(expression);
        if (p.Type == "every") return now + p.Ms!.Value;
        if (p.Type == "daily")
        {
            var d = DateTimeOffset.FromUnixTimeMilliseconds(now).LocalDateTime;
            d = new DateTime(d.Year, d.Month, d.Day, p.Hh!.Value, p.Mm!.Value, 0);
            var dms = new DateTimeOffset(d, TimeZoneInfo.Local.GetUtcOffset(d)).ToUnixTimeMilliseconds();
            if (dms <= now) dms = new DateTimeOffset(d.AddDays(1), TimeZoneInfo.Local.GetUtcOffset(d.AddDays(1))).ToUnixTimeMilliseconds();
            return dms;
        }
        return now + 3_600_000;
    }

    // ============== CRUD ==============
    public List<Schedule> List()
    {
        lock (_lock)
        {
            var list = new List<Schedule>();
            using var cmd = _db.CreateCommand();
            cmd.CommandText = "SELECT * FROM schedules ORDER BY created_at DESC";
            using var rd = cmd.ExecuteReader();
            while (rd.Read()) list.Add(RowToSchedule(rd));
            return list;
        }
    }

    public Schedule? Get(string id)
    {
        lock (_lock)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = "SELECT * FROM schedules WHERE id = $id";
            cmd.Parameters.AddWithValue("$id", id);
            using var rd = cmd.ExecuteReader();
            return rd.Read() ? RowToSchedule(rd) : null;
        }
    }

    private Schedule RowToSchedule(SqliteDataReader rd)
    {
        var connJson = rd.GetString(rd.GetOrdinal("conn_json"));
        var conn = JsonSerializer.Deserialize<DbConnectionInfo>(connJson, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? new DbConnectionInfo();
        return new Schedule
        {
            Id = rd.GetString(rd.GetOrdinal("id")),
            Name = rd.GetString(rd.GetOrdinal("name")),
            Type = rd.GetString(rd.GetOrdinal("type")),
            Connection = conn,
            Databases = JsonSerializer.Deserialize<List<string>>(rd.GetString(rd.GetOrdinal("databases_json"))) ?? new(),
            Expression = rd.GetString(rd.GetOrdinal("expression")),
            Active = rd.GetInt64(rd.GetOrdinal("active")) == 1,
            NextRunAt = rd.IsDBNull(rd.GetOrdinal("next_run_at")) ? null : rd.GetInt64(rd.GetOrdinal("next_run_at")),
            LastRunAt = rd.IsDBNull(rd.GetOrdinal("last_run_at")) ? null : rd.GetInt64(rd.GetOrdinal("last_run_at")),
            LastStatus = rd.IsDBNull(rd.GetOrdinal("last_status")) ? null : rd.GetString(rd.GetOrdinal("last_status")),
            LastError = rd.IsDBNull(rd.GetOrdinal("last_error")) ? null : rd.GetString(rd.GetOrdinal("last_error")),
            LastJobId = rd.IsDBNull(rd.GetOrdinal("last_job_id")) ? null : rd.GetString(rd.GetOrdinal("last_job_id")),
            CreatedAt = rd.GetInt64(rd.GetOrdinal("created_at")),
            UpdatedAt = rd.GetInt64(rd.GetOrdinal("updated_at")),
            HasPassword = !rd.IsDBNull(rd.GetOrdinal("conn_pwd_enc")),
        };
    }

    public Schedule Create(CreateScheduleRequest req)
    {
        if (string.IsNullOrEmpty(req.Name) || string.IsNullOrEmpty(req.Type) ||
            string.IsNullOrEmpty(req.Expression) || req.Databases.Count == 0)
            throw new Exception("name, type, expression, databases required");
        ParseExpression(req.Expression);  // validates

        var id = Guid.NewGuid().ToString();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var (connNoPwd, pwd) = SeparatePassword(req.Connection);
        var encPwd = string.IsNullOrEmpty(pwd) ? null : _enc.Encrypt(pwd);

        lock (_lock)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = @"
              INSERT INTO schedules (id, name, type, conn_json, conn_pwd_enc, databases_json, expression, active,
                                     next_run_at, created_at, updated_at)
              VALUES ($id, $name, $type, $conn, $pwd, $dbs, $expr, $active, $next, $now, $now)";
            cmd.Parameters.AddWithValue("$id", id);
            cmd.Parameters.AddWithValue("$name", req.Name);
            cmd.Parameters.AddWithValue("$type", req.Type);
            cmd.Parameters.AddWithValue("$conn", JsonSerializer.Serialize(connNoPwd));
            cmd.Parameters.AddWithValue("$pwd", (object?)encPwd ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$dbs", JsonSerializer.Serialize(req.Databases));
            cmd.Parameters.AddWithValue("$expr", req.Expression);
            cmd.Parameters.AddWithValue("$active", req.Active ? 1 : 0);
            cmd.Parameters.AddWithValue("$next", NextRunAfter(now, req.Expression));
            cmd.Parameters.AddWithValue("$now", now);
            cmd.ExecuteNonQuery();
        }
        return Get(id)!;
    }

    public Schedule Update(string id, UpdateScheduleRequest patch)
    {
        var cur = Get(id) ?? throw new Exception("not found");
        var fields = new List<string>();
        var prm = new Dictionary<string, object?>();
        if (patch.Name != null)       { fields.Add("name = $name"); prm["$name"] = patch.Name; }
        if (patch.Type != null)       { fields.Add("type = $type"); prm["$type"] = patch.Type; }
        if (patch.Databases != null)  { fields.Add("databases_json = $dbs"); prm["$dbs"] = JsonSerializer.Serialize(patch.Databases); }
        if (patch.Expression != null)
        {
            ParseExpression(patch.Expression);
            fields.Add("expression = $expr"); prm["$expr"] = patch.Expression;
            fields.Add("next_run_at = $next"); prm["$next"] = NextRunAfter(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), patch.Expression);
        }
        if (patch.Active.HasValue)    { fields.Add("active = $active"); prm["$active"] = patch.Active.Value ? 1 : 0; }
        if (patch.Connection != null)
        {
            var (rest, pwd) = SeparatePassword(patch.Connection);
            fields.Add("conn_json = $conn"); prm["$conn"] = JsonSerializer.Serialize(rest);
            if (pwd != null)
            {
                fields.Add("conn_pwd_enc = $pwd");
                prm["$pwd"] = string.IsNullOrEmpty(pwd) ? (object)DBNull.Value : _enc.Encrypt(pwd)!;
            }
        }
        if (fields.Count == 0) return cur;
        fields.Add("updated_at = $now"); prm["$now"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        lock (_lock)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = $"UPDATE schedules SET {string.Join(", ", fields)} WHERE id = $id";
            foreach (var kv in prm) cmd.Parameters.AddWithValue(kv.Key, kv.Value!);
            cmd.Parameters.AddWithValue("$id", id);
            cmd.ExecuteNonQuery();
        }
        return Get(id)!;
    }

    public void Remove(string id)
    {
        lock (_lock)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = "DELETE FROM schedules WHERE id = $id";
            cmd.Parameters.AddWithValue("$id", id);
            cmd.ExecuteNonQuery();
        }
    }

    public DbConnectionInfo? LoadConnectionWithPassword(string id)
    {
        lock (_lock)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = "SELECT conn_json, conn_pwd_enc FROM schedules WHERE id = $id";
            cmd.Parameters.AddWithValue("$id", id);
            using var rd = cmd.ExecuteReader();
            if (!rd.Read()) return null;
            var conn = JsonSerializer.Deserialize<DbConnectionInfo>(rd.GetString(0),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new DbConnectionInfo();
            if (!rd.IsDBNull(1))
            {
                try { conn.Password = _enc.Decrypt(rd.GetString(1)) ?? ""; }
                catch { throw new Exception("Failed to decrypt password — wrong SCHEDULE_KEY?"); }
            }
            return conn;
        }
    }

    public void MarkRunResult(string id, bool ok, string? error, string? jobId)
    {
        var cur = Get(id);
        if (cur == null) return;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        lock (_lock)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = @"UPDATE schedules SET
              last_run_at = $t, last_status = $st, last_error = $err, last_job_id = $jid,
              next_run_at = $next, updated_at = $t WHERE id = $id";
            cmd.Parameters.AddWithValue("$t", now);
            cmd.Parameters.AddWithValue("$st", ok ? "ok" : "error");
            cmd.Parameters.AddWithValue("$err", (object?)error ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$jid", (object?)jobId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$next", NextRunAfter(now, cur.Expression));
            cmd.Parameters.AddWithValue("$id", id);
            cmd.ExecuteNonQuery();
        }
    }

    // ============== Tick loop ==============
    public async Task TickAsync()
    {
        if (Dispatcher == null) return;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        List<(string Id, string Name)> due;
        lock (_lock)
        {
            due = new();
            using var cmd = _db.CreateCommand();
            cmd.CommandText = @"SELECT id, name FROM schedules
                                WHERE active = 1 AND (next_run_at IS NULL OR next_run_at <= $now)";
            cmd.Parameters.AddWithValue("$now", now);
            using var rd = cmd.ExecuteReader();
            while (rd.Read()) due.Add((rd.GetString(0), rd.GetString(1)));
        }
        foreach (var (id, name) in due)
        {
            try
            {
                Console.WriteLine($"[schedule] firing \"{name}\" ({id[..8]})");
                var jobId = await Dispatcher(Get(id)!);
                MarkRunResult(id, true, null, jobId);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[schedule] \"{name}\" failed: {ex.Message}");
                MarkRunResult(id, false, ex.Message, null);
            }
        }
    }

    private static (DbConnectionInfo Rest, string? Pwd) SeparatePassword(DbConnectionInfo c)
    {
        var rest = new DbConnectionInfo
        {
            Host = c.Host, Port = c.Port, Database = c.Database, User = c.User,
            Password = "", Path = c.Path, AuthMode = c.AuthMode, Ssl = c.Ssl,
        };
        return (rest, c.Password);
    }
}
