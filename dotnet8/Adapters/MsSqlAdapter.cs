using System.Data;
using DbMigrator.Web.Models;
using Microsoft.Data.SqlClient;
using static DbMigrator.Web.Adapters.SqlHelpers;

namespace DbMigrator.Web.Adapters;

public class MsSqlAdapter : IDatabaseAdapter
{
    public string Type => "mssql";

    private static readonly FormatOptions Fmt = new()
    {
        EscapeString = EscapeNPrefix,
        FormatBinary = b => "0x" + Convert.ToHexString(b),
        BoolAs01 = true,
    };

    // SqlClient's DataSource accepts "HOST", "HOST\INSTANCE", "HOST,PORT", "HOST\INSTANCE,PORT" natively,
    // so we mostly pass the raw Host through. We only append Port if Host is plain HOST and Port > 0.
    private static string BuildDataSource(DbConnectionInfo c)
    {
        var host = c.Host ?? "";
        if (host.Contains('\\') || host.Contains(',')) return host;
        return c.Port > 0 ? $"{host},{c.Port}" : host;
    }

    private static string ConnString(DbConnectionInfo c)
    {
        var b = new SqlConnectionStringBuilder
        {
            DataSource = BuildDataSource(c),
            InitialCatalog = string.IsNullOrEmpty(c.Database) ? "master" : c.Database,
            ConnectTimeout = 15,
            Encrypt = false,
            TrustServerCertificate = true,
        };

        if (string.Equals(c.AuthMode, "windows", StringComparison.OrdinalIgnoreCase))
        {
            // Use the identity that started the dotnet process (typical for local SQLEXPRESS use).
            b.IntegratedSecurity = true;
        }
        else
        {
            b.UserID = c.User;
            b.Password = c.Password;
        }
        return b.ConnectionString;
    }

    public async Task<TestResult> TestConnectionAsync(DbConnectionInfo conn)
    {
        try
        {
            // ConnString defaults to 'master' if Database empty, so we connect without a target.
            await using var c = new SqlConnection(ConnString(conn));
            await c.OpenAsync();
            string version;
            await using (var cmd = new SqlCommand("SELECT @@VERSION", c))
                version = ((await cmd.ExecuteScalarAsync())?.ToString() ?? "").Split('\n')[0].Trim();

            var dbs = new List<string>();
            await using (var cmd = new SqlCommand(
                "SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name", c))
            await using (var rd = await cmd.ExecuteReaderAsync())
                while (await rd.ReadAsync()) dbs.Add(rd.GetString(0));

            return new TestResult { Ok = true, Version = version, Databases = dbs };
        }
        catch (Exception ex)
        {
            // Tease out the most useful message from possibly-nested SqlException.
            var msg = ex.Message;
            if (ex is SqlException sqlEx && sqlEx.Errors.Count > 0)
                msg = sqlEx.Errors[0].Message;
            return new TestResult { Ok = false, Error = msg };
        }
    }

    public async Task<List<TableInfo>> ListTablesAsync(DbConnectionInfo conn)
    {
        var list = new List<TableInfo>();
        await using var c = new SqlConnection(ConnString(conn));
        await c.OpenAsync();
        await using var cmd = new SqlCommand(
            @"SELECT s.name + '.' + t.name AS name, p.rows
              FROM sys.tables t
              JOIN sys.schemas s ON s.schema_id = t.schema_id
              LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
              ORDER BY s.name, t.name", c);
        await using var rd = await cmd.ExecuteReaderAsync();
        while (await rd.ReadAsync())
            list.Add(new TableInfo { Name = rd.GetString(0), RowEstimate = rd.IsDBNull(1) ? null : rd.GetInt64(1) });
        return list;
    }

    private static async Task<string> GetTableDDLAsync(SqlConnection c, string schema, string table)
    {
        var cols = new List<(string Name, string Type, int MaxLen, byte Prec, byte Scale, bool Nullable, string? Default, bool Identity)>();
        await using (var cmd = new SqlCommand(
            @"SELECT col.name, ty.name, col.max_length, col.precision, col.scale, col.is_nullable,
                     dc.definition, col.is_identity
              FROM sys.columns col
              JOIN sys.types ty ON ty.user_type_id = col.user_type_id
              LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = col.object_id AND dc.parent_column_id = col.column_id
              WHERE col.object_id = OBJECT_ID(@s + '.' + @t) ORDER BY col.column_id", c))
        {
            cmd.Parameters.AddWithValue("@s", schema);
            cmd.Parameters.AddWithValue("@t", table);
            await using var rd = await cmd.ExecuteReaderAsync();
            while (await rd.ReadAsync())
                cols.Add((rd.GetString(0), rd.GetString(1), rd.GetInt16(2), rd.GetByte(3), rd.GetByte(4),
                    rd.GetBoolean(5), rd.IsDBNull(6) ? null : rd.GetString(6), rd.GetBoolean(7)));
        }

        var pk = new List<string>();
        await using (var cmd = new SqlCommand(
            @"SELECT col.name FROM sys.indexes i
              JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
              JOIN sys.columns col ON col.object_id=ic.object_id AND col.column_id=ic.column_id
              WHERE i.object_id = OBJECT_ID(@s + '.' + @t) AND i.is_primary_key = 1
              ORDER BY ic.key_ordinal", c))
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
            if (type is "nvarchar" or "nchar")
                type += $"({(col.MaxLen == -1 ? "MAX" : (col.MaxLen / 2).ToString())})";
            else if (type is "varchar" or "char" or "varbinary" or "binary")
                type += $"({(col.MaxLen == -1 ? "MAX" : col.MaxLen.ToString())})";
            else if (type is "decimal" or "numeric")
                type += $"({col.Prec},{col.Scale})";

            var line = $"  {Bracket(col.Name)} {type}";
            if (col.Identity) line += " IDENTITY(1,1)";
            if (col.Default != null) line += $" DEFAULT {col.Default}";
            line += col.Nullable ? " NULL" : " NOT NULL";
            lines.Add(line);
        }
        if (pk.Count > 0)
            lines.Add($"  CONSTRAINT {Bracket("PK_" + table)} PRIMARY KEY ({string.Join(", ", pk.Select(n => Bracket(n)))})");

        return $"CREATE TABLE {Bracket(schema)}.{Bracket(table)} (\n{string.Join(",\n", lines)}\n)";
    }

    private static async Task DumpTableDataAsync(SqlConnection c, string schema, string table, StreamWriter w, Action<string>? onProgress, CancellationToken ct)
    {
        await using var cmd = new SqlCommand($"SELECT * FROM {Bracket(schema)}.{Bracket(table)}", c) { CommandTimeout = 0 };
        await using var rd = await cmd.ExecuteReaderAsync(CommandBehavior.SequentialAccess, ct);
        if (rd.FieldCount == 0) return;

        var cols = new string[rd.FieldCount];
        for (int i = 0; i < rd.FieldCount; i++) cols[i] = Bracket(rd.GetName(i));
        var columnsLine = "(" + string.Join(",", cols) + ")";

        var batch = new List<string>(500);
        long batchBytes = 0; long n = 0;

        async Task Flush()
        {
            if (batch.Count == 0) return;
            await w.WriteAsync($"INSERT INTO {Bracket(schema)}.{Bracket(table)} {columnsLine} VALUES\n");
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
            if (n % 5000 == 0) onProgress?.Invoke($"  {schema}.{table}: {n} rows...");
        }
        await Flush();
        await w.WriteLineAsync();
        onProgress?.Invoke($"  {schema}.{table}: {n} rows done");
    }

    public async Task DumpAsync(DbConnectionInfo conn, ExportOptions options, string outFilePath, Action<string>? onProgress, CancellationToken ct)
    {
        await using var c = new SqlConnection(ConnString(conn));
        await c.OpenAsync(ct);
        await using var fs = File.Create(outFilePath);
        await using var w = new StreamWriter(fs, new System.Text.UTF8Encoding(false));

        await w.WriteLineAsync("-- DB Migrator dump (SQL Server)");
        await w.WriteLineAsync($"-- Database: {conn.Database}");
        await w.WriteLineAsync($"-- Generated: {DateTime.UtcNow:O}");
        await w.WriteLineAsync();

        var tables = new List<(string Schema, string Table)>();
        if (options.Tables is { Count: > 0 })
        {
            foreach (var t in options.Tables)
            {
                var parts = t.Split('.', 2);
                tables.Add(parts.Length == 2 ? (parts[0], parts[1]) : ("dbo", parts[0]));
            }
        }
        else
        {
            await using var cmd = new SqlCommand(
                @"SELECT s.name, t.name FROM sys.tables t
                  JOIN sys.schemas s ON s.schema_id = t.schema_id ORDER BY s.name, t.name", c);
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
                await w.WriteLineAsync($"IF OBJECT_ID('{schema}.{table}', 'U') IS NOT NULL DROP TABLE {Bracket(schema)}.{Bracket(table)};");
                await w.WriteLineAsync("GO");
                await w.WriteLineAsync(await GetTableDDLAsync(c, schema, table) + ";");
                await w.WriteLineAsync("GO");
                await w.WriteLineAsync();
            }
            if (!options.NoData)
            {
                await using var dataConn = new SqlConnection(ConnString(conn));
                await dataConn.OpenAsync(ct);
                await DumpTableDataAsync(dataConn, schema, table, w, onProgress, ct);
            }
        }

        if (!options.NoSchema)
        {
            onProgress?.Invoke("Adding FK / indexes / triggers");
            await DumpMsSqlExtrasAsync(c, tables, w, onProgress, ct);
            onProgress?.Invoke("Adding views / procedures / functions");
            await DumpMsSqlRoutinesAsync(c, w, onProgress, ct);
        }
        onProgress?.Invoke("Done");
    }

    private static async Task DumpMsSqlExtrasAsync(SqlConnection c, List<(string Schema, string Table)> tables,
        StreamWriter w, Action<string>? onProgress, CancellationToken ct)
    {
        if (tables.Count == 0) return;
        var fqns = string.Join(",", tables.Select(t => $"'{t.Schema}.{t.Table}'"));

        // 1. Foreign keys
        try
        {
            var fkSql = $@"
              SELECT s.name, t.name, fk.name,
                     rs.name, rt.name,
                     STUFF((SELECT ',' + QUOTENAME(c.name) FROM sys.foreign_key_columns fkc
                            JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
                            WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id FOR XML PATH('')), 1, 1, ''),
                     STUFF((SELECT ',' + QUOTENAME(c.name) FROM sys.foreign_key_columns fkc
                            JOIN sys.columns c ON c.object_id = fkc.referenced_object_id AND c.column_id = fkc.referenced_column_id
                            WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id FOR XML PATH('')), 1, 1, '')
              FROM sys.foreign_keys fk
              JOIN sys.tables t ON t.object_id = fk.parent_object_id
              JOIN sys.schemas s ON s.schema_id = t.schema_id
              JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
              JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
              WHERE s.name + '.' + t.name IN ({fqns})
              ORDER BY s.name, t.name, fk.name";
            var rows = new List<(string s, string t, string name, string rs, string rt, string pcols, string rcols)>();
            await using (var cmd = new SqlCommand(fkSql, c))
            await using (var rd = await cmd.ExecuteReaderAsync(ct))
                while (await rd.ReadAsync(ct))
                    rows.Add((rd.GetString(0), rd.GetString(1), rd.GetString(2), rd.GetString(3), rd.GetString(4), rd.GetString(5), rd.GetString(6)));
            if (rows.Count > 0)
            {
                await w.WriteLineAsync($"\n-- ----------------------------\n-- Foreign keys ({rows.Count})\n-- ----------------------------");
                foreach (var r in rows)
                {
                    await w.WriteLineAsync($"ALTER TABLE {Bracket(r.s)}.{Bracket(r.t)} ADD CONSTRAINT {Bracket(r.name)} FOREIGN KEY ({r.pcols}) REFERENCES {Bracket(r.rs)}.{Bracket(r.rt)} ({r.rcols});");
                    await w.WriteLineAsync("GO");
                }
                onProgress?.Invoke($"  {rows.Count} foreign key(s)");
            }
        }
        catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped FK dump: {ex.Message})"); }

        // 2. Secondary indexes
        try
        {
            var idxSql = $@"
              SELECT s.name, t.name, i.name, i.is_unique,
                     STUFF((SELECT ',' + QUOTENAME(c.name) + CASE WHEN ic.is_descending_key=1 THEN ' DESC' ELSE '' END
                            FROM sys.index_columns ic
                            JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                            WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
                            ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 1, '')
              FROM sys.indexes i
              JOIN sys.tables t ON t.object_id = i.object_id
              JOIN sys.schemas s ON s.schema_id = t.schema_id
              WHERE i.type > 0 AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
                AND s.name + '.' + t.name IN ({fqns})
              ORDER BY s.name, t.name, i.name";
            var rows = new List<(string s, string t, string n, bool u, string cols)>();
            await using (var cmd = new SqlCommand(idxSql, c))
            await using (var rd = await cmd.ExecuteReaderAsync(ct))
                while (await rd.ReadAsync(ct))
                    rows.Add((rd.GetString(0), rd.GetString(1), rd.GetString(2), rd.GetBoolean(3), rd.GetString(4)));
            if (rows.Count > 0)
            {
                await w.WriteLineAsync($"\n-- ----------------------------\n-- Secondary indexes ({rows.Count})\n-- ----------------------------");
                foreach (var r in rows)
                {
                    var uniq = r.u ? "UNIQUE " : "";
                    await w.WriteLineAsync($"CREATE {uniq}INDEX {Bracket(r.n)} ON {Bracket(r.s)}.{Bracket(r.t)} ({r.cols});");
                    await w.WriteLineAsync("GO");
                }
                onProgress?.Invoke($"  {rows.Count} index(es)");
            }
        }
        catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped index dump: {ex.Message})"); }

        // 3. Triggers
        try
        {
            var trigSql = $@"
              SELECT s.name, t.name, tr.name, OBJECT_DEFINITION(tr.object_id)
              FROM sys.triggers tr
              JOIN sys.tables t ON t.object_id = tr.parent_id
              JOIN sys.schemas s ON s.schema_id = t.schema_id
              WHERE s.name + '.' + t.name IN ({fqns}) AND tr.is_ms_shipped = 0
              ORDER BY s.name, t.name, tr.name";
            var rows = new List<(string s, string t, string n, string body)>();
            await using (var cmd = new SqlCommand(trigSql, c))
            await using (var rd = await cmd.ExecuteReaderAsync(ct))
                while (await rd.ReadAsync(ct))
                {
                    if (!rd.IsDBNull(3)) rows.Add((rd.GetString(0), rd.GetString(1), rd.GetString(2), rd.GetString(3)));
                }
            if (rows.Count > 0)
            {
                await w.WriteLineAsync($"\n-- ----------------------------\n-- Triggers ({rows.Count})\n-- ----------------------------");
                foreach (var r in rows)
                {
                    await w.WriteLineAsync($"IF OBJECT_ID('{r.s}.{r.n}', 'TR') IS NOT NULL DROP TRIGGER {Bracket(r.s)}.{Bracket(r.n)};");
                    await w.WriteLineAsync("GO");
                    await w.WriteLineAsync(r.body.Trim());
                    await w.WriteLineAsync("GO");
                }
                onProgress?.Invoke($"  {rows.Count} trigger(s)");
            }
        }
        catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped trigger dump: {ex.Message})"); }
    }

    // Views + procedures + functions for SQL Server. Each object's body comes from
    // OBJECT_DEFINITION as a complete CREATE statement. GO separators isolate each
    // batch — the existing MSSQL restore (SplitMsSqlBatches) already understands them.
    private static async Task DumpMsSqlRoutinesAsync(SqlConnection c, StreamWriter w, Action<string>? onProgress, CancellationToken ct)
    {
        // Views
        try
        {
            var rows = new List<(string s, string n, string body)>();
            await using (var cmd = new SqlCommand(@"
                SELECT s.name, v.name, OBJECT_DEFINITION(v.object_id)
                FROM sys.views v JOIN sys.schemas s ON s.schema_id = v.schema_id
                WHERE v.is_ms_shipped = 0 ORDER BY s.name, v.name", c))
            await using (var rd = await cmd.ExecuteReaderAsync(ct))
                while (await rd.ReadAsync(ct))
                    if (!rd.IsDBNull(2)) rows.Add((rd.GetString(0), rd.GetString(1), rd.GetString(2)));
            if (rows.Count > 0)
            {
                await w.WriteLineAsync($"\n-- ----------------------------\n-- Views ({rows.Count})\n-- ----------------------------");
                foreach (var r in rows)
                {
                    await w.WriteLineAsync($"IF OBJECT_ID('{r.s}.{r.n}', 'V') IS NOT NULL DROP VIEW {Bracket(r.s)}.{Bracket(r.n)};");
                    await w.WriteLineAsync("GO");
                    await w.WriteLineAsync(r.body.Trim());
                    await w.WriteLineAsync("GO");
                    await w.WriteLineAsync();
                }
                onProgress?.Invoke($"  {rows.Count} view(s)");
            }
        }
        catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped view dump: {ex.Message})"); }

        // Stored procedures
        try
        {
            var rows = new List<(string s, string n, string body)>();
            await using (var cmd = new SqlCommand(@"
                SELECT s.name, p.name, OBJECT_DEFINITION(p.object_id)
                FROM sys.procedures p JOIN sys.schemas s ON s.schema_id = p.schema_id
                WHERE p.is_ms_shipped = 0 ORDER BY s.name, p.name", c))
            await using (var rd = await cmd.ExecuteReaderAsync(ct))
                while (await rd.ReadAsync(ct))
                    if (!rd.IsDBNull(2)) rows.Add((rd.GetString(0), rd.GetString(1), rd.GetString(2)));
            if (rows.Count > 0)
            {
                await w.WriteLineAsync($"\n-- ----------------------------\n-- Stored procedures ({rows.Count})\n-- ----------------------------");
                foreach (var r in rows)
                {
                    await w.WriteLineAsync($"IF OBJECT_ID('{r.s}.{r.n}', 'P') IS NOT NULL DROP PROCEDURE {Bracket(r.s)}.{Bracket(r.n)};");
                    await w.WriteLineAsync("GO");
                    await w.WriteLineAsync(r.body.Trim());
                    await w.WriteLineAsync("GO");
                    await w.WriteLineAsync();
                }
                onProgress?.Invoke($"  {rows.Count} procedure(s)");
            }
        }
        catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped procedure dump: {ex.Message})"); }

        // Functions (FN scalar, IF inline TVF, TF multi-stmt TVF, FS CLR, FT CLR TVF)
        try
        {
            var rows = new List<(string s, string n, string body)>();
            await using (var cmd = new SqlCommand(@"
                SELECT s.name, o.name, OBJECT_DEFINITION(o.object_id)
                FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
                WHERE o.type IN ('FN','IF','TF','FS','FT') AND o.is_ms_shipped = 0
                ORDER BY s.name, o.name", c))
            await using (var rd = await cmd.ExecuteReaderAsync(ct))
                while (await rd.ReadAsync(ct))
                    if (!rd.IsDBNull(2)) rows.Add((rd.GetString(0), rd.GetString(1), rd.GetString(2)));
            if (rows.Count > 0)
            {
                await w.WriteLineAsync($"\n-- ----------------------------\n-- Functions ({rows.Count})\n-- ----------------------------");
                foreach (var r in rows)
                {
                    await w.WriteLineAsync($"IF OBJECT_ID('{r.s}.{r.n}') IS NOT NULL DROP FUNCTION {Bracket(r.s)}.{Bracket(r.n)};");
                    await w.WriteLineAsync("GO");
                    await w.WriteLineAsync(r.body.Trim());
                    await w.WriteLineAsync("GO");
                    await w.WriteLineAsync();
                }
                onProgress?.Invoke($"  {rows.Count} function(s)");
            }
        }
        catch (Exception ex) { await w.WriteLineAsync($"\n-- (skipped function dump: {ex.Message})"); }
    }

    public async Task RestoreAsync(DbConnectionInfo conn, string sqlFilePath, Action<string>? onProgress, CancellationToken ct)
    {
        await using var c = new SqlConnection(ConnString(conn));
        await c.OpenAsync(ct);
        var text = await File.ReadAllTextAsync(sqlFilePath, ct);
        var batches = SplitMsSqlBatches(text).ToList();
        onProgress?.Invoke($"Executing {batches.Count} batches...");
        int n = 0;
        foreach (var b in batches)
        {
            ct.ThrowIfCancellationRequested();
            await using var cmd = new SqlCommand(b, c) { CommandTimeout = 600 };
            await cmd.ExecuteNonQueryAsync(ct);
            n++;
            if (n % 50 == 0) onProgress?.Invoke($"  {n}/{batches.Count}");
        }
        onProgress?.Invoke($"Restore complete ({n} batches)");
    }

    public List<string> ParseTableNamesFromDump(string sqlFilePath) =>
        SqlHelpers.ParseTableNamesFromDump(sqlFilePath, '[');
}
