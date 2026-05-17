using System.Data;
using DbMigrator.Web.Models;
using Microsoft.Data.Sqlite;
using static DbMigrator.Web.Adapters.SqlHelpers;

namespace DbMigrator.Web.Adapters;

public class SqliteAdapter : IDatabaseAdapter
{
    public string Type => "sqlite";

    private static readonly FormatOptions Fmt = new()
    {
        EscapeString = EscapeAnsi,
        FormatBinary = b => "X'" + Convert.ToHexString(b) + "'",
        BoolAs01 = true,
    };

    private static string PickPath(DbConnectionInfo c)
    {
        var p = c.Path ?? c.Database ?? c.Host;
        if (string.IsNullOrWhiteSpace(p)) throw new Exception("SQLite needs a file path (connection.path)");
        return p;
    }

    private static string ConnString(DbConnectionInfo c, bool readOnly = false) =>
        new SqliteConnectionStringBuilder
        {
            DataSource = PickPath(c),
            Mode = readOnly ? SqliteOpenMode.ReadOnly : SqliteOpenMode.ReadWriteCreate,
        }.ConnectionString;

    public async Task<TestResult> TestConnectionAsync(DbConnectionInfo conn)
    {
        try
        {
            await using var c = new SqliteConnection(ConnString(conn, true));
            await c.OpenAsync();
            await using var cmd = new SqliteCommand("SELECT sqlite_version()", c);
            var v = (await cmd.ExecuteScalarAsync())?.ToString() ?? "";
            // SQLite has no concept of multiple databases — leave Databases null.
            return new TestResult { Ok = true, Version = "SQLite " + v };
        }
        catch (Exception ex) { return new TestResult { Ok = false, Error = ex.Message }; }
    }

    public async Task<List<TableInfo>> ListTablesAsync(DbConnectionInfo conn)
    {
        var list = new List<TableInfo>();
        await using var c = new SqliteConnection(ConnString(conn, true));
        await c.OpenAsync();
        await using var cmd = new SqliteCommand(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", c);
        await using var rd = await cmd.ExecuteReaderAsync();
        while (await rd.ReadAsync()) list.Add(new TableInfo { Name = rd.GetString(0), RowEstimate = null });
        return list;
    }

    public async Task DumpAsync(DbConnectionInfo conn, ExportOptions options, string outFilePath, Action<string>? onProgress, CancellationToken ct)
    {
        await using var c = new SqliteConnection(ConnString(conn, true));
        await c.OpenAsync(ct);
        await using var fs = File.Create(outFilePath);
        await using var w = new StreamWriter(fs, new System.Text.UTF8Encoding(false));

        await w.WriteLineAsync("-- DB Migrator dump (SQLite)");
        await w.WriteLineAsync($"-- File: {PickPath(conn)}");
        await w.WriteLineAsync($"-- Generated: {DateTime.UtcNow:O}");
        await w.WriteLineAsync();
        await w.WriteLineAsync("PRAGMA foreign_keys=OFF;");
        await w.WriteLineAsync("BEGIN TRANSACTION;");
        await w.WriteLineAsync();

        var tables = new List<string>();
        if (options.Tables is { Count: > 0 })
        {
            tables = options.Tables;
        }
        else
        {
            await using var cmd = new SqliteCommand(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", c);
            await using var rd = await cmd.ExecuteReaderAsync(ct);
            while (await rd.ReadAsync(ct)) tables.Add(rd.GetString(0));
        }

        onProgress?.Invoke($"Dumping {tables.Count} table(s)");

        foreach (var table in tables)
        {
            ct.ThrowIfCancellationRequested();
            onProgress?.Invoke($"> {table}");

            string? ddl = null;
            await using (var cmd = new SqliteCommand("SELECT sql FROM sqlite_master WHERE type='table' AND name=@n", c))
            {
                cmd.Parameters.AddWithValue("@n", table);
                ddl = (await cmd.ExecuteScalarAsync(ct))?.ToString();
            }
            if (ddl == null) { onProgress?.Invoke($"  {table}: not found, skipped"); continue; }

            if (!options.NoSchema)
            {
                await w.WriteLineAsync($"\n-- Table: {table}");
                await w.WriteLineAsync($"DROP TABLE IF EXISTS {DoubleQuote(table)};");
                await w.WriteLineAsync(ddl + ";");
                await w.WriteLineAsync();
            }

            if (!options.NoData)
            {
                await using var cmd = new SqliteCommand($"SELECT * FROM {DoubleQuote(table)}", c);
                await using var rd = await cmd.ExecuteReaderAsync(CommandBehavior.SequentialAccess, ct);
                if (rd.FieldCount == 0) continue;

                var cols = new string[rd.FieldCount];
                for (int i = 0; i < rd.FieldCount; i++) cols[i] = DoubleQuote(rd.GetName(i));
                var columnsLine = "(" + string.Join(",", cols) + ")";

                var batch = new List<string>(500);
                long batchBytes = 0; long n = 0;

                async Task Flush()
                {
                    if (batch.Count == 0) return;
                    await w.WriteAsync($"INSERT INTO {DoubleQuote(table)} {columnsLine} VALUES\n");
                    await w.WriteAsync(string.Join(",\n", batch));
                    await w.WriteLineAsync(";");
                    batch.Clear(); batchBytes = 0;
                }

                while (await rd.ReadAsync(ct))
                {
                    var values = new string[rd.FieldCount];
                    for (int i = 0; i < rd.FieldCount; i++) values[i] = FormatValue(rd.IsDBNull(i) ? null : rd.GetValue(i), Fmt);
                    var line = "  (" + string.Join(",", values) + ")";
                    batch.Add(line); batchBytes += line.Length; n++;
                    if (batch.Count >= 500 || batchBytes >= 512 * 1024) await Flush();
                    if (n % 5000 == 0) onProgress?.Invoke($"  {table}: {n} rows...");
                }
                await Flush();
                await w.WriteLineAsync();
                onProgress?.Invoke($"  {table}: {n} rows done");
            }
        }

        await DumpSqliteExtras(c, w, "index", "Indexes", onProgress, ct);
        await DumpSqliteExtras(c, w, "view", "Views", onProgress, ct);
        await DumpSqliteExtras(c, w, "trigger", "Triggers", onProgress, ct);

        await w.WriteLineAsync();
        await w.WriteLineAsync("COMMIT;");
        await w.WriteLineAsync("PRAGMA foreign_keys=ON;");
        onProgress?.Invoke("Done");
    }

    private static async Task DumpSqliteExtras(SqliteConnection c, StreamWriter w, string type, string label,
        Action<string>? onProgress, CancellationToken ct)
    {
        var rows = new List<(string Name, string Sql)>();
        await using (var cmd = new SqliteCommand(
            "SELECT name, sql FROM sqlite_master WHERE type = $t AND sql IS NOT NULL", c))
        {
            cmd.Parameters.AddWithValue("$t", type);
            await using var rd = await cmd.ExecuteReaderAsync(ct);
            while (await rd.ReadAsync(ct)) rows.Add((rd.GetString(0), rd.GetString(1)));
        }
        if (rows.Count == 0) return;
        await w.WriteLineAsync($"\n-- ----------------------------\n-- {label} ({rows.Count})\n-- ----------------------------");
        foreach (var r in rows)
        {
            if (type == "view")    await w.WriteLineAsync($"DROP VIEW IF EXISTS {DoubleQuote(r.Name)};");
            if (type == "trigger") await w.WriteLineAsync($"DROP TRIGGER IF EXISTS {DoubleQuote(r.Name)};");
            await w.WriteLineAsync(r.Sql + ";");
            if (type != "index") await w.WriteLineAsync();
        }
        onProgress?.Invoke($"  {rows.Count} {label.ToLower()}");
    }

    public async Task RestoreAsync(DbConnectionInfo conn, string sqlFilePath, Action<string>? onProgress, CancellationToken ct)
    {
        await using var c = new SqliteConnection(ConnString(conn, false));
        await c.OpenAsync(ct);

        var text = await File.ReadAllTextAsync(sqlFilePath, ct);
        var stmts = SplitSqlStatements(text, '"').ToList();
        onProgress?.Invoke($"Executing {stmts.Count} statements...");

        await using var tx = c.BeginTransaction();
        try
        {
            int n = 0;
            foreach (var s in stmts)
            {
                ct.ThrowIfCancellationRequested();
                if (s.StartsWith("BEGIN", StringComparison.OrdinalIgnoreCase) ||
                    s.StartsWith("COMMIT", StringComparison.OrdinalIgnoreCase) ||
                    s.StartsWith("ROLLBACK", StringComparison.OrdinalIgnoreCase))
                    continue;
                await using var cmd = new SqliteCommand(s, c, tx);
                await cmd.ExecuteNonQueryAsync(ct);
                n++;
                if (n % 50 == 0) onProgress?.Invoke($"  {n}/{stmts.Count}");
            }
            tx.Commit();
            onProgress?.Invoke($"Restore complete ({n} statements)");
        }
        catch
        {
            tx.Rollback();
            throw;
        }
    }

    public List<string> ParseTableNamesFromDump(string sqlFilePath) =>
        SqlHelpers.ParseTableNamesFromDump(sqlFilePath, '"');
}
