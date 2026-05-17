using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using DbMigrator.Web.Models;
using MySqlConnector;

namespace DbMigrator.Web.Adapters;

public class MySqlAdapter : IDatabaseAdapter
{
    public string Type => "mysql";

    private static string BuildConnString(DbConnectionInfo c, bool allowMultiple = false)
    {
        var b = new MySqlConnectionStringBuilder
        {
            Server = c.Host,
            Port = (uint)(c.Port == 0 ? 3306 : c.Port),
            UserID = c.User,
            Password = c.Password,
            ConnectionTimeout = 8,
            CharacterSet = "utf8mb4",
            AllowUserVariables = allowMultiple,
        };
        if (!string.IsNullOrEmpty(c.Database)) b.Database = c.Database;
        return b.ConnectionString;
    }

    public async Task<TestResult> TestConnectionAsync(DbConnectionInfo conn)
    {
        try
        {
            // Connect without specifying a DB so we can list all schemas the user can see.
            var connNoDb = new DbConnectionInfo
            {
                Host = conn.Host, Port = conn.Port, User = conn.User,
                Password = conn.Password, Database = "", AuthMode = conn.AuthMode,
            };
            await using var c = new MySqlConnection(BuildConnString(connNoDb));
            await c.OpenAsync();
            string version;
            await using (var cmd = new MySqlCommand("SELECT VERSION()", c))
                version = (await cmd.ExecuteScalarAsync())?.ToString() ?? "";

            var dbs = new List<string>();
            await using (var cmd = new MySqlCommand(
                @"SELECT SCHEMA_NAME FROM information_schema.SCHEMATA
                  WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys')
                  ORDER BY SCHEMA_NAME", c))
            await using (var rd = await cmd.ExecuteReaderAsync())
                while (await rd.ReadAsync()) dbs.Add(rd.GetString(0));

            return new TestResult { Ok = true, Version = version, Databases = dbs };
        }
        catch (Exception ex)
        {
            return new TestResult { Ok = false, Error = ex.Message };
        }
    }

    public async Task<List<TableInfo>> ListTablesAsync(DbConnectionInfo conn)
    {
        var list = new List<TableInfo>();
        await using var c = new MySqlConnection(BuildConnString(conn));
        await c.OpenAsync();
        await using var cmd = new MySqlCommand(
            "SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES " +
            "WHERE TABLE_SCHEMA = @db AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", c);
        cmd.Parameters.AddWithValue("@db", conn.Database);
        await using var rd = await cmd.ExecuteReaderAsync();
        while (await rd.ReadAsync())
        {
            list.Add(new TableInfo
            {
                Name = rd.GetString(0),
                RowEstimate = rd.IsDBNull(1) ? null : rd.GetInt64(1),
            });
        }
        return list;
    }

    private static string EscapeIdent(string name) => "`" + name.Replace("`", "``") + "`";

    private static string EscapeString(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('\'');
        foreach (var ch in s)
        {
            switch (ch)
            {
                case '\0': sb.Append(@"\0"); break;
                case '\n': sb.Append(@"\n"); break;
                case '\r': sb.Append(@"\r"); break;
                case '\\': sb.Append(@"\\"); break;
                case '\'': sb.Append(@"\'"); break;
                case '"': sb.Append("\\\""); break;
                case '\x1a': sb.Append(@"\Z"); break;
                default: sb.Append(ch); break;
            }
        }
        sb.Append('\'');
        return sb.ToString();
    }

    private static string FormatValue(object? v)
    {
        if (v is null || v is DBNull) return "NULL";
        return v switch
        {
            bool b => b ? "1" : "0",
            byte by => by.ToString(CultureInfo.InvariantCulture),
            sbyte sb => sb.ToString(CultureInfo.InvariantCulture),
            short s => s.ToString(CultureInfo.InvariantCulture),
            ushort us => us.ToString(CultureInfo.InvariantCulture),
            int i => i.ToString(CultureInfo.InvariantCulture),
            uint ui => ui.ToString(CultureInfo.InvariantCulture),
            long l => l.ToString(CultureInfo.InvariantCulture),
            ulong ul => ul.ToString(CultureInfo.InvariantCulture),
            float f => f.ToString("R", CultureInfo.InvariantCulture),
            double d => d.ToString("R", CultureInfo.InvariantCulture),
            decimal m => m.ToString(CultureInfo.InvariantCulture),
            DateTime dt => "'" + dt.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "'",
            DateTimeOffset dto => "'" + dto.UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "'",
            TimeSpan ts => "'" + ts.ToString(@"hh\:mm\:ss", CultureInfo.InvariantCulture) + "'",
            byte[] bytes => "0x" + Convert.ToHexString(bytes),
            Guid g => EscapeString(g.ToString()),
            string str => EscapeString(str),
            _ => EscapeString(v.ToString() ?? ""),
        };
    }

    private static async Task DumpTableSchemaAsync(MySqlConnection c, string table, StreamWriter w, CancellationToken ct)
    {
        await using var cmd = new MySqlCommand($"SHOW CREATE TABLE {EscapeIdent(table)}", c);
        await using var rd = await cmd.ExecuteReaderAsync(ct);
        if (await rd.ReadAsync(ct))
        {
            var ddl = rd.GetString(1);
            await w.WriteLineAsync();
            await w.WriteLineAsync("-- ----------------------------");
            await w.WriteLineAsync($"-- Table structure: {table}");
            await w.WriteLineAsync("-- ----------------------------");
            await w.WriteLineAsync($"DROP TABLE IF EXISTS {EscapeIdent(table)};");
            await w.WriteLineAsync(ddl + ";");
            await w.WriteLineAsync();
        }
    }

    private static async Task DumpTableDataAsync(MySqlConnection c, string table, StreamWriter w, Action<string>? onProgress, CancellationToken ct)
    {
        await w.WriteLineAsync("-- ----------------------------");
        await w.WriteLineAsync($"-- Data: {table}");
        await w.WriteLineAsync("-- ----------------------------");

        await using var cmd = new MySqlCommand($"SELECT * FROM {EscapeIdent(table)}", c);
        cmd.CommandTimeout = 0;
        await using var rd = await cmd.ExecuteReaderAsync(System.Data.CommandBehavior.SequentialAccess, ct);

        if (rd.FieldCount == 0) return;

        var colNames = new string[rd.FieldCount];
        for (int i = 0; i < rd.FieldCount; i++) colNames[i] = EscapeIdent(rd.GetName(i));
        var columnsLine = "(" + string.Join(",", colNames) + ")";

        var batch = new List<string>(500);
        long batchBytes = 0;
        long rowCount = 0;
        const int MAX_BATCH = 500;
        const int MAX_BYTES = 512 * 1024;

        async Task FlushAsync()
        {
            if (batch.Count == 0) return;
            await w.WriteAsync($"INSERT INTO {EscapeIdent(table)} {columnsLine} VALUES\n");
            await w.WriteAsync(string.Join(",\n", batch));
            await w.WriteLineAsync(";");
            batch.Clear();
            batchBytes = 0;
        }

        while (await rd.ReadAsync(ct))
        {
            var values = new string[rd.FieldCount];
            for (int i = 0; i < rd.FieldCount; i++)
                values[i] = FormatValue(rd.IsDBNull(i) ? null : rd.GetValue(i));
            var line = "  (" + string.Join(",", values) + ")";
            batch.Add(line);
            batchBytes += line.Length;
            rowCount++;
            if (batch.Count >= MAX_BATCH || batchBytes >= MAX_BYTES) await FlushAsync();
            if (rowCount % 5000 == 0) onProgress?.Invoke($"  {table}: {rowCount} rows...");
        }
        await FlushAsync();
        await w.WriteLineAsync();
        onProgress?.Invoke($"  {table}: {rowCount} rows done");
    }

    public async Task DumpAsync(DbConnectionInfo conn, ExportOptions options, string outFilePath, Action<string>? onProgress, CancellationToken ct)
    {
        await using var c = new MySqlConnection(BuildConnString(conn));
        await c.OpenAsync(ct);

        await using var fs = new FileStream(outFilePath, FileMode.Create, FileAccess.Write, FileShare.None, 64 * 1024);
        await using var w = new StreamWriter(fs, new UTF8Encoding(false));

        await w.WriteLineAsync("-- DB Migrator dump");
        await w.WriteLineAsync($"-- Database: {conn.Database}");
        await w.WriteLineAsync($"-- Generated: {DateTime.UtcNow:O}");
        await w.WriteLineAsync();
        await w.WriteLineAsync("SET NAMES utf8mb4;");
        await w.WriteLineAsync("SET FOREIGN_KEY_CHECKS=0;");
        await w.WriteLineAsync("SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';");
        await w.WriteLineAsync();

        List<string> tables;
        if (options.Tables is { Count: > 0 })
        {
            tables = options.Tables;
        }
        else
        {
            tables = (await ListTablesAsync(conn)).Select(t => t.Name).ToList();
        }

        onProgress?.Invoke($"Dumping {tables.Count} table(s)");

        foreach (var table in tables)
        {
            ct.ThrowIfCancellationRequested();
            onProgress?.Invoke($"> {table}");
            if (!options.NoSchema) await DumpTableSchemaAsync(c, table, w, ct);
            if (!options.NoData)
            {
                // Use a fresh connection for streaming data so the DDL reader is closed.
                await using var dataConn = new MySqlConnection(BuildConnString(conn));
                await dataConn.OpenAsync(ct);
                await DumpTableDataAsync(dataConn, table, w, onProgress, ct);
            }
        }

        // ===== Triggers — MySQL's FK + indexes are already in SHOW CREATE TABLE =====
        if (!options.NoSchema)
        {
            try
            {
                var trigRows = new List<(string Name, string Tbl)>();
                await using (var cmd = new MySqlCommand(
                    @"SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS
                      WHERE TRIGGER_SCHEMA = @db ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME", c))
                {
                    cmd.Parameters.AddWithValue("@db", conn.Database);
                    await using var rd = await cmd.ExecuteReaderAsync(ct);
                    while (await rd.ReadAsync(ct)) trigRows.Add((rd.GetString(0), rd.GetString(1)));
                }
                var tableSet = new HashSet<string>(tables);
                var relevant = trigRows.Where(t => tableSet.Contains(t.Tbl)).ToList();
                if (relevant.Count > 0)
                {
                    await w.WriteLineAsync($"\n-- ----------------------------\n-- Triggers ({relevant.Count})\n-- ----------------------------");
                    foreach (var t in relevant)
                    {
                        await using var cmd = new MySqlCommand($"SHOW CREATE TRIGGER {EscapeIdent(t.Name)}", c);
                        await using var rd = await cmd.ExecuteReaderAsync(ct);
                        if (await rd.ReadAsync(ct))
                        {
                            // Column ordering: Trigger | sql_mode | SQL Original Statement | character_set_client | ...
                            string ddl = rd.GetString(2);
                            await w.WriteLineAsync($"DROP TRIGGER IF EXISTS {EscapeIdent(t.Name)};");
                            await w.WriteLineAsync($"{SqlHelpers.RoutineBegin} trigger {t.Name}");
                            await w.WriteLineAsync(ddl);
                            await w.WriteLineAsync(SqlHelpers.RoutineEnd);
                            await w.WriteLineAsync();
                        }
                    }
                    onProgress?.Invoke($"  {relevant.Count} trigger(s)");
                }
            }
            catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped trigger dump: {ex.Message})"); }

            // ===== Views =====
            try
            {
                var views = new List<string>();
                await using (var cmd = new MySqlCommand(
                    "SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = @db ORDER BY TABLE_NAME", c))
                {
                    cmd.Parameters.AddWithValue("@db", conn.Database);
                    await using var rd = await cmd.ExecuteReaderAsync(ct);
                    while (await rd.ReadAsync(ct)) views.Add(rd.GetString(0));
                }
                if (views.Count > 0)
                {
                    await w.WriteLineAsync($"\n-- ----------------------------\n-- Views ({views.Count})\n-- ----------------------------");
                    foreach (var v in views)
                    {
                        try
                        {
                            await using var cmd = new MySqlCommand($"SHOW CREATE VIEW {EscapeIdent(v)}", c);
                            await using var rd = await cmd.ExecuteReaderAsync(ct);
                            if (await rd.ReadAsync(ct))
                            {
                                // Column ordering: View | Create View | character_set_client | collation_connection
                                string ddl = rd.GetString(1);
                                await w.WriteLineAsync($"DROP VIEW IF EXISTS {EscapeIdent(v)};");
                                await w.WriteLineAsync(ddl + ";");
                                await w.WriteLineAsync();
                            }
                        }
                        catch (Exception ex) { await w.WriteLineAsync($"-- (view {v} skipped: {ex.Message})"); }
                    }
                    onProgress?.Invoke($"  {views.Count} view(s)");
                }
            }
            catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped view dump: {ex.Message})"); }

            // ===== Stored procedures + functions =====
            try
            {
                var routines = new List<(string Name, string Type)>();
                await using (var cmd = new MySqlCommand(
                    @"SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES
                      WHERE ROUTINE_SCHEMA = @db ORDER BY ROUTINE_TYPE, ROUTINE_NAME", c))
                {
                    cmd.Parameters.AddWithValue("@db", conn.Database);
                    await using var rd = await cmd.ExecuteReaderAsync(ct);
                    while (await rd.ReadAsync(ct)) routines.Add((rd.GetString(0), rd.GetString(1)));
                }
                var procs = routines.Where(r => r.Type == "PROCEDURE").ToList();
                var funcs = routines.Where(r => r.Type == "FUNCTION").ToList();

                if (procs.Count > 0)
                {
                    await w.WriteLineAsync($"\n-- ----------------------------\n-- Stored procedures ({procs.Count})\n-- ----------------------------");
                    foreach (var p in procs)
                    {
                        try
                        {
                            await using var cmd = new MySqlCommand($"SHOW CREATE PROCEDURE {EscapeIdent(p.Name)}", c);
                            await using var rd = await cmd.ExecuteReaderAsync(ct);
                            if (await rd.ReadAsync(ct))
                            {
                                // Column ordering: Procedure | sql_mode | Create Procedure | ...
                                string ddl = rd.GetString(2);
                                await w.WriteLineAsync($"DROP PROCEDURE IF EXISTS {EscapeIdent(p.Name)};");
                                await w.WriteLineAsync($"{SqlHelpers.RoutineBegin} procedure {p.Name}");
                                await w.WriteLineAsync(ddl);
                                await w.WriteLineAsync(SqlHelpers.RoutineEnd);
                                await w.WriteLineAsync();
                            }
                        }
                        catch (Exception ex) { await w.WriteLineAsync($"-- (proc {p.Name} skipped: {ex.Message})"); }
                    }
                    onProgress?.Invoke($"  {procs.Count} procedure(s)");
                }

                if (funcs.Count > 0)
                {
                    await w.WriteLineAsync($"\n-- ----------------------------\n-- Functions ({funcs.Count})\n-- ----------------------------");
                    foreach (var f in funcs)
                    {
                        try
                        {
                            await using var cmd = new MySqlCommand($"SHOW CREATE FUNCTION {EscapeIdent(f.Name)}", c);
                            await using var rd = await cmd.ExecuteReaderAsync(ct);
                            if (await rd.ReadAsync(ct))
                            {
                                string ddl = rd.GetString(2);
                                await w.WriteLineAsync($"DROP FUNCTION IF EXISTS {EscapeIdent(f.Name)};");
                                await w.WriteLineAsync($"{SqlHelpers.RoutineBegin} function {f.Name}");
                                await w.WriteLineAsync(ddl);
                                await w.WriteLineAsync(SqlHelpers.RoutineEnd);
                                await w.WriteLineAsync();
                            }
                        }
                        catch (Exception ex) { await w.WriteLineAsync($"-- (func {f.Name} skipped: {ex.Message})"); }
                    }
                    onProgress?.Invoke($"  {funcs.Count} function(s)");
                }
            }
            catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped routine dump: {ex.Message})"); }

            // ===== Events =====
            try
            {
                var events = new List<string>();
                await using (var cmd = new MySqlCommand(
                    "SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = @db ORDER BY EVENT_NAME", c))
                {
                    cmd.Parameters.AddWithValue("@db", conn.Database);
                    await using var rd = await cmd.ExecuteReaderAsync(ct);
                    while (await rd.ReadAsync(ct)) events.Add(rd.GetString(0));
                }
                if (events.Count > 0)
                {
                    await w.WriteLineAsync($"\n-- ----------------------------\n-- Events ({events.Count})\n-- ----------------------------");
                    foreach (var ev in events)
                    {
                        try
                        {
                            await using var cmd = new MySqlCommand($"SHOW CREATE EVENT {EscapeIdent(ev)}", c);
                            await using var rd = await cmd.ExecuteReaderAsync(ct);
                            if (await rd.ReadAsync(ct))
                            {
                                // Column ordering: Event | sql_mode | time_zone | Create Event | ...
                                string ddl = rd.GetString(3);
                                await w.WriteLineAsync($"DROP EVENT IF EXISTS {EscapeIdent(ev)};");
                                await w.WriteLineAsync($"{SqlHelpers.RoutineBegin} event {ev}");
                                await w.WriteLineAsync(ddl);
                                await w.WriteLineAsync(SqlHelpers.RoutineEnd);
                                await w.WriteLineAsync();
                            }
                        }
                        catch (Exception ex) { await w.WriteLineAsync($"-- (event {ev} skipped: {ex.Message})"); }
                    }
                    onProgress?.Invoke($"  {events.Count} event(s)");
                }
            }
            catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped event dump: {ex.Message})"); }
        }

        await w.WriteLineAsync("SET FOREIGN_KEY_CHECKS=1;");
        onProgress?.Invoke("Done");
    }

    public async Task RestoreAsync(DbConnectionInfo conn, string sqlFilePath, Action<string>? onProgress, CancellationToken ct)
    {
        await using var c = new MySqlConnection(BuildConnString(conn, allowMultiple: true));
        await c.OpenAsync(ct);

        var sql = await File.ReadAllTextAsync(sqlFilePath, ct);
        onProgress?.Invoke($"Executing {sql.Length / 1024} KB of SQL...");

        // Routine bodies (procedures / functions / triggers / events) contain ';' inside
        // their BEGIN..END blocks. Pull them out as single-statement blocks; everything
        // else still goes through the per-statement splitter.
        int executed = 0;
        foreach (var block in SqlHelpers.ExtractRoutineBlocks(sql))
        {
            ct.ThrowIfCancellationRequested();
            if (block.Kind == SqlHelpers.BlockKind.Routine)
            {
                var body = block.Body.TrimEnd(';', ' ', '\t', '\r', '\n');
                if (body.Length == 0) continue;
                await using var cmd = new MySqlCommand(body, c) { CommandTimeout = 600 };
                await cmd.ExecuteNonQueryAsync(ct);
                executed++;
            }
            else
            {
                foreach (var stmt in SplitSqlStatements(block.Body))
                {
                    ct.ThrowIfCancellationRequested();
                    await using var cmd = new MySqlCommand(stmt, c) { CommandTimeout = 600 };
                    await cmd.ExecuteNonQueryAsync(ct);
                    executed++;
                    if (executed % 50 == 0) onProgress?.Invoke($"  {executed} statements executed");
                }
            }
        }
        onProgress?.Invoke($"Restore complete ({executed} statements)");
    }

    // Naive SQL splitter: strips -- line comments and /* */ block comments,
    // splits on ';' that are outside string/identifier literals.
    private static IEnumerable<string> SplitSqlStatements(string sql)
    {
        var sb = new StringBuilder();
        bool inSingle = false, inDouble = false, inBacktick = false;
        int i = 0;
        while (i < sql.Length)
        {
            char ch = sql[i];
            char next = i + 1 < sql.Length ? sql[i + 1] : '\0';

            if (!inSingle && !inDouble && !inBacktick)
            {
                if (ch == '-' && next == '-')
                {
                    while (i < sql.Length && sql[i] != '\n') i++;
                    continue;
                }
                if (ch == '/' && next == '*')
                {
                    i += 2;
                    while (i + 1 < sql.Length && !(sql[i] == '*' && sql[i + 1] == '/')) i++;
                    i += 2;
                    continue;
                }
            }

            if (ch == '\\' && (inSingle || inDouble))
            {
                sb.Append(ch);
                if (i + 1 < sql.Length) sb.Append(sql[++i]);
                i++;
                continue;
            }

            if (!inDouble && !inBacktick && ch == '\'') inSingle = !inSingle;
            else if (!inSingle && !inBacktick && ch == '"') inDouble = !inDouble;
            else if (!inSingle && !inDouble && ch == '`') inBacktick = !inBacktick;

            if (ch == ';' && !inSingle && !inDouble && !inBacktick)
            {
                var stmt = sb.ToString().Trim();
                if (stmt.Length > 0) yield return stmt;
                sb.Clear();
            }
            else
            {
                sb.Append(ch);
            }
            i++;
        }
        var last = sb.ToString().Trim();
        if (last.Length > 0) yield return last;
    }

    public List<string> ParseTableNamesFromDump(string sqlFilePath)
    {
        var text = File.ReadAllText(sqlFilePath);
        var rx = new Regex(@"CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`?([^`\s(]+)`?",
            RegexOptions.IgnoreCase);
        var set = new HashSet<string>();
        foreach (Match m in rx.Matches(text)) set.Add(m.Groups[1].Value);
        return set.ToList();
    }
}
