using System.IO.Compression;
using DbMigrator.Web.Adapters;
using DbMigrator.Web.Models;
using DbMigrator.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace DbMigrator.Web.Controllers;

[ApiController]
[Route("api/export")]
public class ExportController : ControllerBase
{
    private readonly AdapterRegistry _registry;
    private readonly JobService _jobs;
    private static readonly string TmpDir = Path.Combine(AppContext.BaseDirectory, "tmp");

    public ExportController(AdapterRegistry registry, JobService jobs)
    {
        _registry = registry;
        _jobs = jobs;
    }

    private static string SafeName(string s)
    {
        var invalid = Path.GetInvalidFileNameChars().Concat(new[] { ' ', '\\', '/', ':' }).ToHashSet();
        var clean = new string(s.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
        return string.IsNullOrWhiteSpace(clean) ? "dump" : clean[..Math.Min(100, clean.Length)];
    }

    [HttpPost("")]
    public IActionResult Start([FromBody] ExportRequest req)
    {
        IDatabaseAdapter adapter;
        try { adapter = _registry.Get(req.Type); }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }

        if (req.Databases is not { Count: > 0 })
            return BadRequest(new { error = "databases array required (at least one)" });

        var job = _jobs.Create("export");
        var jobDir = Path.Combine(TmpDir, job.Id);
        var filesDir = Path.Combine(jobDir, "sql");
        Directory.CreateDirectory(filesDir);

        _jobs.SetStatus(job.Id, "running");

        _ = Task.Run(async () =>
        {
            try
            {
                foreach (var db in req.Databases)
                {
                    _jobs.Append(job.Id, $"=== {db} ===");
                    var perDbConn = new DbConnectionInfo
                    {
                        Host = req.Connection.Host, Port = req.Connection.Port,
                        User = req.Connection.User, Password = req.Connection.Password,
                        AuthMode = req.Connection.AuthMode,
                        Database = req.Type == "sqlite" ? "" : db,
                        Path = req.Type == "sqlite" ? db : req.Connection.Path,
                    };
                    var outFile = Path.Combine(filesDir, $"{SafeName(db)}.sql");
                    await adapter.DumpAsync(perDbConn, req.Options, outFile,
                        line => _jobs.Append(job.Id, line), CancellationToken.None);
                }

                string downloadUrl;
                if (req.Databases.Count == 1)
                {
                    downloadUrl = $"/api/export/{job.Id}/file";
                }
                else
                {
                    var zipPath = Path.Combine(jobDir, "dumps.zip");
                    _jobs.Append(job.Id, $"Packing {req.Databases.Count} dump(s) into zip...");
                    if (System.IO.File.Exists(zipPath)) System.IO.File.Delete(zipPath);
                    ZipFile.CreateFromDirectory(filesDir, zipPath, CompressionLevel.Optimal, false);
                    downloadUrl = $"/api/export/{job.Id}/zip";
                }

                _jobs.SetStatus(job.Id, "done", j => j.Result = new { downloadUrl, count = req.Databases.Count });
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[export] failed: {ex}");
                _jobs.SetStatus(job.Id, "error", j => j.Error = ex.Message);
            }
        });

        return Ok(new { jobId = job.Id });
    }

    [HttpGet("{id}/file")]
    public IActionResult Download(string id)
    {
        var job = _jobs.Get(id);
        if (job == null || job.Status != "done") return NotFound(new { error = "Not ready" });
        var filesDir = Path.Combine(TmpDir, id, "sql");
        if (!Directory.Exists(filesDir)) return NotFound(new { error = "File missing" });
        var sql = Directory.GetFiles(filesDir, "*.sql").FirstOrDefault();
        if (sql == null) return NotFound(new { error = "File missing" });
        return PhysicalFile(sql, "application/sql", Path.GetFileName(sql));
    }

    [HttpGet("{id}/zip")]
    public IActionResult DownloadZip(string id)
    {
        var job = _jobs.Get(id);
        if (job == null || job.Status != "done") return NotFound(new { error = "Not ready" });
        var zipPath = Path.Combine(TmpDir, id, "dumps.zip");
        if (!System.IO.File.Exists(zipPath)) return NotFound(new { error = "Zip missing" });
        return PhysicalFile(zipPath, "application/zip", "dumps.zip");
    }
}
