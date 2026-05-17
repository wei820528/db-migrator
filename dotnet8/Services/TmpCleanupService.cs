namespace DbMigrator.Web.Services;

// Periodically cleans tmp/ — both job dirs (tmp/<id>/) and tmp/uploads/.
// Anything older than AgeHours is removed. Default: 24h age, 6h interval.

public class TmpCleanupService : IHostedService, IDisposable
{
    private static readonly string TmpDir = Path.Combine(AppContext.BaseDirectory, "tmp");
    private readonly int _ageHours;
    private readonly int _intervalHours;
    private Timer? _timer;

    public TmpCleanupService()
    {
        _ageHours = int.TryParse(Environment.GetEnvironmentVariable("TMP_CLEANUP_AGE_HOURS"), out var a) ? a : 24;
        _intervalHours = int.TryParse(Environment.GetEnvironmentVariable("TMP_CLEANUP_INTERVAL_HOURS"), out var i) ? i : 6;
    }

    public Task StartAsync(CancellationToken ct)
    {
        Console.WriteLine($"[tmp-cleanup] enabled (age={_ageHours}h, interval={_intervalHours}h)");
        // First run after 30s, then every intervalHours
        _timer = new Timer(_ => RunSafe(), null, TimeSpan.FromSeconds(30), TimeSpan.FromHours(_intervalHours));
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken ct)
    {
        _timer?.Change(Timeout.Infinite, 0);
        return Task.CompletedTask;
    }

    public void Dispose() => _timer?.Dispose();

    private void RunSafe()
    {
        try
        {
            var (removed, kept) = CleanupOnce();
            if (removed > 0) Console.WriteLine($"[tmp-cleanup] removed {removed} (kept {kept})");
        }
        catch (Exception ex) { Console.Error.WriteLine($"[tmp-cleanup] failed: {ex.Message}"); }
    }

    public (int Removed, int Kept) CleanupOnce()
    {
        if (!Directory.Exists(TmpDir)) return (0, 0);
        var cutoff = DateTime.UtcNow.AddHours(-_ageHours);
        int removed = 0, kept = 0;

        foreach (var dir in Directory.EnumerateDirectories(TmpDir))
        {
            var name = Path.GetFileName(dir);
            try
            {
                if (name == "uploads")
                {
                    // Inside uploads/, remove old files but keep the folder
                    foreach (var f in Directory.EnumerateFiles(dir))
                    {
                        try
                        {
                            if (File.GetLastWriteTimeUtc(f) < cutoff) { File.Delete(f); removed++; }
                            else kept++;
                        }
                        catch { }
                    }
                    // Also clean sub-dirs older than cutoff (rare)
                    foreach (var sub in Directory.EnumerateDirectories(dir))
                    {
                        try
                        {
                            if (Directory.GetLastWriteTimeUtc(sub) < cutoff) { Directory.Delete(sub, true); removed++; }
                            else kept++;
                        }
                        catch { }
                    }
                }
                else if (Directory.GetLastWriteTimeUtc(dir) < cutoff)
                {
                    Directory.Delete(dir, true);
                    removed++;
                }
                else kept++;
            }
            catch { /* ignore */ }
        }
        foreach (var f in Directory.EnumerateFiles(TmpDir))
        {
            try
            {
                if (File.GetLastWriteTimeUtc(f) < cutoff) { File.Delete(f); removed++; }
                else kept++;
            }
            catch { }
        }
        return (removed, kept);
    }
}
