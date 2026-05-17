namespace DbMigrator.Web.Models;

public class DbConnectionInfo
{
    public string Host { get; set; } = "127.0.0.1";
    public int Port { get; set; } = 3306;
    public string Database { get; set; } = "";
    public string User { get; set; } = "";
    public string Password { get; set; } = "";
    /// <summary>SQLite-only: file path. Falls back to Host or Database if empty.</summary>
    public string? Path { get; set; }
    /// <summary>SQL Server only: "sql" (default) or "windows".</summary>
    public string? AuthMode { get; set; }
    /// <summary>Postgres / Supabase: force SSL. Supabase always requires it.</summary>
    public bool Ssl { get; set; }
}

public class TableInfo
{
    public string Name { get; set; } = "";
    public long? RowEstimate { get; set; }
}

public class ExportOptions
{
    public List<string> Tables { get; set; } = new();
    public bool NoData { get; set; }
    public bool NoSchema { get; set; }
}

public class ExportRequest
{
    public string Type { get; set; } = "mysql";
    public DbConnectionInfo Connection { get; set; } = new();
    public List<string> Databases { get; set; } = new();
    public ExportOptions Options { get; set; } = new();
}

public class ImportRunRequest
{
    public string Type { get; set; } = "mysql";
    public DbConnectionInfo Connection { get; set; } = new();
    public string UploadId { get; set; } = "";
    public List<string>? Tables { get; set; }   // optional: if set, only these tables' statements run
}

public class TableDiff
{
    public string Name { get; set; } = "";
    public bool ExistsInTarget { get; set; }
}
