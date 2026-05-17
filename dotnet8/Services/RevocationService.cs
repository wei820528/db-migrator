using System.Net.Http;
using System.Text.Json;

namespace DbMigrator.Web.Services;

// Mirrors node-express/lib/revocation.js — fetches the revocation list at most
// once per 24h, caches to .revocation-cache.json. Status check itself is sync
// against the cache; the network refresh is fire-and-forget.

public class RevocationService
{
    private const int FetchIntervalHours = 24;
    public const int GraceDays = 30;
    private static readonly TimeSpan FetchTimeout = TimeSpan.FromSeconds(5);

    private readonly string _cachePath;
    private readonly HttpClient _http;
    private Task? _inflight;
    private readonly object _lock = new();

    public RevocationService()
    {
        _cachePath = Path.Combine(AppContext.BaseDirectory, ".revocation-cache.json");
        _http = new HttpClient { Timeout = FetchTimeout };
    }

    // For tests
    public RevocationService(string cachePath)
    {
        _cachePath = cachePath;
        _http = new HttpClient { Timeout = FetchTimeout };
    }

    public string CachePath => _cachePath;

    public record CacheData(
        DateTime FetchedAt,
        string? Source,
        List<string> Revoked,
        List<RevocationDetail> Details);

    public record RevocationDetail(string Id, DateTime? RevokedAt, string? Reason);

    public enum State { Revoked, Clear, Stale, Never }

    public record CheckResult(State State, DateTime? RevokedAt = null, string? Reason = null,
                              DateTime? FetchedAt = null, double DaysStale = 0);

    private CacheData? ReadCache()
    {
        if (!File.Exists(_cachePath)) return null;
        try
        {
            var json = File.ReadAllText(_cachePath);
            var raw = JsonSerializer.Deserialize<CacheRaw>(json,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (raw == null || raw.Revoked == null) return null;
            return new CacheData(raw.FetchedAt, raw.Source, raw.Revoked,
                raw.Details?.Select(d => new RevocationDetail(d.Id, d.RevokedAt, d.Reason)).ToList() ?? new());
        }
        catch { return null; }
    }

    private void WriteCache(CacheData c)
    {
        try
        {
            File.WriteAllText(_cachePath, JsonSerializer.Serialize(new CacheRaw
            {
                FetchedAt = c.FetchedAt,
                Source = c.Source,
                Revoked = c.Revoked,
                Details = c.Details.Select(d => new RawDetail { Id = d.Id, RevokedAt = d.RevokedAt, Reason = d.Reason }).ToList(),
            }, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { /* non-fatal */ }
    }

    public CheckResult CheckCache(string licenseId, DateTime? now = null)
    {
        var nowUtc = now ?? DateTime.UtcNow;
        var cache = ReadCache();
        if (cache == null) return new CheckResult(State.Never);
        if (cache.Revoked.Contains(licenseId))
        {
            var detail = cache.Details.FirstOrDefault(d => d.Id == licenseId);
            return new CheckResult(State.Revoked,
                RevokedAt: detail?.RevokedAt ?? cache.FetchedAt,
                Reason: detail?.Reason);
        }
        var daysStale = (nowUtc - cache.FetchedAt).TotalDays;
        if (daysStale > GraceDays) return new CheckResult(State.Stale, FetchedAt: cache.FetchedAt, DaysStale: daysStale);
        return new CheckResult(State.Clear, FetchedAt: cache.FetchedAt);
    }

    public bool ShouldRefetch(DateTime? now = null)
    {
        var nowUtc = now ?? DateTime.UtcNow;
        var cache = ReadCache();
        if (cache == null) return true;
        return (nowUtc - cache.FetchedAt).TotalHours > FetchIntervalHours;
    }

    public void MaybeRefresh(string? url)
    {
        if (string.IsNullOrEmpty(url) || !ShouldRefetch()) return;
        lock (_lock) { if (_inflight != null && !_inflight.IsCompleted) return; }
        _inflight = Task.Run(() => FetchAndStore(url));
    }

    public async Task<(bool ok, string? error)> RefreshNow(string? url)
    {
        if (string.IsNullOrEmpty(url)) return (false, "no url");
        return await FetchAndStore(url);
    }

    private async Task<(bool ok, string? error)> FetchAndStore(string url)
    {
        try
        {
            var resp = await _http.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return (false, $"HTTP {(int)resp.StatusCode}");
            var body = await resp.Content.ReadAsStringAsync();
            var parsed = JsonSerializer.Deserialize<ServerListResponse>(body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (parsed?.Revoked == null) return (false, "bad payload");
            var cache = new CacheData(
                DateTime.UtcNow, url,
                parsed.Revoked,
                (parsed.Details ?? new()).Select(d => new RevocationDetail(d.Id, d.RevokedAt, d.Reason)).ToList());
            WriteCache(cache);
            return (true, null);
        }
        catch (Exception e) { return (false, e.Message); }
    }

    private class CacheRaw
    {
        public DateTime FetchedAt { get; set; }
        public string? Source { get; set; }
        public List<string> Revoked { get; set; } = new();
        public List<RawDetail>? Details { get; set; }
    }

    private class RawDetail
    {
        public string Id { get; set; } = "";
        public DateTime? RevokedAt { get; set; }
        public string? Reason { get; set; }
    }

    private class ServerListResponse
    {
        public DateTime Updated { get; set; }
        public List<string>? Revoked { get; set; }
        public List<RawDetail>? Details { get; set; }
    }
}
