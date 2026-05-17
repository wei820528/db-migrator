using System.IO.Compression;
using System.Text.Json;
using DbMigrator.Web.Adapters;
using DbMigrator.Web.Models;
using DbMigrator.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace DbMigrator.Web.Controllers;

[ApiController]
[Route("api/project")]
public class ProjectController : ControllerBase
{
    private readonly AdapterRegistry _registry;
    private readonly JobService _jobs;
    private readonly GitHubService _gh;
    private readonly SupabaseStorageService _storage;

    private static readonly string TmpDir = Path.Combine(AppContext.BaseDirectory, "tmp");
    private static readonly string UploadDir = Path.Combine(TmpDir, "uploads");

    public ProjectController(AdapterRegistry registry, JobService jobs, GitHubService gh, SupabaseStorageService storage)
    {
        _registry = registry;
        _jobs = jobs;
        _gh = gh;
        _storage = storage;
        Directory.CreateDirectory(UploadDir);
    }

    // ============================================================
    // POST /api/project/backup
    // ============================================================
    [HttpPost("backup")]
    public IActionResult Backup([FromBody] BackupRequest req)
    {
        if (req.Code == null && req.Db == null && req.Storage == null)
            return BadRequest(new { error = "至少要選一個層（code / db / storage）" });

        var job = _jobs.Create("project-backup");
        var jobDir = Path.Combine(TmpDir, job.Id);
        var workDir = Path.Combine(jobDir, "work");
        Directory.CreateDirectory(workDir);

        _jobs.SetStatus(job.Id, "running");

        _ = Task.Run(async () =>
        {
            void Log(string l) => _jobs.Append(job.Id, l);
            var manifest = new BackupManifest { CreatedAt = DateTime.UtcNow.ToString("O") };
            try
            {
                if (req.Code != null && !string.IsNullOrEmpty(req.Code.RepoUrl))
                {
                    Log("=== Code (Git) ===");
                    var codeDir = Path.Combine(workDir, "code");
                    _gh.Clone(req.Code, codeDir, Log);
                    var gitDir = Path.Combine(codeDir, ".git");
                    if (Directory.Exists(gitDir)) Directory.Delete(gitDir, true);
                    manifest.Code = new ManifestCode { RepoUrl = req.Code.RepoUrl, Branch = req.Code.Branch ?? "main" };
                }

                if (req.Db != null && !string.IsNullOrEmpty(req.Db.Type))
                {
                    Log("=== Database ===");
                    var adapter = _registry.Get(req.Db.Type);
                    var dbFile = Path.Combine(workDir, "db.sql");
                    var perConn = req.Db.Type == "sqlite"
                        ? new DbConnectionInfo { Path = req.Db.Database }
                        : new DbConnectionInfo
                        {
                            Host = req.Db.Connection.Host, Port = req.Db.Connection.Port,
                            User = req.Db.Connection.User, Password = req.Db.Connection.Password,
                            AuthMode = req.Db.Connection.AuthMode, Ssl = req.Db.Connection.Ssl,
                            Database = req.Db.Database,
                        };
                    await adapter.DumpAsync(perConn, req.Db.Options ?? new ExportOptions(), dbFile, Log, CancellationToken.None);
                    manifest.Db = new ManifestDb { Type = req.Db.Type, Database = req.Db.Database };
                }

                if (req.Storage != null && !string.IsNullOrEmpty(req.Storage.Url) && !string.IsNullOrEmpty(req.Storage.ServiceKey))
                {
                    Log("=== Supabase Storage ===");
                    var storageDir = Path.Combine(workDir, "storage");
                    var stats = await _storage.DownloadAllAsync(req.Storage, storageDir, Log);
                    manifest.Storage = new ManifestStorage { Url = req.Storage.Url, BucketCount = stats.BucketCount, FileCount = stats.FileCount };
                }

                await System.IO.File.WriteAllTextAsync(
                    Path.Combine(workDir, "manifest.json"),
                    JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true })
                );

                Log("Packing backup.zip...");
                var zipPath = Path.Combine(jobDir, "backup.zip");
                if (System.IO.File.Exists(zipPath)) System.IO.File.Delete(zipPath);
                ZipFile.CreateFromDirectory(workDir, zipPath, CompressionLevel.Optimal, false);

                _jobs.SetStatus(job.Id, "done", j => j.Result = new
                {
                    downloadUrl = $"/api/project/{job.Id}/zip",
                    manifest,
                });
                Log("Backup complete");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[project/backup] failed: {ex}");
                _jobs.SetStatus(job.Id, "error", j => j.Error = ex.Message);
            }
        });

        return Ok(new { jobId = job.Id });
    }

    [HttpGet("{id}/zip")]
    public IActionResult Zip(string id)
    {
        var job = _jobs.Get(id);
        if (job == null || job.Status != "done") return NotFound(new { error = "Not ready" });
        var zipPath = Path.Combine(TmpDir, id, "backup.zip");
        if (!System.IO.File.Exists(zipPath)) return NotFound(new { error = "Zip missing" });
        return PhysicalFile(zipPath, "application/zip", "backup.zip");
    }

    // ============================================================
    // POST /api/project/inspect  (multipart/form-data: file)
    // ============================================================
    [HttpPost("inspect")]
    [RequestSizeLimit(5L * 1024 * 1024 * 1024)]
    public async Task<IActionResult> Inspect([FromForm] IFormFile file)
    {
        try
        {
            var uploadId = Guid.NewGuid().ToString("N");
            var uploadPath = Path.Combine(UploadDir, uploadId);
            await using (var fs = System.IO.File.Create(uploadPath))
                await file.CopyToAsync(fs);

            using var zip = ZipFile.OpenRead(uploadPath);
            var manifestEntry = zip.GetEntry("manifest.json");
            if (manifestEntry == null) return BadRequest(new { error = "manifest.json not found in zip" });
            using var sr = new StreamReader(manifestEntry.Open());
            var manifestJson = await sr.ReadToEndAsync();
            var manifest = JsonSerializer.Deserialize<BackupManifest>(manifestJson,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            return Ok(new { uploadId, manifest });
        }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    // ============================================================
    // POST /api/project/restore
    // ============================================================
    [HttpPost("restore")]
    public IActionResult Restore([FromBody] RestoreRequest req)
    {
        if (string.IsNullOrEmpty(req.UploadId)) return BadRequest(new { error = "uploadId required" });
        if (req.Dest == null) return BadRequest(new { error = "dest config required" });

        var zipPath = Path.Combine(UploadDir, req.UploadId);
        if (!System.IO.File.Exists(zipPath)) return NotFound(new { error = "Upload not found" });

        var job = _jobs.Create("project-restore");
        var jobDir = Path.Combine(TmpDir, job.Id);
        var workDir = Path.Combine(jobDir, "work");
        Directory.CreateDirectory(workDir);

        _jobs.SetStatus(job.Id, "running");

        _ = Task.Run(async () =>
        {
            void Log(string l) => _jobs.Append(job.Id, l);
            try
            {
                Log("Unpacking backup.zip...");
                ZipFile.ExtractToDirectory(zipPath, workDir);

                if (req.Dest.Code != null && !string.IsNullOrEmpty(req.Dest.Code.RepoUrl))
                {
                    Log("=== Push code to destination repo ===");
                    var codeDir = Path.Combine(workDir, "code");
                    if (!Directory.Exists(codeDir)) Log("  (no code in backup, skipping)");
                    else _gh.PushTo(req.Dest.Code, codeDir, Log);
                }

                if (req.Dest.Db != null && !string.IsNullOrEmpty(req.Dest.Db.Type))
                {
                    Log("=== Restore DB ===");
                    var dbFile = Path.Combine(workDir, "db.sql");
                    if (!System.IO.File.Exists(dbFile)) Log("  (no db.sql in backup, skipping)");
                    else
                    {
                        var adapter = _registry.Get(req.Dest.Db.Type);
                        var perConn = req.Dest.Db.Type == "sqlite"
                            ? new DbConnectionInfo { Path = req.Dest.Db.Database }
                            : new DbConnectionInfo
                            {
                                Host = req.Dest.Db.Connection.Host, Port = req.Dest.Db.Connection.Port,
                                User = req.Dest.Db.Connection.User, Password = req.Dest.Db.Connection.Password,
                                AuthMode = req.Dest.Db.Connection.AuthMode, Ssl = req.Dest.Db.Connection.Ssl,
                                Database = req.Dest.Db.Database,
                            };
                        await adapter.RestoreAsync(perConn, dbFile, Log, CancellationToken.None);
                    }
                }

                if (req.Dest.Storage != null && !string.IsNullOrEmpty(req.Dest.Storage.Url) && !string.IsNullOrEmpty(req.Dest.Storage.ServiceKey))
                {
                    Log("=== Upload Storage ===");
                    var storageDir = Path.Combine(workDir, "storage");
                    await _storage.UploadAllAsync(req.Dest.Storage, storageDir, Log);
                }

                try { System.IO.File.Delete(zipPath); } catch { }
                _jobs.SetStatus(job.Id, "done", j => j.Result = new { ok = true });
                Log("Restore complete");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[project/restore] failed: {ex}");
                _jobs.SetStatus(job.Id, "error", j => j.Error = ex.Message);
            }
        });

        return Ok(new { jobId = job.Id });
    }
}
