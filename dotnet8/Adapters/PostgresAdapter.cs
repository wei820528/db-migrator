using System.Data;
using DbMigrator.Web.Models;
using Npgsql;
using static DbMigrator.Web.Adapters.SqlHelpers;

namespace DbMigrator.Web.Adapters;

public class PostgresAdapter : IDatabaseAdapter
{
    public string Type => "postgres";

    private static readonly FormatOptions Fmt = new()
    {
        EscapeString = EscapeAnsi,
        FormatBinary = b => "decode('" + Convert.ToHexString(b) + "', 'hex')",
        BoolAs01 = false,
    };

    private static string ConnString(DbConnectionInfo c, string? defaultDb = null)
    {
        var b = new NpgsqlConnectionStringBuilder
        {
            Host = c.Host,
            Port = c.Port == 0 ? 5432 : c.Port,
            Username = c.User,
            Password = c.Password,
            Database = !string.IsNullOrEmpty(c.Database) ? c.Database : (defaultDb ?? "postgres"),
            Timeout = 8,
        };
        if (c.Ssl)
        {
            b.SslMode = SslMode.Require;
            b.TrustServerCertificate = true;  // accept managed cert without bundling CA
        }
        return b.ConnectionString;
    }

    public async Task<TestResult> TestConnectionAsync(DbConnectionInfo conn)
    {
        try
        {
            // Default to 'postgres' DB so we can connect without a target picked yet.
            await using var c = new NpgsqlConnection(ConnString(conn, "postgres"));
            await c.OpenAsync();
            string version;
            await using (var cmd = new NpgsqlCommand("SELECT version()", c))
                version = (await cmd.ExecuteScalarAsync())?.ToString() ?? "";

            var dbs = new List<string>();
            await using (var cmd = new NpgsqlCommand(
                "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname", c))
            await using (var rd = await cmd.ExecuteReaderAsync())
                while (await rd.ReadAsync()) dbs.Add(rd.GetString(0));

            return new TestResult { Ok = true, Version = version, Databases = dbs };
        }
        catch (Exception ex) { return new TestResult { Ok = false, Error = ex.Message }; }
    }

    public async Task<List<TableInfo>> ListTablesAsync(DbConnectionInfo conn)
    {
        var list = new List<TableInfo>();
        await using var c = new NpgsqlConnection(ConnString(conn));
        await c.OpenAsync();
        await using var cmd = new NpgsqlCommand(
            @"SELECT table_schema || '.' || table_name AS name,
                     (SELECT reltuples::bigint FROM pg_class WHERE oid = (table_schema||'.'||table_name)::regclass) AS rows
              FROM information_schema.tables
              WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')
              ORDER BY table_schema, table_name", c);
        await using var rd = await cmd.ExecuteReaderAsync();
        while (await rd.ReadAsync())
            list.Add(new TableInfo { Name = rd.GetString(0), RowEstimate = rd.IsDBNull(1) ? null : rd.GetInt64(1) });
        return list;
    }

    private static async Task<string> GetTableDDLAsync(NpgsqlConnection c, string schema, string table)
    {
        var cols = new List<(string Name, string Type, int? CharLen, int? NumPrec, int? NumScale, bool Nullable, string? Default)>();
        await using (var cmd = new NpgsqlCommand(
            @"SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale,
                     is_nullable, column_default
              FROM information_schema.columns
              WHERE table_schema = @s AND table_name = @t ORDER BY ordinal_position", c))
        {
            cmd.Parameters.AddWithValue("@s", schema);
            cmd.Parameters.AddWithValue("@t", table);
            await using var rd = await cmd.ExecuteReaderAsync();
            while (await rd.ReadAsync())
                cols.Add((rd.GetString(0), rd.GetString(1),
                    rd.IsDBNull(2) ? null : rd.GetInt32(2),
                    rd.IsDBNull(3) ? null : rd.GetInt32(3),
                    rd.IsDBNull(4) ? null : rd.GetInt32(4),
                    rd.GetString(5) == "YES",
                    rd.IsDBNull(6) ? null : rd.GetString(6)));
        }

        var pk = new List<string>();
        await using (var cmd = new NpgsqlCommand(
            @"SELECT a.attname FROM pg_index i
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
              WHERE i.indrelid = (@s || '.' || @t)::regclass AND i.indisprimary
              ORDER BY array_position(i.indkey, a.attnum)", c))
        {
            cmd.Parameters.AddWithValue("@s", schema);
            cmd.Parameters.AddWithValue("@t", table);
            await using var rd = await cmd.ExecuteReaderAsync();
            while (await rd.ReadAsync()) pk.Add(rd.GetString(0));
        }

        var lines = new List<string>();
        foreach (var col in cols)
        {
            var type = col.Type;
            if (col.CharLen.HasValue) type += $"({col.CharLen})";
            else if (col.Type == "numeric" && col.NumPrec.HasValue) type += $"({col.NumPrec},{col.NumScale ?? 0})";
            var line = $"  {DoubleQuote(col.Name)} {type}";
            if (col.Default != null) line += $" DEFAULT {col.Default}";
            if (!col.Nullable) line += " NOT NULL";
            lines.Add(line);
        }
        if (pk.Count > 0)
            lines.Add($"  PRIMARY KEY ({string.Join(", ", pk.Select(DoubleQuote))})");

        return $"CREATE TABLE {DoubleQuote(schema)}.{DoubleQuote(table)} (\n{string.Join(",\n", lines)}\n)";
    }

    private static async Task DumpTableDataAsync(NpgsqlConnection c, string schema, string table, StreamWriter w, Action<string>? onProgress, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand($"SELECT * FROM {DoubleQuote(schema)}.{DoubleQuote(table)}", c);
        cmd.CommandTimeout = 0;
        await using var rd = await cmd.ExecuteReaderAsync(CommandBehavior.SequentialAccess, ct);
        if (rd.FieldCount == 0) return;

        var cols = new string[rd.FieldCount];
        for (int i = 0; i < rd.FieldCount; i++) cols[i] = DoubleQuote(rd.GetName(i));
        var columnsLine = "(" + string.Join(",", cols) + ")";

        var batch = new List<string>(500);
        long batchBytes = 0; long n = 0;
        const int MAX_BATCH = 500, MAX_BYTES = 512 * 1024;

        async Task Flush()
        {
            if (batch.Count == 0) return;
            await w.WriteAsync($"INSERT INTO {DoubleQuote(schema)}.{DoubleQuote(table)} {columnsLine} VALUES\n");
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
            if (batch.Count >= MAX_BATCH || batchBytes >= MAX_BYTES) await Flush();
            if (n % 5000 == 0) onProgress?.Invoke($"  {schema}.{table}: {n} rows...");
        }
        await Flush();
        await w.WriteLineAsync();
        onProgress?.Invoke($"  {schema}.{table}: {n} rows done");
    }

    public async Task DumpAsync(DbConnectionInfo conn, ExportOptions options, string outFilePath, Action<string>? onProgress, CancellationToken ct)
    {
        await using var c = new NpgsqlConnection(ConnString(conn));
        await c.OpenAsync(ct);
        await using var fs = File.Create(outFilePath);
        await using var w = new StreamWriter(fs, new System.Text.UTF8Encoding(false));

        await w.WriteLineAsync("-- DB Migrator dump (PostgreSQL)");
        await w.WriteLineAsync($"-- Database: {conn.Database}");
        await w.WriteLineAsync($"-- Generated: {DateTime.UtcNow:O}");
        await w.WriteLineAsync();

        var tables = new List<(string Schema, string Table)>();
        if (options.Tables is { Count: > 0 })
        {
            foreach (var t in options.Tables)
            {
                var parts = t.Split('.', 2);
                tables.Add(parts.Length == 2 ? (parts[0], parts[1]) : ("public", parts[0]));
            }
        }
        else
        {
            await using var cmd = new NpgsqlCommand(
                @"SELECT table_schema, table_name FROM information_schema.tables
                  WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')
                  ORDER BY table_schema, table_name", c);
            await using var rd = await cmd.ExecuteReaderAsync(ct);
            while (await rd.ReadAsync(ct)) tables.Add((rd.GetString(0), rd.GetString(1)));
        }

        onProgress?.Invoke($"Dumping {tables.Count} table(s)");

        foreach (var (schema, table) in tables)
        {
            ct.ThrowIfCancellationRequested();
            onProgress?.Invoke($"> {schema}.{table}");
            if (!options.NoSchema)
            {
                await w.WriteLineAsync($"\n-- Table: {schema}.{table}");
                await w.WriteLineAsync($"DROP TABLE IF EXISTS {DoubleQuote(schema)}.{DoubleQuote(table)} CASCADE;");
                await w.WriteLineAsync(await GetTableDDLAsync(c, schema, table) + ";");
                await w.WriteLineAsync();
            }
            if (!options.NoData)
            {
                await using var dataConn = new NpgsqlConnection(ConnString(conn));
                await dataConn.OpenAsync(ct);
                await DumpTableDataAsync(dataConn, schema, table, w, onProgress, ct);
            }
        }

        // ===== DDL extras: FK / secondary indexes / triggers =====
        if (!options.NoSchema)
        {
            onProgress?.Invoke("Adding FK / indexes / triggers");
            await DumpExtrasAsync(c, tables, w, onProgress, ct);
            onProgress?.Invoke("Adding sequences / views / functions / procedures");
            await DumpRoutinesAsync(c, w, onProgress, ct);
        }
        onProgress?.Invoke("Done");
    }

    // FK / indexes / triggers — done AFTER data inserted so FK don't block restore ordering.
    private static async Task DumpExtrasAsync(
        NpgsqlConnection c, List<(string Schema, string Table)> tables,
        StreamWriter w, Action<string>? onProgress, CancellationToken ct)
    {
        if (tables.Count == 0) return;
        var tuples = string.Join(",", tables.Select(t => $"({EscapeAnsi(t.Schema)}, {EscapeAnsi(t.Table)})"));

        // 1. Foreign keys
        try
        {
            int n = 0;
            await using var cmd = new NpgsqlCommand($@"
                SELECT n.nspname, cl.relname, co.conname, pg_get_constraintdef(co.oid)
                FROM pg_constraint co
                JOIN pg_class cl ON cl.oid = co.conrelid
                JOIN pg_namespace n ON n.oid = cl.relnamespace
                WHERE co.contype = 'f' AND (n.nspname, cl.relname) IN ({tuples})
                ORDER BY n.nspname, cl.relname, co.conname", c);
            var rows = new List<(string s, string t, string name, string def)>();
            await using (var rd = await cmd.ExecuteReaderAsync(ct))
                while (await rd.ReadAsync(ct))
                    rows.Add((rd.GetString(0), rd.GetString(1), rd.GetString(2), rd.GetString(3)));
            if (rows.Count > 0)
            {
                await w.WriteLineAsync($"\n-- ----------------------------\n-- Foreign keys ({rows.Count})\n-- ----------------------------");
                foreach (var r in rows)
                {
                    await w.WriteLineAsync($"ALTER TABLE {DoubleQuote(r.s)}.{DoubleQuote(r.t)} ADD CONSTRAINT {DoubleQuote(r.name)} {r.def};");
                    n++;
                }
                onProgress?.Invoke($"  {n} foreign key(s)");
            }
        }
        catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped FK dump: {ex.Message})"); }

        // 2. Secondary indexes
        try
        {
            int n = 0;
            await using var cmd = new NpgsqlCommand($@"
                SELECT indexdef FROM pg_indexes
                WHERE (schemaname, tablename) IN ({tuples})
                  AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE contype IN ('p','u'))
                ORDER BY schemaname, tablename, indexname", c);
            var defs = new List<string>();
            await using (var rd = await cmd.ExecuteReaderAsync(ct))
                while (await rd.ReadAsync(ct)) defs.Add(rd.GetString(0));
            if (defs.Count > 0)
            {
                await w.WriteLineAsync($"\n-- ----------------------------\n-- Secondary indexes ({defs.Count})\n-- ----------------------------");
                foreach (var def in defs) { await w.WriteLineAsync($"{def};"); n++; }
                onProgress?.Invoke($"  {n} index(es)");
            }
        }
        catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped index dump: {ex.Message})"); }

        // 3. Triggers
        try
        {
            int n = 0;
            await using var cmd = new NpgsqlCommand($@"
                SELECT pg_get_triggerdef(tg.oid, true)
                FROM pg_trigger tg
                JOIN pg_class cl ON cl.oid = tg.tgrelid
                JOIN pg_namespace ns ON ns.oid = cl.relnamespace
                WHERE NOT tg.tgisinternal AND (ns.nspname, cl.relname) IN ({tuples})
                ORDER BY ns.nspname, cl.relname, tg.tgname", c);
            var defs = new List<string>();
            await using (var rd = await cmd.ExecuteReaderAsync(ct))
                while (await rd.ReadAsync(ct)) defs.Add(rd.GetString(0));
            if (defs.Count > 0)
            {
                await w.WriteLineAsync($"\n-- ----------------------------\n-- Triggers ({defs.Count})\n-- ----------------------------");
                foreach (var def in defs) { await w.WriteLineAsync($"{def};"); n++; }
                onProgress?.Invoke($"  {n} trigger(s)");
            }
        }
        catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped trigger dump: {ex.Message})"); }
    }

    // PG-specific: dump sequences, views, functions, procedures. Functions / procedures
    // bodies are wrapped in ROUTINE markers so restore handles them as single statements
    // even when their body contains `;`.
    private static async Task DumpRoutinesAsync(NpgsqlConnection c, StreamWriter w, Action<string>? onProgress, CancellationToken ct)
    {
        // Sequences
        try
        {
            var seqs = new List<(string Schema, string Name)>();
            await using (var cmd = new NpgsqlCommand(@"
                SELECT n.nspname, cl.relname
                FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
                WHERE cl.relkind = 'S' AND n.nspname NOT IN ('pg_catalog','information_schema')
                ORDER BY n.nspname, cl.relname", c))
            await using (var rd = await cmd.ExecuteReaderAsync(ct))
                while (await rd.ReadAsync(ct)) seqs.Add((rd.GetString(0), rd.GetString(1)));

            if (seqs.Count > 0)
            {
                await w.WriteLineAsync($"\n-- ----------------------------\n-- Sequences ({seqs.Count})\n-- ----------------------------");
                foreach (var (schema, name) in seqs)
                {
                    try
                    {
                        await using var meta = new NpgsqlCommand(@"
                            SELECT increment, minimum_value, maximum_value, start_value, cache_size, cycle_option, data_type
                            FROM information_schema.sequences WHERE sequence_schema = @s AND sequence_name = @n", c);
                        meta.Parameters.AddWithValue("@s", schema);
                        meta.Parameters.AddWithValue("@n", name);
                        await using var rd = await meta.ExecuteReaderAsync(ct);
                        if (!await rd.ReadAsync(ct)) continue;
                        string increment = rd.GetValue(0).ToString()!;
                        string minVal = rd.GetValue(1).ToString()!;
                        string maxVal = rd.GetValue(2).ToString()!;
                        string startVal = rd.GetValue(3).ToString()!;
                        string cache = rd.GetValue(4).ToString()!;
                        string cycle = rd.GetString(5) == "YES" ? "CYCLE" : "NO CYCLE";
                        string dt = rd.GetString(6);
                        await rd.CloseAsync();

                        var fq = $"{DoubleQuote(schema)}.{DoubleQuote(name)}";
                        await w.WriteLineAsync($"DROP SEQUENCE IF EXISTS {fq} CASCADE;");
                        await w.WriteLineAsync($"CREATE SEQUENCE {fq} AS {dt} INCREMENT BY {increment} MINVALUE {minVal} MAXVALUE {maxVal} START WITH {startVal} CACHE {cache} {cycle};");

                        await using var lastCmd = new NpgsqlCommand($"SELECT last_value, is_called FROM {fq}", c);
                        await using var lastRd = await lastCmd.ExecuteReaderAsync(ct);
                        if (await lastRd.ReadAsync(ct))
                        {
                            var last = lastRd.GetValue(0);
                            var called = lastRd.GetBoolean(1) ? "true" : "false";
                            await w.WriteLineAsync($"SELECT setval('{schema}.{name}', {last}, {called});");
                        }
                    }
                    catch (Exception ex) { await w.WriteLineAsync($"-- (sequence {schema}.{name} skipped: {ex.Message})"); }
                }
                onProgress?.Invoke($"  {seqs.Count} sequence(s)");
            }
        }
        catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped sequence dump: {ex.Message})"); }

        // Views
        try
        {
            var views = new List<(string Schema, string Name, string Def)>();
            await using (var cmd = new NpgsqlCommand(@"
                SELECT schemaname, viewname, definition FROM pg_views
                WHERE schemaname NOT IN ('pg_catalog','information_schema')
                ORDER BY schemaname, viewname", c))
            await using (var rd = await cmd.ExecuteReaderAsync(ct))
                while (await rd.ReadAsync(ct)) views.Add((rd.GetString(0), rd.GetString(1), rd.GetString(2)));

            if (views.Count > 0)
            {
                await w.WriteLineAsync($"\n-- ----------------------------\n-- Views ({views.Count})\n-- ----------------------------");
                foreach (var (schema, name, def) in views)
                {
                    await w.WriteLineAsync($"DROP VIEW IF EXISTS {DoubleQuote(schema)}.{DoubleQuote(name)} CASCADE;");
                    await w.WriteLineAsync($"CREATE VIEW {DoubleQuote(schema)}.{DoubleQuote(name)} AS\n{def};");
                    await w.WriteLineAsync();
                }
                onProgress?.Invoke($"  {views.Count} view(s)");
            }
        }
        catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped view dump: {ex.Message})"); }

        // Functions + procedures
        try
        {
            var fns = new List<(string Schema, string Name, char Kind, string Def)>();
            await using (var cmd = new NpgsqlCommand(@"
                SELECT n.nspname, p.proname, p.prokind, pg_get_functiondef(p.oid)
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname NOT IN ('pg_catalog','information_schema')
                  AND p.prokind IN ('f','p')
                ORDER BY p.prokind, n.nspname, p.proname", c))
            await using (var rd = await cmd.ExecuteReaderAsync(ct))
                while (await rd.ReadAsync(ct))
                    fns.Add((rd.GetString(0), rd.GetString(1), rd.GetChar(2), rd.GetString(3)));

            var funcs = fns.Where(x => x.Kind == 'f').ToList();
            var procs = fns.Where(x => x.Kind == 'p').ToList();
            if (funcs.Count > 0)
            {
                await w.WriteLineAsync($"\n-- ----------------------------\n-- Functions ({funcs.Count})\n-- ----------------------------");
                foreach (var (schema, name, _, def) in funcs)
                {
                    await w.WriteLineAsync($"{SqlHelpers.RoutineBegin} function {schema}.{name}");
                    await w.WriteLineAsync(def);
                    await w.WriteLineAsync(SqlHelpers.RoutineEnd);
                    await w.WriteLineAsync();
                }
                onProgress?.Invoke($"  {funcs.Count} function(s)");
            }
            if (procs.Count > 0)
            {
                await w.WriteLineAsync($"\n-- ----------------------------\n-- Procedures ({procs.Count})\n-- ----------------------------");
                foreach (var (schema, name, _, def) in procs)
                {
                    await w.WriteLineAsync($"{SqlHelpers.RoutineBegin} procedure {schema}.{name}");
                    await w.WriteLineAsync(def);
                    await w.WriteLineAsync(SqlHelpers.RoutineEnd);
                    await w.WriteLineAsync();
                }
                onProgress?.Invoke($"  {procs.Count} procedure(s)");
            }
        }
        catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped function/procedure dump: {ex.Message})"); }
    }

    public async Task RestoreAsync(DbConnectionInfo conn, string sqlFilePath, Action<string>? onProgress, CancellationToken ct)
    {
        await using var c = new NpgsqlConnection(ConnString(conn));
        await c.OpenAsync(ct);
        var sql = await File.ReadAllTextAsync(sqlFilePath, ct);

        // Routine bodies wrapped in ROUTINE_BEGIN/END are sent as single statements.
        // Everything else still goes through the per-statement splitter.
        var blocks = SqlHelpers.ExtractRoutineBlocks(sql).ToList();
        int total = 0;
        foreach (var b in blocks)
            total += b.Kind == SqlHelpers.BlockKind.Sql ? SplitSqlStatements(b.Body, '"').Count() : 1;
        onProgress?.Invoke($"Executing {total} statements...");

        int n = 0;
        foreach (var b in blocks)
        {
            ct.ThrowIfCancellationRequested();
            if (b.Kind == SqlHelpers.BlockKind.Routine)
            {
                var body = b.Body.TrimEnd(';', ' ', '\t', '\r', '\n');
                if (body.Length == 0) continue;
                await using var cmd = new NpgsqlCommand(body, c) { CommandTimeout = 600 };
                await cmd.ExecuteNonQueryAsync(ct);
                n++;
            }
            else
            {
                foreach (var s in SplitSqlStatements(b.Body, '"'))
                {
                    ct.ThrowIfCancellationRequested();
                    await using var cmd = new NpgsqlCommand(s, c) { CommandTimeout = 600 };
                    await cmd.ExecuteNonQueryAsync(ct);
                    n++;
                    if (n % 50 == 0) onProgress?.Invoke($"  {n}/{total}");
                }
            }
        }
        onProgress?.Invoke($"Restore complete ({n} statements)");
    }

    public List<string> ParseTableNamesFromDump(string sqlFilePath) =>
        SqlHelpers.ParseTableNamesFromDump(sqlFilePath, '"');
}
