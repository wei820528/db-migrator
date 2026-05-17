using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace DbMigrator.Web.Services;

// Online license: talk to a license server. Login + heartbeat + cached state.
// Equivalent to node-express/lib/license-online.js.

public class LicenseOnlineState
{
    public string ServerUrl { get; set; } = "";
    public bool HasToken { get; set; }
    public string? Token { get; set; }
    public object? User { get; set; }
    public string? Status { get; set; }       // 'trial' | 'licensed' | 'free' | 'expired' | 'kicked' | 'offline'
    public int? DaysLeft { get; set; }
    public Dictionary<string, object?> Features { get; set; } = new();
    public int? MaxDevices { get; set; }
    public bool Kicked { get; set; }
    public string? LastError { get; set; }
    public string? LastHeartbeat { get; set; }
}

public class LicenseOnlineService : IHostedService
{
    private static readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private static readonly JsonSerializerOptions _json = new() { PropertyNameCaseInsensitive = true };

    private readonly string _serverUrl;
    private readonly string _tokenPath;
    private readonly LicenseOnlineState _state = new();
    private Timer? _heartbeatTimer;
    private readonly object _lock = new();

    public LicenseOnlineService()
    {
        _serverUrl = (Environment.GetEnvironmentVariable("LICENSE_SERVER_URL") ?? "http://localhost:4000").TrimEnd('/');
        _tokenPath = Path.Combine(AppContext.BaseDirectory, ".auth-token");
        _state.ServerUrl = _serverUrl;
    }

    public Task StartAsync(CancellationToken ct)
    {
        // Load stored token
        if (File.Exists(_tokenPath))
        {
            try { _state.Token = File.ReadAllText(_tokenPath).Trim(); _state.HasToken = true; } catch { }
        }
        // Initial heartbeat + 30s loop
        _ = HeartbeatAsync();
        _heartbeatTimer = new Timer(_ => _ = HeartbeatAsync(), null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken ct)
    {
        _heartbeatTimer?.Dispose();
        return Task.CompletedTask;
    }

    public LicenseOnlineState GetState()
    {
        lock (_lock) return Clone(_state);
    }

    public bool HasFeature(string name)
    {
        lock (_lock)
        {
            if (_state.Features.TryGetValue(name, out var v) && v is bool b) return b;
            return false;
        }
    }

    public T? GetFeature<T>(string name)
    {
        lock (_lock)
        {
            if (_state.Features.TryGetValue(name, out var v) && v is T t) return t;
            return default;
        }
    }

    public async Task<JsonElement> RegisterAsync(string email, string password)
    {
        var r = await CallAsync(HttpMethod.Post, "/api/auth/register", new { email, password }, null);
        if (!r.Ok) throw new Exception(r.ErrorMessage ?? "register failed");
        return r.Data;
    }

    public async Task<JsonElement> LoginAsync(string email, string password)
    {
        var r = await CallAsync(HttpMethod.Post, "/api/auth/login", new { email, password }, null);
        if (!r.Ok) throw new Exception(r.ErrorMessage ?? "login failed");

        var token = r.Data.TryGetProperty("token", out var t) ? t.GetString() : null;
        if (!string.IsNullOrEmpty(token))
        {
            try { File.WriteAllText(_tokenPath, token); } catch { }
            lock (_lock) { _state.Token = token; _state.HasToken = true; }
        }
        ApplyResponse(r.Data);
        return r.Data;
    }

    public async Task LogoutAsync()
    {
        string? token; lock (_lock) token = _state.Token;
        if (!string.IsNullOrEmpty(token))
        {
            try { await CallAsync(HttpMethod.Post, "/api/auth/logout", null, token); } catch { }
        }
        try { if (File.Exists(_tokenPath)) File.Delete(_tokenPath); } catch { }
        lock (_lock)
        {
            _state.Token = null; _state.HasToken = false;
            _state.User = null; _state.Status = null; _state.DaysLeft = null;
            _state.Features.Clear(); _state.Kicked = false;
        }
    }

    public async Task<LicenseOnlineState> HeartbeatAsync()
    {
        string? token; lock (_lock) token = _state.Token;
        if (string.IsNullOrEmpty(token))
        {
            lock (_lock) _state.Status = "expired";
            return GetState();
        }
        try
        {
            var r = await CallAsync(HttpMethod.Post, "/api/auth/heartbeat", null, token);
            if (r.StatusCode == 401)
            {
                lock (_lock)
                {
                    _state.Kicked = true; _state.Status = "kicked";
                    _state.LastError = r.ErrorMessage ?? "kicked";
                    _state.Token = null; _state.HasToken = false;
                }
                try { if (File.Exists(_tokenPath)) File.Delete(_tokenPath); } catch { }
                return GetState();
            }
            if (r.StatusCode == 403)
            {
                lock (_lock) { _state.Status = "expired"; _state.LastError = r.ErrorMessage ?? "expired"; }
                return GetState();
            }
            if (!r.Ok)
            {
                lock (_lock) _state.LastError = r.ErrorMessage ?? $"heartbeat failed ({r.StatusCode})";
                return GetState();
            }
            ApplyResponse(r.Data);
            return GetState();
        }
        catch (Exception ex)
        {
            lock (_lock)
            {
                _state.LastError = $"cannot reach license server: {ex.Message}";
                if (_state.Status == null) _state.Status = "offline";
            }
            return GetState();
        }
    }

    private void ApplyResponse(JsonElement d)
    {
        lock (_lock)
        {
            if (d.TryGetProperty("user", out var u)) _state.User = JsonSerializer.Deserialize<Dictionary<string, object?>>(u.GetRawText(), _json);
            if (d.TryGetProperty("status", out var s)) _state.Status = s.GetString();
            if (d.TryGetProperty("daysLeft", out var dl) && dl.ValueKind != JsonValueKind.Null) _state.DaysLeft = dl.GetInt32();
            if (d.TryGetProperty("maxDevices", out var md) && md.ValueKind != JsonValueKind.Null) _state.MaxDevices = md.GetInt32();
            if (d.TryGetProperty("features", out var f) && f.ValueKind == JsonValueKind.Object)
            {
                _state.Features.Clear();
                foreach (var p in f.EnumerateObject())
                {
                    _state.Features[p.Name] = p.Value.ValueKind switch
                    {
                        JsonValueKind.True => true,
                        JsonValueKind.False => false,
                        JsonValueKind.Number => p.Value.TryGetInt32(out var iv) ? iv : (object?)p.Value.GetDouble(),
                        JsonValueKind.String => p.Value.GetString(),
                        JsonValueKind.Null => null,
                        _ => p.Value.GetRawText(),
                    };
                }
            }
            _state.Kicked = false;
            _state.LastError = null;
            _state.LastHeartbeat = DateTime.UtcNow.ToString("O");
        }
    }

    private record CallResult(bool Ok, int StatusCode, JsonElement Data, string? ErrorMessage);

    private async Task<CallResult> CallAsync(HttpMethod method, string path, object? body, string? token)
    {
        using var req = new HttpRequestMessage(method, _serverUrl + path);
        if (body != null)
            req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        if (!string.IsNullOrEmpty(token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        using var resp = await _http.SendAsync(req);
        var text = await resp.Content.ReadAsStringAsync();
        JsonElement data;
        try { data = JsonDocument.Parse(string.IsNullOrEmpty(text) ? "{}" : text).RootElement.Clone(); }
        catch { data = JsonDocument.Parse("{}").RootElement.Clone(); }

        string? err = null;
        if (!resp.IsSuccessStatusCode && data.TryGetProperty("error", out var e))
            err = e.GetString();

        return new CallResult(resp.IsSuccessStatusCode, (int)resp.StatusCode, data, err);
    }

    private static LicenseOnlineState Clone(LicenseOnlineState s) => new()
    {
        ServerUrl = s.ServerUrl,
        HasToken = s.HasToken,
        Token = s.Token,
        User = s.User,
        Status = s.Status,
        DaysLeft = s.DaysLeft,
        Features = new Dictionary<string, object?>(s.Features),
        MaxDevices = s.MaxDevices,
        Kicked = s.Kicked,
        LastError = s.LastError,
        LastHeartbeat = s.LastHeartbeat,
    };
}
