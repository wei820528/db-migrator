using DbMigrator.Web.Adapters;
using DbMigrator.Web.Models;
using Microsoft.AspNetCore.Mvc;

namespace DbMigrator.Web.Controllers;

[ApiController]
[Route("api/connection")]
public class ConnectionController : ControllerBase
{
    private readonly AdapterRegistry _registry;
    public ConnectionController(AdapterRegistry registry) => _registry = registry;

    public class TestRequest : DbConnectionInfo { public string Type { get; set; } = "mysql"; }

    [HttpPost("test")]
    public async Task<IActionResult> Test([FromBody] TestRequest req)
    {
        try
        {
            var adapter = _registry.Get(req.Type);
            var r = await adapter.TestConnectionAsync(req);
            if (r.Ok) return Ok(new { ok = true, version = r.Version, databases = r.Databases });
            return BadRequest(new { ok = false, error = r.Error });
        }
        catch (Exception ex)
        {
            return BadRequest(new { ok = false, error = ex.Message });
        }
    }

    [HttpPost("tables")]
    public async Task<IActionResult> Tables([FromBody] TestRequest req)
    {
        try
        {
            var adapter = _registry.Get(req.Type);
            var tables = await adapter.ListTablesAsync(req);
            return Ok(new { tables });
        }
        catch (Exception ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }
}
