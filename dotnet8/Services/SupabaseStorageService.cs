using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using DbMigrator.Web.Models;

namespace DbMigrator.Web.Services;

public class SupabaseStorageService
{
    private static readonly HttpClient _http = new() { Timeout = TimeSpan.FromMinutes(10) };

    private static HttpRequestMessage Build(StorageConfig c, HttpMethod m, string path, HttpContent? body = null)
    {
        var req = new HttpRequestMessage(m, c.Url.TrimEnd('/') + path);
        req.Headers.Add("apikey", c.ServiceKey);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", c.ServiceKey);
        if (body != null) req.Content = body;
        return req;
    }

    public class Bucket { public string Id { get; set; } = ""; public string Name { get; set; } = ""; public bool Public { get; set; } }

    public async Task<List<Bucket>> ListBucketsAsync(StorageConfig c, CancellationToken ct = default)
    {
        var resp = await _http.SendAsync(Build(c, HttpMethod.Get, "/storage/v1/bucket"), ct);
        var json = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode) throw new Exception($"listBuckets {resp.StatusCode}: {json}");
        return JsonSerializer.Deserialize<List<Bucket>>(json,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();
    }

    public class FileItem { public string Name { get; set; } = ""; public string? Id { get; set; } }

    private async Task<List<FileItem>> ListAsync(StorageConfig c, string bucket, string prefix, int offset, CancellationToken ct)
    {
        var body = new StringContent(
            JsonSerializer.Serialize(new { prefix, limit = 1000, offset, sortBy = new { column = "name", order = "asc" } }),
            Encoding.UTF8, "application/json");
        var resp = await _http.SendAsync(Build(c, HttpMethod.Post, $"/storage/v1/object/list/{bucket}", body), ct);
        var json = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode) throw new Exception($"list {bucket}/{prefix} {resp.StatusCode}: {json}");
        return JsonSerializer.Deserialize<List<FileItem>>(json,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();
    }

    private async Task<List<string>> ListAllFilesAsync(StorageConfig c, string bucket, string prefix, CancellationToken ct)
    {
        var out_ = new List<string>();
        int offset = 0;
        while (true)
        {
            var page = await ListAsync(c, bucket, prefix, offset, ct);
            if (page.Count == 0) break;
            foreach (var item in page)
            {
                var full = string.IsNullOrEmpty(prefix) ? item.Name : $"{prefix}/{item.Name}";
                if (item.Id == null)
                    out_.AddRange(await ListAllFilesAsync(c, bucket, full, ct));
                else
                    out_.Add(full);
            }
            if (page.Count < 1000) break;
            offset += page.Count;
        }
        return out_;
    }

    public async Task<(int BucketCount, int FileCount)> DownloadAllAsync(
        StorageConfig c, string destDir, Action<string>? onProgress, CancellationToken ct = default)
    {
        Directory.CreateDirectory(destDir);
        var buckets = await ListBucketsAsync(c, ct);
        onProgress?.Invoke($"Found {buckets.Count} bucket(s)");

        int total = 0;
        foreach (var bucket in buckets)
        {
            ct.ThrowIfCancellationRequested();
            onProgress?.Invoke($"> bucket: {bucket.Name}");
            var files = await ListAllFilesAsync(c, bucket.Name, "", ct);
            onProgress?.Invoke($"  {files.Count} file(s)");

            var bucketDir = Path.Combine(destDir, bucket.Name);
            Directory.CreateDirectory(bucketDir);
            File.WriteAllText(
                Path.Combine(destDir, $"{bucket.Name}.bucket.json"),
                JsonSerializer.Serialize(new { bucket.Id, bucket.Name, bucket.Public })
            );

            foreach (var f in files)
            {
                ct.ThrowIfCancellationRequested();
                var resp = await _http.SendAsync(Build(c, HttpMethod.Get, $"/storage/v1/object/{bucket.Name}/{Uri.EscapeUriString(f)}"), ct);
                if (!resp.IsSuccessStatusCode)
                {
                    onProgress?.Invoke($"  ! {f}: {resp.StatusCode}");
                    continue;
                }
                var localPath = Path.Combine(bucketDir, f.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(localPath)!);
                await using var fs = File.Create(localPath);
                await resp.Content.CopyToAsync(fs, ct);
                total++;
                if (total % 50 == 0) onProgress?.Invoke($"  downloaded {total} file(s)...");
            }
        }
        onProgress?.Invoke($"Total: {total} file(s) across {buckets.Count} bucket(s)");
        return (buckets.Count, total);
    }

    public async Task<(int BucketCount, int FileCount)> UploadAllAsync(
        StorageConfig c, string srcDir, Action<string>? onProgress, CancellationToken ct = default)
    {
        if (!Directory.Exists(srcDir))
        {
            onProgress?.Invoke("No storage dir in backup, skipping");
            return (0, 0);
        }

        var existingNames = (await ListBucketsAsync(c, ct)).Select(b => b.Name).ToHashSet();
        var bucketDirs = Directory.EnumerateDirectories(srcDir).Select(p => Path.GetFileName(p)!).ToList();

        int total = 0;
        foreach (var bucketName in bucketDirs)
        {
            ct.ThrowIfCancellationRequested();
            onProgress?.Invoke($"> bucket: {bucketName}");

            if (!existingNames.Contains(bucketName))
            {
                var metaPath = Path.Combine(srcDir, $"{bucketName}.bucket.json");
                bool isPublic = false;
                if (File.Exists(metaPath))
                {
                    try { isPublic = JsonDocument.Parse(File.ReadAllText(metaPath)).RootElement.GetProperty("Public").GetBoolean(); } catch { }
                }
                var body = new StringContent(JsonSerializer.Serialize(new { id = bucketName, name = bucketName, @public = isPublic }),
                    Encoding.UTF8, "application/json");
                var resp = await _http.SendAsync(Build(c, HttpMethod.Post, "/storage/v1/bucket", body), ct);
                if (!resp.IsSuccessStatusCode)
                {
                    var err = await resp.Content.ReadAsStringAsync(ct);
                    onProgress?.Invoke($"  ! createBucket failed: {err}");
                    continue;
                }
                onProgress?.Invoke($"  created bucket (public={isPublic})");
            }

            var bucketDir = Path.Combine(srcDir, bucketName);
            var files = Directory.EnumerateFiles(bucketDir, "*", SearchOption.AllDirectories).ToList();
            onProgress?.Invoke($"  uploading {files.Count} file(s)...");

            foreach (var localPath in files)
            {
                ct.ThrowIfCancellationRequested();
                var rel = Path.GetRelativePath(bucketDir, localPath).Replace(Path.DirectorySeparatorChar, '/');
                var bytes = await File.ReadAllBytesAsync(localPath, ct);
                var content = new ByteArrayContent(bytes);
                content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                // upsert: use x-upsert header
                var req = Build(c, HttpMethod.Post, $"/storage/v1/object/{bucketName}/{Uri.EscapeUriString(rel)}", content);
                req.Headers.Add("x-upsert", "true");
                var resp = await _http.SendAsync(req, ct);
                if (!resp.IsSuccessStatusCode)
                {
                    var err = await resp.Content.ReadAsStringAsync(ct);
                    onProgress?.Invoke($"  ! {rel}: {err}");
                    continue;
                }
                total++;
                if (total % 50 == 0) onProgress?.Invoke($"  uploaded {total} file(s)...");
            }
        }
        onProgress?.Invoke($"Total: {total} file(s) across {bucketDirs.Count} bucket(s)");
        return (bucketDirs.Count, total);
    }
}
