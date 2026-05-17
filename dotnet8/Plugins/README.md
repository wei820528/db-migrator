# Plugins (.NET)

Drop a `.cs` file here, rebuild — auto-discovered by ASP.NET Core.

## Three kinds of contribution

### 1. Routes — any `ControllerBase` subclass

```csharp
[ApiController]
[Route("api/ping")]
public class PingController : ControllerBase
{
    [HttpGet("")]
    public IActionResult Get() => Ok(new { pong = true });
}
```

Auto-discovered by `MapControllers()`.

### 2. Frontend UI — implement `IPluginUiContributor`

```csharp
public class MyUi : IPluginUiContributor
{
    public PluginUiContribution Contribute() => new()
    {
        Cards = { new PluginCard { Type = "myft", Title = "My DB", Sub = "..." } },
        Tabs = { new PluginTab { Id = "mytab", Label = "My Tab", Html = "<div>...</div>",
                                 Scripts = { "/plugins/static/myft/init.js" } } },
    };
}
```

Auto-registered as singleton at startup (Program.cs scans for `IPluginUiContributor` impls).

The aggregated UI is exposed at `GET /api/plugins/ui` — main `app.js` fetches and renders.

### 3. Static assets — drop them in `Plugins/static/<name>/`

Served at `/plugins/static/<name>/...`. Reference from your tab's `Scripts` field.

`Plugins/static/**/*` is auto-copied to the build output (see csproj).

## See `HelloController.cs` + `static/hello/init.js` for a working example

It contributes: route + UI tab + static JS.

## Failure isolation — partial

| Failure | Effect |
|---|---|
| Compile-time error in a plugin file | Whole build fails |
| Runtime error in a controller action | Just that request fails, rest works |
| `IPluginUiContributor.Contribute()` throws | Logged, that contribution skipped, others still merge |

## No hot reload

.NET requires rebuild. Use `dotnet watch run` for fast rebuild on file save (still recompiles the full process, ~1-2 sec).

For true runtime DLL loading: would need `AssemblyLoadContext` + `ApplicationParts`. Not done in v1.

## Reusing core services — constructor inject

```csharp
public MyController(AdapterRegistry registry, JobService jobs, GitHubService gh)
{
    // ...
}
```
