using DbMigrator.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace DbMigrator.Web.Controllers;

[ApiController]
[Route("api/jobs")]
public class JobsController : ControllerBase
{
    private readonly JobService _jobs;
    public JobsController(JobService jobs) => _jobs = jobs;

    [HttpGet("{id}")]
    public IActionResult Get(string id)
    {
        var j = _jobs.Get(id);
        if (j == null) return NotFound(new { error = "Not found" });
        return Ok(j);
    }
}
