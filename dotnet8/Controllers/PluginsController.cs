using DbMigrator.Web.Plugins;
using Microsoft.AspNetCore.Mvc;

namespace DbMigrator.Web.Controllers;

[ApiController]
[Route("api/plugins")]
public class PluginsController : ControllerBase
{
    private readonly IEnumerable<IPluginUiContributor> _contributors;

    public PluginsController(IEnumerable<IPluginUiContributor> contributors)
    {
        _contributors = contributors;
    }

    [HttpGet("ui")]
    public IActionResult Ui()
    {
        var merged = new PluginUiContribution();
        foreach (var c in _contributors)
        {
            try
            {
                var u = c.Contribute();
                merged.Cards.AddRange(u.Cards);
                merged.Tabs.AddRange(u.Tabs);
                merged.Scripts.AddRange(u.Scripts);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[plugin-ui] {c.GetType().Name} failed: {ex.Message}");
            }
        }
        return Ok(new
        {
            cards = merged.Cards.Select(c => new { type = c.Type, title = c.Title, sub = c.Sub, port = c.Port }),
            tabs = merged.Tabs.Select(t => new { id = t.Id, label = t.Label, html = t.Html, scripts = t.Scripts }),
            scripts = merged.Scripts,
        });
    }
}
