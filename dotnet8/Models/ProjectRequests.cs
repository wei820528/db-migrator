namespace DbMigrator.Web.Models;

public class CodeConfig
{
    public string RepoUrl { get; set; } = "";
    public string Pat { get; set; } = "";
    public string? Branch { get; set; }
}

public class DbBackupConfig
{
    public string Type { get; set; } = "";
    public DbConnectionInfo Connection { get; set; } = new();
    public string Database { get; set; } = "";
    public ExportOptions? Options { get; set; }
}

public class StorageConfig
{
    public string Url { get; set; } = "";
    public string ServiceKey { get; set; } = "";
}

public class BackupRequest
{
    public CodeConfig? Code { get; set; }
    public DbBackupConfig? Db { get; set; }
    public StorageConfig? Storage { get; set; }
}

public class RestoreDest
{
    public CodeConfig? Code { get; set; }
    public DbBackupConfig? Db { get; set; }
    public StorageConfig? Storage { get; set; }
}

public class RestoreRequest
{
    public string UploadId { get; set; } = "";
    public RestoreDest Dest { get; set; } = new();
}

public class BackupManifest
{
    public string CreatedAt { get; set; } = "";
    public ManifestCode? Code { get; set; }
    public ManifestDb? Db { get; set; }
    public ManifestStorage? Storage { get; set; }
}

public class ManifestCode { public string RepoUrl { get; set; } = ""; public string Branch { get; set; } = "main"; }
public class ManifestDb { public string Type { get; set; } = ""; public string Database { get; set; } = ""; }
public class ManifestStorage { public string Url { get; set; } = ""; public int BucketCount { get; set; } public int FileCount { get; set; } }
