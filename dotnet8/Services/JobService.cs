using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace DbMigrator.Web.Services;

public class JobProgress
{
    public long T { get; set; }
    public string Line { get; set; } = "";
}

public class Job
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Kind { get; set; } = "";
    public string Status { get; set; } = "pending";   // pending | running | done | error
    public List<JobProgress> Progress { get; set; } = new();
    public object? Result { get; set; }
    public string? Error { get; set; }
    public long CreatedAt { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}

// SQLite-backed JobService — same API as before.
// Server restart no longer loses in-progress state; 7-day TTL prunes old records.
public class JobService : IDisposable
{
    private static readonly string DbPath = Environment.GetEnvironmentVariable("JOBS_DB")
        ?? Path.Combine(AppContext.BaseDirectory, "jobs.db");

    private readonly SqliteConnection _db;
    private readonly object _lock = new();   // SqliteConnection isn't thread-safe
    private readonly Timer _pruneTimer;

    public JobService()
    {
        _db = new SqliteConnection($"Data Source={DbPath};Cache=Shared");
        _db.Open();
        Exec("PRAGMA journal_mode = WAL");
        Exec(@"
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              status TEXT NOT NULL,
              progress TEXT NOT NULL DEFAULT '[]',
              result TEXT,
              error TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
            CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
        ");

        // Recover stale jobs from previous run
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        using (var cmd = _db.CreateCommand())
        {
            cmd.CommandText = @"
              UPDATE jobs SET status='error', error='Server restarted while job was running', updated_at=$now
              WHERE status IN ('pending', 'running')";
            cmd.Parameters.AddWithValue("$now", now);
            var n = cmd.ExecuteNonQuery();
            if (n > 0) Console.WriteLine($"[jobs] recovered {n} stale job(s) → marked error");
        }

        // Hourly TTL prune
        _pruneTimer = new Timer(_ => Prune(), null, TimeSpan.FromHours(1), TimeSpan.FromHours(1));
    }

    private void Exec(string sql)
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private void Prune()
    {
        try
        {
            lock (_lock)
            {
                long cutoff = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 7L * 24 * 60 * 60 * 1000;
                using var cmd = _db.CreateCommand();
                cmd.CommandText = "DELETE FROM jobs WHERE created_at < $c";
                cmd.Parameters.AddWithValue("$c", cutoff);
                var n = cmd.ExecuteNonQuery();
                if (n > 0) Console.WriteLine($"[jobs] pruned {n} old job record(s)");
            }
        }
        catch (Exception ex) { Console.Error.WriteLine($"[jobs] prune failed: {ex.Message}"); }
    }

    public Job Create(string kind)
    {
        var j = new Job { Kind = kind };
        lock (_lock)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = @"
              INSERT INTO jobs (id, kind, status, progress, created_at, updated_at)
              VALUES ($id, $kind, 'pending', '[]', $now, $now)";
            cmd.Parameters.AddWithValue("$id", j.Id);
            cmd.Parameters.AddWithValue("$kind", kind);
            cmd.Parameters.AddWithValue("$now", j.CreatedAt);
            cmd.ExecuteNonQuery();
        }
        return j;
    }

    public Job? Get(string id)
    {
        lock (_lock)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = "SELECT id, kind, status, progress, result, error, created_at FROM jobs WHERE id = $id";
            cmd.Parameters.AddWithValue("$id", id);
            using var rd = cmd.ExecuteReader();
            if (!rd.Read()) return null;
            return new Job
            {
                Id = rd.GetString(0),
                Kind = rd.GetString(1),
                Status = rd.GetString(2),
                Progress = JsonSerializer.Deserialize<List<JobProgress>>(rd.GetString(3)) ?? new(),
                Result = rd.IsDBNull(4) ? null : JsonSerializer.Deserialize<object>(rd.GetString(4)),
                Error = rd.IsDBNull(5) ? null : rd.GetString(5),
                CreatedAt = rd.GetInt64(6),
            };
        }
    }

    public void Append(string id, string line)
    {
        if (string.IsNullOrEmpty(line)) return;
        lock (_lock)
        {
            using var read = _db.CreateCommand();
            read.CommandText = "SELECT progress FROM jobs WHERE id = $id";
            read.Parameters.AddWithValue("$id", id);
            var json = read.ExecuteScalar() as string;
            if (json == null) return;
            var arr = JsonSerializer.Deserialize<List<JobProgress>>(json) ?? new();
            arr.Add(new JobProgress { T = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Line = line });
            if (arr.Count > 200) arr.RemoveAt(0);

            using var upd = _db.CreateCommand();
            upd.CommandText = "UPDATE jobs SET progress = $p, updated_at = $now WHERE id = $id";
            upd.Parameters.AddWithValue("$p", JsonSerializer.Serialize(arr));
            upd.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            upd.Parameters.AddWithValue("$id", id);
            upd.ExecuteNonQuery();
        }
    }

    public void SetStatus(string id, string status, Action<Job>? patch = null)
    {
        // Need to mutate Result / Error via patch — fetch, apply, persist
        var j = Get(id);
        if (j == null) return;
        j.Status = status;
        patch?.Invoke(j);
        lock (_lock)
        {
            using var cmd = _db.CreateCommand();
            cmd.CommandText = @"
              UPDATE jobs SET status = $status, result = $result, error = $error, updated_at = $now
              WHERE id = $id";
            cmd.Parameters.AddWithValue("$status", j.Status);
            cmd.Parameters.AddWithValue("$result", j.Result == null ? DBNull.Value : (object)JsonSerializer.Serialize(j.Result));
            cmd.Parameters.AddWithValue("$error", (object?)j.Error ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            cmd.Parameters.AddWithValue("$id", id);
            cmd.ExecuteNonQuery();
        }
    }

    public void Dispose()
    {
        _pruneTimer?.Dispose();
        _db?.Dispose();
    }
}
