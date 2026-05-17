using Microsoft.AspNetCore.Mvc;

namespace DbMigrator.Web.Plugins;

[ApiController]
[Route("api/hello")]
public class HelloController : ControllerBase
{
    [HttpGet("")]
    public IActionResult Get() => Ok(new
    {
        message = "Hello from a plugin!",
        time = DateTime.UtcNow.ToString("O"),
        info = "我是 Plugins/ 資料夾裡的 controller，ASP.NET 編譯時自動發現並註冊"
    });

    [HttpGet("echo/{text}")]
    public IActionResult Echo(string text) => Ok(new { echo = text });
}

// Sister class implementing IPluginUiContributor — auto-discovered at startup.
public class HelloUiContributor : IPluginUiContributor
{
    public PluginUiContribution Contribute() => new()
    {
        Tabs = new()
        {
            new PluginTab
            {
                Id = "hello-tab",
                Label = "Hello Tools",
                Html = @"
                    <h2>Hello Tools <span class=""tag"" style=""background:#fef3c7;color:#92400e;"">plugin</span></h2>
                    <p>這個 tab 是 .NET plugin 透過 IPluginUiContributor 加進來的。</p>
                    <button id=""hello-ping"">Ping /api/hello</button>
                    <pre id=""hello-out"" class=""log"" style=""margin-top:8px;""></pre>
                ",
                Scripts = new() { "/plugins/static/hello/init.js" }
            }
        }
    };
}
