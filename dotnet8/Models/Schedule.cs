namespace DbMigrator.Web.Models;

public class Schedule
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Type { get; set; } = "";   // mysql / postgres / mssql / sqlite / supabase
    public DbConnectionInfo? Connection { get; set; }  // password masked on read
    public List<string> Databases { get; set; } = new();
    public string Expression { get; set; } = "";
    public bool Active { get; set; } = true;
    public long? NextRunAt { get; set; }     // unix ms
    public long? LastRunAt { get; set; }
    public string? LastStatus { get; set; }   // 'ok' / 'error'
    public string? LastError { get; set; }
    public string? LastJobId { get; set; }
    public long CreatedAt { get; set; }
    public long UpdatedAt { get; set; }
    public bool HasPassword { get; set; }     // indicates a stored encrypted password
}

public class CreateScheduleRequest
{
    public string Name { get; set; } = "";
    public string Type { get; set; } = "";
    public DbConnectionInfo Connection { get; set; } = new();
    public List<string> Databases { get; set; } = new();
    public string Expression { get; set; } = "";
    public bool Active { get; set; } = true;
}

public class UpdateScheduleRequest
{
    public string? Name { get; set; }
    public string? Type { get; set; }
    public DbConnectionInfo? Connection { get; set; }
    public List<string>? Databases { get; set; }
    public string? Expression { get; set; }
    public bool? Active { get; set; }
}
