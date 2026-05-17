using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace DbMigrator.Web.Services;

// Mirrors node-express/lib/marketplace.js — same manifest format, same
// canonical JSON, same trust store. A plugin signed by the project key
// installs cleanly on either runtime.
//
// Stores plugins under <ContentRoot>/Plugins/marketplace/<name>/.
// (Built-in .cs plugins live under Plugins/ at the source level; marketplace
// plugins land in a separate subfolder so they don't get confused with them.)
public class MarketplaceService
{
    private const int FetchTimeoutSeconds = 15;
    private const int MaxFileBytes = 2 * 1024 * 1024;
    private const int MaxFiles = 50;

    private readonly HttpClient _http;
    private readonly string _root;
    private readonly string _pluginsDir;
    private readonly string _trustFile;
    private readonly string _defaultPublisherPem;

    public MarketplaceService(IWebHostEnvironment env)
    {
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(FetchTimeoutSeconds) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("DbMigrator/1.0");
        _root = env.ContentRootPath;
        _pluginsDir = Path.Combine(_root, "Plugins", "marketplace");
        Directory.CreateDirectory(_pluginsDir);
        _trustFile = Path.Combine(_root, "trusted-publishers.json");
        _defaultPublisherPem = Path.GetFullPath(Path.Combine(_root, "..", "license-tools", "public-key.pem"));
    }

    // ---------- GitHub URL parsing ----------

    public record ParsedUrl(string Owner, string Repo, string Ref, string Base, string HtmlBase);

    public static ParsedUrl ParseGithubUrl(string input)
    {
        if (!Uri.TryCreate(input?.Trim(), UriKind.Absolute, out var u))
            throw new Exception("Not a valid URL");
        if (!u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase))
            throw new Exception("Only github.com URLs are accepted");
        var parts = u.AbsolutePath.Trim('/').Split('/');
        if (parts.Length < 2) throw new Exception("URL must include owner/repo");
        var owner = parts[0];
        var repo = Regex.Replace(parts[1], @"\.git$", "", RegexOptions.IgnoreCase);
        var refName = (parts.Length >= 4 && parts[2] == "tree") ? parts[3] : "main";
        return new ParsedUrl(owner, repo, refName,
            $"https://raw.githubusercontent.com/{owner}/{repo}/{refName}",
            $"https://github.com/{owner}/{repo}/tree/{refName}");
    }

    // ---------- Trust store ----------

    public record TrustedPublisher(string Id, string Pem);

    public List<TrustedPublisher> LoadTrustedPublishers()
    {
        var list = new List<TrustedPublisher>();
        if (File.Exists(_defaultPublisherPem))
        {
            try { list.Add(new TrustedPublisher("project-default", File.ReadAllText(_defaultPublisherPem))); }
            catch { }
        }
        if (File.Exists(_trustFile))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(_trustFile));
                if (doc.RootElement.TryGetProperty("publishers", out var arr) && arr.ValueKind == JsonValueKind.Array)
                    foreach (var p in arr.EnumerateArray())
                        if (p.TryGetProperty("id", out var id) && p.TryGetProperty("pem", out var pem))
                            list.Add(new TrustedPublisher(id.GetString() ?? "", pem.GetString() ?? ""));
            }
            catch { }
        }
        return list;
    }

    public void AddTrustedPublisher(string id, string pem)
    {
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(pem))
            throw new Exception("id and pem required");
        // Validate the PEM parses
        try { _ = PublicKeyFromPem(pem); } catch (Exception e) { throw new Exception("invalid PEM: " + e.Message); }

        var existing = new List<JsonObject>();
        if (File.Exists(_trustFile))
        {
            try
            {
                var node = JsonNode.Parse(File.ReadAllText(_trustFile))!.AsObject();
                if (node["publishers"] is JsonArray arr)
                    foreach (var n in arr)
                        if (n is JsonObject o && (o["id"]?.GetValue<string>() ?? "") != id)
                            existing.Add(o);
            }
            catch { }
        }
        existing.Add(new JsonObject { ["id"] = id, ["pem"] = pem });
        var outNode = new JsonObject { ["publishers"] = new JsonArray(existing.Cast<JsonNode>().ToArray()) };
        File.WriteAllText(_trustFile, outNode.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    public void RemoveTrustedPublisher(string id)
    {
        if (!File.Exists(_trustFile)) return;
        try
        {
            var node = JsonNode.Parse(File.ReadAllText(_trustFile))!.AsObject();
            if (node["publishers"] is JsonArray arr)
            {
                var keep = arr.OfType<JsonObject>().Where(o => (o["id"]?.GetValue<string>() ?? "") != id).Cast<JsonNode>().ToArray();
                node["publishers"] = new JsonArray(keep);
            }
            File.WriteAllText(_trustFile, node.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }

    // ---------- Canonical JSON + signature verification ----------

    // Identical to the Node version — sort keys, no whitespace.
    public static string CanonicalJson(JsonNode? node)
    {
        if (node == null) return "null";
        return node switch
        {
            JsonValue v   => v.ToJsonString(),
            JsonArray a   => "[" + string.Join(",", a.Select(CanonicalJson)) + "]",
            JsonObject o  => "{" + string.Join(",",
                                o.Where(kv => kv.Value != null)
                                 .OrderBy(kv => kv.Key, StringComparer.Ordinal)
                                 .Select(kv => JsonSerializer.Serialize(kv.Key) + ":" + CanonicalJson(kv.Value)))
                            + "}",
            _ => node.ToJsonString(),
        };
    }

    public record SignatureInfo(bool Signed, string? Publisher = null, bool Trusted = false, string? Error = null);

    public SignatureInfo VerifyManifestSignature(JsonObject manifest)
    {
        if (manifest["signature"] is not JsonValue sv || string.IsNullOrEmpty(sv.GetValue<string>()))
            return new SignatureInfo(false);

        var sig = Convert.FromBase64String(sv.GetValue<string>());
        var copy = JsonNode.Parse(manifest.ToJsonString())!.AsObject();
        copy["signature"] = "";
        var msg = Encoding.UTF8.GetBytes(CanonicalJson(copy));

        foreach (var pub in LoadTrustedPublishers())
        {
            try
            {
                using var key = PublicKeyFromPem(pub.Pem);
                if (Ed25519Verify(key, msg, sig))
                    return new SignatureInfo(true, pub.Id, true);
            }
            catch { }
        }
        return new SignatureInfo(true, null, false, "signature does not match any trusted publisher");
    }

    // Ed25519: .NET 8 has no built-in support for Ed25519, so re-use the BouncyCastle
    // path already in the project (same as LicenseService).
    private static Org.BouncyCastle.Crypto.Parameters.Ed25519PublicKeyParameters PublicKeyFromPem(string pem)
    {
        var body = pem.Replace("-----BEGIN PUBLIC KEY-----", "")
                      .Replace("-----END PUBLIC KEY-----", "")
                      .Replace("\n", "").Replace("\r", "").Replace(" ", "");
        var der = Convert.FromBase64String(body);
        if (der.Length < 32) throw new Exception("Invalid public key DER");
        var rawPub = der[^32..];
        return new Org.BouncyCastle.Crypto.Parameters.Ed25519PublicKeyParameters(rawPub, 0);
    }

    private static bool Ed25519Verify(Org.BouncyCastle.Crypto.Parameters.Ed25519PublicKeyParameters pub, byte[] msg, byte[] sig)
    {
        var verifier = new Org.BouncyCastle.Crypto.Signers.Ed25519Signer();
        verifier.Init(false, pub);
        verifier.BlockUpdate(msg, 0, msg.Length);
        return verifier.VerifySignature(sig);
    }

    // ---------- Manifest validation ----------

    private static readonly Regex SlugRx   = new("^[a-z0-9][a-z0-9_-]{0,63}$", RegexOptions.IgnoreCase);
    private static readonly Regex SafePath = new("^[a-z0-9_./-]+$", RegexOptions.IgnoreCase);

    public void ValidateManifestShape(JsonObject m)
    {
        var name = m["name"]?.GetValue<string>();
        if (string.IsNullOrEmpty(name) || !SlugRx.IsMatch(name))
            throw new Exception("manifest.name must be a slug (alnum / _ / -, ≤ 64 chars)");
        if (string.IsNullOrEmpty(m["version"]?.GetValue<string>()))
            throw new Exception("manifest.version required");
        if (m["files"] is not JsonObject files) throw new Exception("manifest.files required");

        int totalFiles = 0;
        foreach (var (rt, arr) in files)
        {
            if (rt != "node-express" && rt != "dotnet8" && rt != "shared")
                throw new Exception($"Unknown runtime in files: {rt}");
            if (arr is not JsonArray a) throw new Exception($"files.{rt} must be array");
            foreach (var f in a)
            {
                var s = f?.GetValue<string>() ?? "";
                if (!IsSafeRelativePath(s)) throw new Exception($"Unsafe file path: {s}");
                totalFiles++;
            }
        }
        if (totalFiles == 0) throw new Exception("manifest lists no files");
        if (totalFiles > MaxFiles) throw new Exception($"too many files (max {MaxFiles})");
    }

    public static bool IsSafeRelativePath(string p)
    {
        if (string.IsNullOrEmpty(p)) return false;
        if (Path.IsPathRooted(p)) return false;
        if (Regex.IsMatch(p, @"^[A-Za-z]:[\\/]")) return false;
        var n = p.Replace('\\', '/');
        if (n.Split('/').Contains("..")) return false;
        return SafePath.IsMatch(n);
    }

    // ---------- Preview / install ----------

    public record FileEntry(string Runtime, string Path, int Bytes, string Hash, bool HashOk, byte[]? Body);

    public record PreviewResult(ParsedUrl Source, JsonObject Manifest, SignatureInfo Signature, List<FileEntry> Files);

    public async Task<PreviewResult> PreviewAsync(string githubUrl)
    {
        var g = ParseGithubUrl(githubUrl);
        var manifestBytes = await FetchAsync($"{g.Base}/plugin.json");
        JsonObject manifest;
        try { manifest = JsonNode.Parse(Encoding.UTF8.GetString(manifestBytes))!.AsObject(); }
        catch { throw new Exception("plugin.json is not valid JSON"); }
        ValidateManifestShape(manifest);

        var sig = VerifyManifestSignature(manifest);

        // For .NET we only fetch dotnet8 + shared files (so a plugin that only
        // ships node-express files installs as an empty payload here — that's OK).
        var wanted = new List<(string rt, string f)>();
        if (manifest["files"] is JsonObject filesObj)
        {
            foreach (var rt in new[] { "dotnet8", "shared" })
                if (filesObj[rt] is JsonArray arr)
                    foreach (var n in arr)
                        wanted.Add((rt, n!.GetValue<string>()));
        }

        var fetched = new List<FileEntry>();
        var hashesObj = manifest["hashes"] as JsonObject;
        foreach (var (rt, f) in wanted)
        {
            var body = await FetchAsync($"{g.Base}/{f}");
            var hex = Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant();
            var expected = (hashesObj?[rt] as JsonObject)?[f]?.GetValue<string>();
            if (expected != null && !expected.Equals(hex, StringComparison.OrdinalIgnoreCase))
                throw new Exception($"Hash mismatch for {rt}/{f}: manifest says {expected[..16]}…, got {hex[..16]}…");
            fetched.Add(new FileEntry(rt, f, body.Length, hex, expected == null || expected.Equals(hex, StringComparison.OrdinalIgnoreCase), body));
        }
        return new PreviewResult(g, manifest, sig, fetched);
    }

    public record InstallResult(bool Ok, string Installed, string Version, int FileCount, bool Signed, bool Trusted, string InstallPath);

    public async Task<InstallResult> InstallAsync(string githubUrl, bool allowUnsigned)
    {
        var prev = await PreviewAsync(githubUrl);
        if (!prev.Signature.Signed && !allowUnsigned)
            throw new Exception("plugin is unsigned — re-run with allowUnsigned=true after reviewing source");
        if (prev.Signature.Signed && !prev.Signature.Trusted && !allowUnsigned)
            throw new Exception("plugin signed by untrusted publisher: " + (prev.Signature.Error ?? "unknown"));
        foreach (var f in prev.Files)
            if (!f.HashOk) throw new Exception($"hash failed for {f.Path}");

        var name = prev.Manifest["name"]!.GetValue<string>();
        var version = prev.Manifest["version"]!.GetValue<string>();
        var pluginRoot = Path.Combine(_pluginsDir, name);
        if (!IsInside(pluginRoot, _pluginsDir)) throw new Exception("install path escape attempt");

        var staging = pluginRoot + ".staging-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Directory.CreateDirectory(staging);
        try
        {
            File.WriteAllText(Path.Combine(staging, "plugin.json"), prev.Manifest.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            foreach (var f in prev.Files)
            {
                if (f.Body == null) continue;
                var outPath = Path.Combine(staging, f.Path.Replace('/', Path.DirectorySeparatorChar));
                if (!IsInside(outPath, staging)) throw new Exception($"path escape on file {f.Path}");
                Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
                await File.WriteAllBytesAsync(outPath, f.Body);
            }
            if (Directory.Exists(pluginRoot)) Directory.Delete(pluginRoot, true);
            Directory.Move(staging, pluginRoot);
        }
        catch
        {
            try { Directory.Delete(staging, true); } catch { }
            throw;
        }

        return new InstallResult(true, name, version, prev.Files.Count,
                                 prev.Signature.Signed, prev.Signature.Trusted, pluginRoot);
    }

    public record InstalledPlugin(string Name, string Version, string Description, bool Signed, string Dir);

    public List<InstalledPlugin> ListInstalled()
    {
        var list = new List<InstalledPlugin>();
        if (!Directory.Exists(_pluginsDir)) return list;
        foreach (var dir in Directory.GetDirectories(_pluginsDir))
        {
            var mfPath = Path.Combine(dir, "plugin.json");
            if (!File.Exists(mfPath)) continue;
            try
            {
                var m = JsonNode.Parse(File.ReadAllText(mfPath))!.AsObject();
                list.Add(new InstalledPlugin(
                    m["name"]?.GetValue<string>() ?? "?",
                    m["version"]?.GetValue<string>() ?? "?",
                    m["description"]?.GetValue<string>() ?? "",
                    !string.IsNullOrEmpty(m["signature"]?.GetValue<string>()),
                    Path.GetFileName(dir)));
            }
            catch { }
        }
        return list;
    }

    public void Uninstall(string name)
    {
        if (!SlugRx.IsMatch(name)) throw new Exception("bad plugin name");
        var dir = Path.Combine(_pluginsDir, name);
        if (!IsInside(dir, _pluginsDir)) throw new Exception("path escape");
        if (!Directory.Exists(dir)) throw new Exception("not installed: " + name);
        Directory.Delete(dir, true);
    }

    // ---------- Helpers ----------

    private async Task<byte[]> FetchAsync(string url)
    {
        using var resp = await _http.GetAsync(url);
        if (!resp.IsSuccessStatusCode) throw new Exception($"HTTP {(int)resp.StatusCode} for {url}");
        var body = await resp.Content.ReadAsByteArrayAsync();
        if (body.Length > MaxFileBytes) throw new Exception($"File exceeds {MaxFileBytes} bytes");
        return body;
    }

    public static bool IsInside(string target, string parent)
    {
        var t = Path.GetFullPath(target);
        var p = Path.GetFullPath(parent);
        return t == p || t.StartsWith(p + Path.DirectorySeparatorChar);
    }

    public string FingerprintOfPem(string pem)
    {
        try
        {
            var body = pem.Replace("-----BEGIN PUBLIC KEY-----", "")
                          .Replace("-----END PUBLIC KEY-----", "")
                          .Replace("\n", "").Replace("\r", "").Replace(" ", "");
            var der = Convert.FromBase64String(body);
            return Convert.ToHexString(SHA256.HashData(der)).ToLowerInvariant()[..32];
        }
        catch { return ""; }
    }
}
