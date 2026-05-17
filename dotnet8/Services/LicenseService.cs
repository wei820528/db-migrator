using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace DbMigrator.Web.Services;

public class LicenseStatus
{
    public string Mode { get; set; } = "offline";      // offline | online | disabled
    public string Status { get; set; } = "expired";    // licensed | trial | free | expired | kicked | offline | disabled
    public int? DaysLeft { get; set; }
    public object? Info { get; set; }
    public string? Error { get; set; }
    public Dictionary<string, object?>? Features { get; set; }
    public object? User { get; set; }
    public int? MaxDevices { get; set; }
}

public class LicenseService
{
    private readonly LicenseOnlineService _online;
    private readonly RevocationService _revocation;
    public string Mode { get; }

    public LicenseService(LicenseOnlineService online, RevocationService revocation)
    {
        _online = online;
        _revocation = revocation;
        Mode = (Environment.GetEnvironmentVariable("LICENSE_MODE") ?? "offline").ToLowerInvariant();
        Console.WriteLine($"[license] mode={Mode}" +
            (Mode == "online" ? $" server={Environment.GetEnvironmentVariable("LICENSE_SERVER_URL") ?? "http://localhost:4000"}" : ""));
        if (Mode == "disabled") Console.WriteLine("[license] WARN: gate is OFF (do not use in production)");
    }

    public LicenseStatus GetStatus()
    {
        if (Mode == "disabled")
            return new LicenseStatus { Mode = "disabled", Status = "disabled" };
        if (Mode == "online")
        {
            var s = _online.GetState();
            return new LicenseStatus
            {
                Mode = "online",
                Status = s.Kicked ? "kicked" : (s.Status ?? (s.HasToken ? "trial" : "expired")),
                DaysLeft = s.DaysLeft,
                Error = s.LastError,
                Features = s.Features,
                User = s.User,
                MaxDevices = s.MaxDevices,
            };
        }
        // Offline
        return GetOfflineStatus();
    }

    // ============== OFFLINE MODE (Ed25519 signed key + .trial) ==============

    private const string PublicKeyPem = @"-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAREPLACE_WITH_YOUR_PUBLIC_KEY_AFTER_GENERATING_IT==
-----END PUBLIC KEY-----";

    private const int TrialDays = 32;
    private static readonly string Root = AppContext.BaseDirectory;
    private static readonly string LicensePath = Path.Combine(Root, "license.key");
    private static readonly string TrialPath = Path.Combine(Root, ".trial");

    public class LicensePayload
    {
        public string? Lid { get; set; }                    // v2+: UUID for remote revocation
        public string? Rurl { get; set; }                   // v2+: optional revocation URL override
        public string Customer { get; set; } = "";
        public string Plan { get; set; } = "";
        public int Users { get; set; }
        public DateTime Issued { get; set; }
        public DateTime Expires { get; set; }
        public int V { get; set; } = 1;
    }

    private string RevocationUrlFor(LicensePayload p) =>
        Environment.GetEnvironmentVariable("LICENSE_REVOCATION_URL")
        ?? p.Rurl
        ?? "";

    private LicenseStatus GetOfflineStatus()
    {
        var raw = ReadLicenseFile();
        if (!string.IsNullOrEmpty(raw))
        {
            try
            {
                var payload = VerifyLicenseString(raw);
                var daysLeft = Math.Max(0, (int)Math.Ceiling((payload.Expires - DateTime.UtcNow).TotalDays));

                // Remote kill switch — only meaningful if license has an `lid`
                if (!string.IsNullOrEmpty(payload.Lid))
                {
                    var url = RevocationUrlFor(payload);
                    if (!string.IsNullOrEmpty(url)) _revocation.MaybeRefresh(url);
                    var rc = _revocation.CheckCache(payload.Lid);

                    if (rc.State == RevocationService.State.Revoked)
                    {
                        return new LicenseStatus
                        {
                            Mode = "offline", Status = "revoked", DaysLeft = 0, Info = payload,
                            Error = rc.Reason != null ? $"License revoked: {rc.Reason}" : "License revoked by issuer",
                        };
                    }
                    if (rc.State == RevocationService.State.Stale)
                    {
                        return new LicenseStatus
                        {
                            Mode = "offline", Status = "expired", DaysLeft = 0, Info = payload,
                            Error = $"Revocation list unreachable for {Math.Floor(rc.DaysStale)} days. Connect this machine to the internet to verify.",
                        };
                    }
                    if (payload.Expires > DateTime.UtcNow)
                        return new LicenseStatus { Mode = "offline", Status = "licensed", DaysLeft = daysLeft, Info = payload };
                    return new LicenseStatus { Mode = "offline", Status = "expired", DaysLeft = 0, Info = payload, Error = "License expired" };
                }

                // Legacy license (no lid) — no revocation possible
                if (payload.Expires > DateTime.UtcNow)
                    return new LicenseStatus { Mode = "offline", Status = "licensed", DaysLeft = daysLeft, Info = payload };
                return new LicenseStatus { Mode = "offline", Status = "expired", DaysLeft = 0, Info = payload, Error = "License expired" };
            }
            catch (Exception ex)
            {
                return new LicenseStatus { Mode = "offline", Status = "expired", DaysLeft = 0, Error = ex.Message };
            }
        }
        var start = EnsureTrialStart();
        var elapsed = (DateTime.UtcNow - start).TotalDays;
        var daysLeftTrial = Math.Max(0, (int)Math.Ceiling(TrialDays - elapsed));
        if (daysLeftTrial > 0)
            return new LicenseStatus { Mode = "offline", Status = "trial", DaysLeft = daysLeftTrial, Info = new { trialStartedAt = start.ToString("O") } };
        return new LicenseStatus { Mode = "offline", Status = "expired", DaysLeft = 0, Error = "Trial period ended" };
    }

    public async Task<(bool ok, string? error)> RefreshRevocationNow()
    {
        var raw = ReadLicenseFile();
        if (string.IsNullOrEmpty(raw)) return (false, "no license");
        LicensePayload payload;
        try { payload = VerifyLicenseString(raw); }
        catch (Exception e) { return (false, e.Message); }
        if (string.IsNullOrEmpty(payload.Lid)) return (false, "license has no lid (legacy v1)");
        var url = RevocationUrlFor(payload);
        if (string.IsNullOrEmpty(url)) return (false, "no revocation URL configured");
        return await _revocation.RefreshNow(url);
    }

    public LicensePayload SaveLicense(string licenseString)
    {
        var payload = VerifyLicenseString(licenseString);
        File.WriteAllText(LicensePath, licenseString.Trim());
        return payload;
    }

    public void RemoveLicense()
    {
        if (File.Exists(LicensePath)) File.Delete(LicensePath);
    }

    private static string? ReadLicenseFile() =>
        File.Exists(LicensePath) ? File.ReadAllText(LicensePath) : null;

    private static DateTime? ReadTrialStart()
    {
        if (!File.Exists(TrialPath)) return null;
        try
        {
            var doc = JsonDocument.Parse(File.ReadAllText(TrialPath));
            if (doc.RootElement.TryGetProperty("first_run", out var fr))
                return DateTime.Parse(fr.GetString() ?? "", null, System.Globalization.DateTimeStyles.RoundtripKind);
        }
        catch { }
        return null;
    }

    private static DateTime EnsureTrialStart()
    {
        var t = ReadTrialStart();
        if (t == null)
        {
            var now = DateTime.UtcNow;
            File.WriteAllText(TrialPath, JsonSerializer.Serialize(new { first_run = now.ToString("O") }));
            return now;
        }
        return t.Value;
    }

    private LicensePayload VerifyLicenseString(string licenseString)
    {
        var parts = (licenseString ?? "").Trim().Split('.');
        if (parts.Length != 2) throw new Exception("License format invalid");
        var payloadB64 = parts[0];
        var sigBytes = Base64UrlDecodeToBytes(parts[1]);

        var pemBody = PublicKeyPem
            .Replace("-----BEGIN PUBLIC KEY-----", "")
            .Replace("-----END PUBLIC KEY-----", "")
            .Replace("\n", "").Replace("\r", "").Replace(" ", "");
        byte[] derBytes;
        try { derBytes = Convert.FromBase64String(pemBody); }
        catch { throw new Exception("App is missing a public key (development build?)"); }

        if (derBytes.Length < 32) throw new Exception("Invalid public key DER");
        var rawPub = derBytes[^32..];

        var ok = VerifyEd25519(rawPub, Encoding.UTF8.GetBytes(payloadB64), sigBytes);
        if (!ok) throw new Exception("License signature invalid (was it tampered or issued by someone else?)");

        var payloadJson = Base64UrlDecodeToString(payloadB64);
        var payload = JsonSerializer.Deserialize<LicensePayload>(payloadJson,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new Exception("License payload parse failed");
        if (payload.Expires == default) throw new Exception("License missing expiry");
        return payload;
    }

    private static bool VerifyEd25519(byte[] pubKey, byte[] msg, byte[] sig)
    {
        var verifier = new Org.BouncyCastle.Crypto.Signers.Ed25519Signer();
        var pubParam = new Org.BouncyCastle.Crypto.Parameters.Ed25519PublicKeyParameters(pubKey, 0);
        verifier.Init(false, pubParam);
        verifier.BlockUpdate(msg, 0, msg.Length);
        return verifier.VerifySignature(sig);
    }

    private static string Base64UrlDecodeToString(string s)
    {
        var pad = (4 - s.Length % 4) % 4;
        var b64 = s.Replace('-', '+').Replace('_', '/') + new string('=', pad);
        return Encoding.UTF8.GetString(Convert.FromBase64String(b64));
    }
    private static byte[] Base64UrlDecodeToBytes(string s)
    {
        var pad = (4 - s.Length % 4) % 4;
        var b64 = s.Replace('-', '+').Replace('_', '/') + new string('=', pad);
        return Convert.FromBase64String(b64);
    }
}
