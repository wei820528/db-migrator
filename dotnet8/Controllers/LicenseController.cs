using DbMigrator.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace DbMigrator.Web.Controllers;

[ApiController]
[Route("api/license")]
public class LicenseController : ControllerBase
{
    private readonly LicenseService _license;
    private readonly LicenseOnlineService _online;

    public LicenseController(LicenseService license, LicenseOnlineService online)
    {
        _license = license;
        _online = online;
    }

    // Status (前端 banner 用)
    [HttpGet("")]
    public IActionResult Get()
    {
        var s = _license.GetStatus();
        return Ok(new
        {
            mode = s.Mode,
            status = s.Status,
            daysLeft = s.DaysLeft,
            info = s.Info,
            error = s.Error,
            features = s.Features,
            user = s.User,
            maxDevices = s.MaxDevices,
            hasToken = _license.Mode == "online" && _online.GetState().HasToken,
        });
    }

    // ===== Offline mode endpoints =====
    public class SaveKeyBody { public string? License { get; set; } public string? Key { get; set; } }

    [HttpPost("key")]
    public IActionResult SaveKey([FromBody] SaveKeyBody body)
    {
        var text = body?.License ?? body?.Key ?? "";
        if (string.IsNullOrWhiteSpace(text))
            return BadRequest(new { error = "license string required in body.license" });
        try { return Ok(new { ok = true, info = _license.SaveLicense(text) }); }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpDelete("key")]
    public IActionResult RemoveKey()
    {
        _license.RemoveLicense();
        return Ok(new { ok = true });
    }

    [HttpPost("revocation/refresh")]
    public async Task<IActionResult> RefreshRevocation()
    {
        var (ok, error) = await _license.RefreshRevocationNow();
        return Ok(new { ok, error });
    }

    // ===== Online mode endpoints =====
    public class CredBody { public string? Email { get; set; } public string? Password { get; set; } }

    [HttpPost("online/register")]
    public async Task<IActionResult> Register([FromBody] CredBody body)
    {
        try { return Ok(await _online.RegisterAsync(body?.Email ?? "", body?.Password ?? "")); }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpPost("online/login")]
    public async Task<IActionResult> Login([FromBody] CredBody body)
    {
        try { return Ok(await _online.LoginAsync(body?.Email ?? "", body?.Password ?? "")); }
        catch (Exception ex) { return StatusCode(401, new { error = ex.Message }); }
    }

    [HttpPost("online/logout")]
    public async Task<IActionResult> Logout()
    {
        try { await _online.LogoutAsync(); return Ok(new { ok = true }); }
        catch (Exception ex) { return StatusCode(500, new { error = ex.Message }); }
    }
}
