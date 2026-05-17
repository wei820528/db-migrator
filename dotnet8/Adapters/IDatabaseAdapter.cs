using DbMigrator.Web.Models;

namespace DbMigrator.Web.Adapters;

public class TestResult
{
    public bool Ok { get; set; }
    public string Version { get; set; } = "";
    public List<string>? Databases { get; set; }
    public string? Error { get; set; }
}

public interface IDatabaseAdapter
{
    string Type { get; }
    Task<TestResult> TestConnectionAsync(DbConnectionInfo conn);
    Task<List<TableInfo>> ListTablesAsync(DbConnectionInfo conn);
    Task DumpAsync(DbConnectionInfo conn, ExportOptions options, string outFilePath, Action<string>? onProgress, CancellationToken ct);
    Task RestoreAsync(DbConnectionInfo conn, string sqlFilePath, Action<string>? onProgress, CancellationToken ct);
    List<string> ParseTableNamesFromDump(string sqlFilePath);

    // Non-SQL adapters override this to filter their own dump format on import.
    // Returns null to fall back to SqlHelpers.FilterSqlByTables in the controller.
    FilterResult? FilterDumpByTables(string dumpText, List<string> wanted) => null;
}

public record FilterResult(string Text, int Kept, int Skipped);

public class AdapterStatus
{
    public bool Ok { get; set; }
    public string? Error { get; set; }
}

public class AdapterRegistry
{
    private readonly Dictionary<string, Func<IDatabaseAdapter>> _factories;
    private readonly Dictionary<string, IDatabaseAdapter> _cache = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, AdapterStatus> _status = new(StringComparer.OrdinalIgnoreCase);

    public AdapterRegistry()
    {
        // Lazy factories — adapter only instantiated on first use, errors isolated per type.
        _factories = new(StringComparer.OrdinalIgnoreCase)
        {
            ["mysql"]    = () => new MySqlAdapter(),
            ["postgres"] = () => new PostgresAdapter(),
            ["mssql"]    = () => new MsSqlAdapter(),
            ["sqlite"]   = () => new SqliteAdapter(),
            ["supabase"] = () => new PostgresAdapter(),  // Supabase IS Postgres
            ["mongo"]    = () => new MongoAdapter(),
            ["redis"]    = () => new RedisAdapter(),
        };
    }

    public IDatabaseAdapter Get(string type)
    {
        var r = TryLoad(type);
        if (!r.Ok) throw new InvalidOperationException($"Adapter \"{type}\" unavailable: {r.Error}");
        return _cache[type];
    }

    private AdapterStatus TryLoad(string type)
    {
        if (_cache.ContainsKey(type)) { _status[type] = new AdapterStatus { Ok = true }; return _status[type]; }
        if (!_factories.TryGetValue(type, out var factory))
            return _status[type] = new AdapterStatus { Ok = false, Error = $"Unsupported type: {type}" };
        try
        {
            _cache[type] = factory();
            return _status[type] = new AdapterStatus { Ok = true };
        }
        catch (Exception ex)
        {
            return _status[type] = new AdapterStatus { Ok = false, Error = ex.Message };
        }
    }

    public Dictionary<string, AdapterStatus> GetStatus()
    {
        foreach (var t in _factories.Keys)
            if (!_status.ContainsKey(t)) TryLoad(t);
        return new Dictionary<string, AdapterStatus>(_status, StringComparer.OrdinalIgnoreCase);
    }
}
