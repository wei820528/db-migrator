using System.IO.Compression;
using DbMigrator.Web.Adapters;
using DbMigrator.Web.Models;
using DbMigrator.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace DbMigrator.Web.Controllers;

[ApiController]
[Route("api/schedule")]
public class ScheduleController : ControllerBase
{
    private readonly AdapterRegistry _registry;
    private readonly JobService _jobs;
    private readonly ScheduleService _schedules;

    public ScheduleController(AdapterRegistry registry, JobService jobs, ScheduleService schedules)
    {
        _registry = registry;
        _jobs = jobs;
        _schedules = schedules;
        // Wire dispatcher on first injection (idempotent — if already set, no harm)
        _schedules.Dispatcher ??= DispatchAsync;
    }

    private static string SafeName(string s)
    {
        var invalid = Path.GetInvalidFileNameChars().Concat(new[] { ' ', '\\', '/', ':' }).ToHashSet();
        var clean = new string(s.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
        return string.IsNullOrWhiteSpace(clean) ? "dump" : clean[..Math.Min(100, clean.Length)];
    }

    private async Task<string> DispatchAsync(Schedule sched)
    {
        var adapter = _registry.Get(sched.Type);
        var conn = _schedules.LoadConnectionWithPassword(sched.Id)
                   ?? throw new Exception("schedule connection not found");

        var job = _jobs.Create("scheduled-backup");
        _jobs.SetStatus(job.Id, "running");
        _jobs.Append(job.Id, $"=== Scheduled: {sched.Name} ===");

        _ = Task.Run(async () =>
        {
            var stamp = DateTime.UtcNow.ToString("yyyy-MM-ddTHH-mm-ss");
            var outBase = Path.Combine(ScheduleService.OutputDir, $"{SafeName(sched.Name)}_{stamp}");
            var workDir = outBase + "_tmp";
            Directory.CreateDirectory(workDir);

            try
            {
                foreach (var db in sched.Databases)
                {
                    _jobs.Append(job.Id, $"> {db}");
                    var perConn = sched.Type == "sqlite"
                        ? new DbConnectionInfo { Path = db }
                        : new DbConnectionInfo
                        {
                            Host = conn.Host, Port = conn.Port, User = conn.User, Password = conn.Password,
                            AuthMode = conn.AuthMode, Ssl = conn.Ssl, Database = db,
                        };
                    var file = Path.Combine(workDir, $"{SafeName(db)}.sql");
                    await adapter.DumpAsync(perConn, new ExportOptions(), file,
                        line => _jobs.Append(job.Id, line), CancellationToken.None);
                }

                string outPath;
                if (sched.Databases.Count == 1)
                {
                    var srcFile = Directory.GetFiles(workDir).First();
                    outPath = outBase + ".sql";
                    System.IO.File.Move(srcFile, outPath);
                    Directory.Delete(workDir);
                }
                else
                {
                    outPath = outBase + ".zip";
                    ZipFile.CreateFromDirectory(workDir, outPath, CompressionLevel.Optimal, false);
                    Directory.Delete(workDir, true);
                }
                _jobs.SetStatus(job.Id, "done", j => j.Result = new { ok = true, path = outPath });
                _jobs.Append(job.Id, $"Saved to {outPath}");
            }
            catch (Exception ex)
            {
                _jobs.SetStatus(job.Id, "error", j => j.Error = ex.Message);
                try { Directory.Delete(workDir, true); } catch { }
            }
        });
        return job.Id;
    }

    // =============== REST API ===============
    [HttpGet("")]
    public IActionResult List() => Ok(new { schedules = _schedules.List(), outputDir = ScheduleService.OutputDir });

    [HttpGet("{id}")]
    public IActionResult Get(string id)
    {
        var s = _schedules.Get(id);
        return s == null ? NotFound(new { error = "not found" }) : Ok(s);
    }

    [HttpPost("")]
    public IActionResult Create([FromBody] CreateScheduleRequest req)
    {
        try { return Ok(_schedules.Create(req)); }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpPatch("{id}")]
    public IActionResult Update(string id, [FromBody] UpdateScheduleRequest req)
    {
        try { return Ok(_schedules.Update(id, req)); }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpDelete("{id}")]
    public IActionResult Remove(string id)
    {
        _schedules.Remove(id);
        return Ok(new { ok = true });
    }

    [HttpPost("{id}/run-now")]
    public async Task<IActionResult> RunNow(string id)
    {
        var s = _schedules.Get(id);
        if (s == null) return NotFound(new { error = "not found" });
        try
        {
            var jobId = await DispatchAsync(s);
            _schedules.MarkRunResult(id, true, null, jobId);
            return Ok(new { ok = true, jobId });
        }
        catch (Exception ex)
        {
            _schedules.MarkRunResult(id, false, ex.Message, null);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    [HttpGet("_files/list")]
    public IActionResult ListFiles()
    {
        var dir = ScheduleService.OutputDir;
        if (!Directory.Exists(dir)) return Ok(new { files = Array.Empty<object>() });
        var files = Directory.EnumerateFiles(dir).Select(p =>
        {
            var fi = new FileInfo(p);
            return new { name = fi.Name, size = fi.Length, mtime = new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeMilliseconds() };
        }).OrderByDescending(x => x.mtime).ToList();
        return Ok(new { files });
    }

    [HttpGet("_files/download")]
    public IActionResult Download([FromQuery] string name)
    {
        if (string.IsNullOrEmpty(name) || name.Contains("..") || name.Contains('/') || name.Contains('\\'))
            return BadRequest(new { error = "bad name" });
        var full = Path.Combine(ScheduleService.OutputDir, name);
        if (!System.IO.File.Exists(full)) return NotFound(new { error = "not found" });
        return PhysicalFile(full, "application/octet-stream", name);
    }
}
