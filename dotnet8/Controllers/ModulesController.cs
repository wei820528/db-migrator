using DbMigrator.Web.Adapters;
using Microsoft.AspNetCore.Mvc;

namespace DbMigrator.Web.Controllers;

[ApiController]
[Route("api/modules")]
public class ModulesController : ControllerBase
{
    private readonly AdapterRegistry _registry;
    public ModulesController(AdapterRegistry registry) => _registry = registry;

    [HttpGet("")]
    public IActionResult Get()
    {
        // .NET routes are auto-discovered controllers; we report adapters and a static
        // route list (since failed controllers in .NET fail at compile/startup, not runtime).
        var routes = new Dictionary<string, object>
        {
            ["connection"] = new { ok = true, mount = "/api/connection" },
            ["export"]     = new { ok = true, mount = "/api/export" },
            ["import"]     = new { ok = true, mount = "/api/import" },
            ["jobs"]       = new { ok = true, mount = "/api/jobs" },
            ["project"]    = new { ok = true, mount = "/api/project" },
        };
        return Ok(new { routes, adapters = _registry.GetStatus() });
    }
}
