using DbMigrator.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace DbMigrator.Web.Controllers;

[ApiController]
[Route("api/marketplace")]
public class MarketplaceController : ControllerBase
{
    private readonly MarketplaceService _mp;
    public MarketplaceController(MarketplaceService mp) { _mp = mp; }

    public class UrlBody { public string? Url { get; set; } public bool AllowUnsigned { get; set; } }
    public class TrustBody { public string? Id { get; set; } public string? Pem { get; set; } }

    [HttpPost("preview")]
    public async Task<IActionResult> Preview([FromBody] UrlBody body)
    {
        try
        {
            var r = await _mp.PreviewAsync(body?.Url ?? "");
            return Ok(new
            {
                source = new { r.Source.Owner, r.Source.Repo, r.Source.Ref, r.Source.Base, r.Source.HtmlBase },
                manifest = r.Manifest,
                signature = r.Signature,
                files = r.Files.Select(f => new { runtime = f.Runtime, path = f.Path, bytes = f.Bytes, hash = f.Hash, hashOk = f.HashOk }),
            });
        }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpPost("install")]
    public async Task<IActionResult> Install([FromBody] UrlBody body)
    {
        try { return Ok(await _mp.InstallAsync(body?.Url ?? "", body?.AllowUnsigned ?? false)); }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpGet("installed")]
    public IActionResult Installed() => Ok(new { plugins = _mp.ListInstalled() });

    [HttpDelete("installed/{name}")]
    public IActionResult Uninstall(string name)
    {
        try { _mp.Uninstall(name); return Ok(new { ok = true }); }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpGet("trusted")]
    public IActionResult Trusted() =>
        Ok(new { publishers = _mp.LoadTrustedPublishers().Select(p => new { id = p.Id, fingerprint = _mp.FingerprintOfPem(p.Pem) }) });

    [HttpPost("trusted")]
    public IActionResult AddTrusted([FromBody] TrustBody body)
    {
        try { _mp.AddTrustedPublisher(body?.Id ?? "", body?.Pem ?? ""); return Ok(new { ok = true }); }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpDelete("trusted/{id}")]
    public IActionResult RemoveTrusted(string id)
    {
        _mp.RemoveTrustedPublisher(id);
        return Ok(new { ok = true });
    }
}
