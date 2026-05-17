using System.Text.Json;
using DbMigrator.Web.Adapters;
using DbMigrator.Web.Models;
using DbMigrator.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace DbMigrator.Web.Controllers;

[ApiController]
[Route("api/import")]
public class ImportController : ControllerBase
{
    private readonly AdapterRegistry _registry;
    private readonly JobService _jobs;
    private static readonly string TmpDir = Path.Combine(AppContext.BaseDirectory, "tmp");
    private static readonly string UploadDir = Path.Combine(TmpDir, "uploads");

    public ImportController(AdapterRegistry registry, JobService jobs)
    {
        _registry = registry;
        _jobs = jobs;
    }

    public class InspectMeta
    {
        public string Type { get; set; } = "mysql";
        public DbConnectionInfo Connection { get; set; } = new();
    }

    [HttpPost("inspect")]
    [RequestSizeLimit(1024L * 1024 * 1024)]
    public async Task<IActionResult> Inspect([FromForm] IFormFile file, [FromForm] string meta)
    {
        try
        {
            var m = JsonSerializer.Deserialize<InspectMeta>(meta,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new Exception("invalid meta");

            var adapter = _registry.Get(m.Type);
            Directory.CreateDirectory(UploadDir);
            var uploadId = Guid.NewGuid().ToString("N");
            var uploadPath = Path.Combine(UploadDir, uploadId);
            await using (var fs = System.IO.File.Create(uploadPath))
                await file.CopyToAsync(fs);

            var fileTables = adapter.ParseTableNamesFromDump(uploadPath);
            var dbTables = (await adapter.ListTablesAsync(m.Connection)).Select(t => t.Name).ToHashSet();
            var diff = fileTables.Select(t => new TableDiff { Name = t, ExistsInTarget = dbTables.Contains(t) });

            return Ok(new { uploadId, fileTables, dbTables, diff });
        }
        catch (Exception ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    private static char IdentQuoteFor(string type) => type switch
    {
        "mysql" => '`',
        "mssql" => '[',
        _ => '"',  // postgres, sqlite, supabase
    };

    [HttpPost("run")]
    public IActionResult Run([FromBody] ImportRunRequest req)
    {
        IDatabaseAdapter adapter;
        try { adapter = _registry.Get(req.Type); }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }

        var origPath = Path.Combine(UploadDir, req.UploadId);
        if (!System.IO.File.Exists(origPath)) return NotFound(new { error = "Upload not found" });

        var job = _jobs.Create("import");
        _jobs.SetStatus(job.Id, "running");

        // Filter to selected tables, if any
        string runPath = origPath;
        string? filteredPath = null;
        if (req.Tables is { Count: > 0 })
        {
            try
            {
                var text = System.IO.File.ReadAllText(origPath);
                string outText; int kept; int skipped;
                var adapterFilter = adapter.FilterDumpByTables(text, req.Tables);
                if (adapterFilter != null)
                {
                    outText = adapterFilter.Text; kept = adapterFilter.Kept; skipped = adapterFilter.Skipped;
                }
                else
                {
                    var (sql, k, s) = SqlHelpers.FilterSqlByTables(text, req.Tables, IdentQuoteFor(req.Type));
                    outText = sql; kept = k; skipped = s;
                }
                filteredPath = origPath + ".filtered.sql";
                System.IO.File.WriteAllText(filteredPath, outText);
                runPath = filteredPath;
                _jobs.Append(job.Id, $"Filter: kept {kept} stmts, skipped {skipped} (only {req.Tables.Count} item(s) selected)");
            }
            catch (Exception ex)
            {
                _jobs.SetStatus(job.Id, "error", j => j.Error = "filter failed: " + ex.Message);
                return Ok(new { jobId = job.Id });
            }
        }

        _ = Task.Run(async () =>
        {
            try
            {
                await adapter.RestoreAsync(req.Connection, runPath,
                    line => _jobs.Append(job.Id, line), CancellationToken.None);
                _jobs.SetStatus(job.Id, "done", j => j.Result = new { ok = true });
                try { System.IO.File.Delete(origPath); } catch { }
                if (filteredPath != null) { try { System.IO.File.Delete(filteredPath); } catch { } }
            }
            catch (Exception ex)
            {
                _jobs.SetStatus(job.Id, "error", j => j.Error = ex.Message);
                if (filteredPath != null) { try { System.IO.File.Delete(filteredPath); } catch { } }
            }
        });

        return Ok(new { jobId = job.Id });
    }
}
