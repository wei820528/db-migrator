using System.Reflection;
using System.Text.Json;
using DbMigrator.Web.Adapters;
using DbMigrator.Web.Plugins;
using DbMigrator.Web.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<JobService>();
builder.Services.AddSingleton<AdapterRegistry>();
builder.Services.AddSingleton<GitHubService>();
builder.Services.AddSingleton<SupabaseStorageService>();
builder.Services.AddSingleton<LicenseOnlineService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<LicenseOnlineService>());
builder.Services.AddSingleton<RevocationService>();
builder.Services.AddSingleton<LicenseService>();
builder.Services.AddSingleton<MarketplaceService>();
builder.Services.AddHostedService<TmpCleanupService>();
builder.Services.AddSingleton<EncryptionService>();
builder.Services.AddSingleton<ScheduleService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ScheduleService>());

// Auto-discover all IPluginUiContributor implementations
foreach (var t in Assembly.GetExecutingAssembly().GetTypes())
{
    if (t.IsAbstract || t.IsInterface) continue;
    if (typeof(IPluginUiContributor).IsAssignableFrom(t))
        builder.Services.AddSingleton(typeof(IPluginUiContributor), t);
}

builder.Services.AddControllers();

var app = builder.Build();

var tmp = Path.Combine(AppContext.BaseDirectory, "tmp");
Directory.CreateDirectory(tmp);
Directory.CreateDirectory(Path.Combine(tmp, "uploads"));

app.UseDefaultFiles();
app.UseStaticFiles();

// Plugin static assets
var staticRoot = Path.Combine(AppContext.BaseDirectory, "Plugins", "static");
if (!Directory.Exists(staticRoot))
    staticRoot = Path.Combine(builder.Environment.ContentRootPath, "Plugins", "static");
if (Directory.Exists(staticRoot))
{
    app.UseStaticFiles(new Microsoft.AspNetCore.Builder.StaticFileOptions
    {
        FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(staticRoot),
        RequestPath = "/plugins/static",
    });
}

// =================================================================
// License gate middleware — supports offline / online / disabled
// =================================================================
app.Use(async (ctx, next) =>
{
    var p = ctx.Request.Path.Value ?? "";
    if (!p.StartsWith("/api/", StringComparison.OrdinalIgnoreCase)
        || p.StartsWith("/api/license", StringComparison.OrdinalIgnoreCase)
        || p.Equals("/api/modules", StringComparison.OrdinalIgnoreCase)
        || p.Equals("/api/plugins/ui", StringComparison.OrdinalIgnoreCase))
    {
        await next();
        return;
    }

    var license = ctx.RequestServices.GetRequiredService<LicenseService>();
    if (license.Mode == "disabled") { await next(); return; }

    var lic = license.GetStatus();

    // Block expired/no-token states
    if (license.Mode == "online")
    {
        var onlineSvc = ctx.RequestServices.GetRequiredService<LicenseOnlineService>();
        var s = onlineSvc.GetState();
        if (!s.HasToken)
        {
            ctx.Response.StatusCode = 402;
            await ctx.Response.WriteAsJsonAsync(new { error = "Not logged in", license = lic, mode = "online" });
            return;
        }
        if (s.Kicked)
        {
            ctx.Response.StatusCode = 401;
            await ctx.Response.WriteAsJsonAsync(new { error = "Session kicked (used elsewhere)", license = lic, mode = "online" });
            return;
        }
        if (lic.Status == "expired")
        {
            ctx.Response.StatusCode = 402;
            await ctx.Response.WriteAsJsonAsync(new { error = "License/trial expired", license = lic, mode = "online" });
            return;
        }
        if (lic.Status == "offline")
        {
            ctx.Response.StatusCode = 503;
            await ctx.Response.WriteAsJsonAsync(new { error = "Cannot reach license server", license = lic, mode = "online" });
            return;
        }

        // Feature gates
        if (p.Equals("/api/export", StringComparison.OrdinalIgnoreCase) && ctx.Request.Method == "POST")
        {
            if (!await CheckExportFeatures(ctx, s, lic)) return;
        }
        if (p.StartsWith("/api/project", StringComparison.OrdinalIgnoreCase)
            && ctx.Request.Method != "GET"
            && IsFeatureFalse(s.Features, "project_backup"))
        {
            ctx.Response.StatusCode = 403;
            await ctx.Response.WriteAsJsonAsync(new
            {
                error = "試用版不支援專案備份功能，請升級方案",
                feature = "project_backup",
                license = lic,
            });
            return;
        }
    }
    else
    {
        // Offline
        if (lic.Status == "revoked")
        {
            ctx.Response.StatusCode = 403;
            await ctx.Response.WriteAsJsonAsync(new
            {
                error = lic.Error ?? "License revoked",
                license = lic,
                mode = "offline",
            });
            return;
        }
        if (lic.Status == "expired")
        {
            ctx.Response.StatusCode = 402;
            await ctx.Response.WriteAsJsonAsync(new
            {
                error = "License required",
                license = lic,
                mode = "offline",
                commercial = "/COMMERCIAL.md",
            });
            return;
        }
    }

    await next();
});

app.MapControllers();
app.Run();

// ---------- helpers ----------
static bool IsFeatureFalse(Dictionary<string, object?> features, string key) =>
    features != null && features.TryGetValue(key, out var v) && v is bool b && !b;

static int? GetFeatureInt(Dictionary<string, object?> features, string key)
{
    if (features == null) return null;
    if (!features.TryGetValue(key, out var v) || v == null) return null;
    if (v is int i) return i;
    if (v is long l) return (int)l;
    if (v is double d) return (int)d;
    return null;
}

static async Task<bool> CheckExportFeatures(HttpContext ctx, LicenseOnlineState s, LicenseStatus lic)
{
    // Need to peek body without consuming it for the actual handler.
    ctx.Request.EnableBuffering();
    using var sr = new StreamReader(ctx.Request.Body, leaveOpen: true);
    var body = await sr.ReadToEndAsync();
    ctx.Request.Body.Position = 0;

    int dbCount = 0;
    try
    {
        var doc = JsonDocument.Parse(string.IsNullOrEmpty(body) ? "{}" : body);
        if (doc.RootElement.TryGetProperty("databases", out var dbs) && dbs.ValueKind == JsonValueKind.Array)
            dbCount = dbs.GetArrayLength();
    }
    catch { }

    var max = GetFeatureInt(s.Features, "multi_db_count_max");
    if (max.HasValue && dbCount > max.Value)
    {
        ctx.Response.StatusCode = 403;
        await ctx.Response.WriteAsJsonAsync(new
        {
            error = $"您的方案最多可一次匯出 {max} 個資料庫，目前選了 {dbCount}",
            feature = "multi_db_count_max",
            license = lic,
        });
        return false;
    }
    if (IsFeatureFalse(s.Features, "bulk_export") && dbCount > 1)
    {
        ctx.Response.StatusCode = 403;
        await ctx.Response.WriteAsJsonAsync(new
        {
            error = "試用版不支援多資料庫一次匯出，請升級方案",
            feature = "bulk_export",
            license = lic,
        });
        return false;
    }
    return true;
}
