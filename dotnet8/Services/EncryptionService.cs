using System.Security.Cryptography;
using System.Text;

namespace DbMigrator.Web.Services;

// Symmetric encryption for storing DB passwords used by scheduled backups.
// Mirrors node-express/lib/encrypt.js.
//
// Key resolution:
//   1. SCHEDULE_KEY env var (64 hex chars = 32 bytes)
//   2. .schedule-key file in app dir (auto-generated on first start; should be gitignored)
//
// Envelope format: base64(iv[12] | tag[16] | ciphertext)

public class EncryptionService
{
    private static readonly string KeyFile = Path.Combine(AppContext.BaseDirectory, ".schedule-key");
    private byte[]? _key;
    private readonly object _lock = new();

    private byte[] LoadKey()
    {
        if (_key != null) return _key;
        lock (_lock)
        {
            if (_key != null) return _key;
            var envHex = Environment.GetEnvironmentVariable("SCHEDULE_KEY");
            if (!string.IsNullOrEmpty(envHex))
            {
                if (envHex.Length != 64 || !System.Text.RegularExpressions.Regex.IsMatch(envHex, "^[0-9a-fA-F]+$"))
                    throw new Exception("SCHEDULE_KEY must be 64 hex chars (32 bytes)");
                _key = Convert.FromHexString(envHex);
                Console.WriteLine("[encrypt] using SCHEDULE_KEY from env");
                return _key;
            }
            if (File.Exists(KeyFile))
            {
                var hex = File.ReadAllText(KeyFile).Trim();
                if (hex.Length != 64) throw new Exception($"Invalid key in {KeyFile}");
                _key = Convert.FromHexString(hex);
                return _key;
            }
            var key = RandomNumberGenerator.GetBytes(32);
            File.WriteAllText(KeyFile, Convert.ToHexString(key).ToLowerInvariant());
            // Try to set restrictive perms on POSIX; on Windows ACL inheritance is fine for typical home use.
            Console.WriteLine($"[encrypt] generated new key at {KeyFile} (keep it safe; don't commit)");
            Console.WriteLine("[encrypt] tip: set SCHEDULE_KEY env var in production to control key rotation");
            _key = key;
            return _key;
        }
    }

    public string? Encrypt(string? plaintext)
    {
        if (plaintext == null) return null;
        if (plaintext == "") return "";
        var key = LoadKey();
        var iv = RandomNumberGenerator.GetBytes(12);
        var pt = Encoding.UTF8.GetBytes(plaintext);
        var ct = new byte[pt.Length];
        var tag = new byte[16];
        using var gcm = new AesGcm(key, 16);
        gcm.Encrypt(iv, pt, ct, tag);
        var envelope = new byte[iv.Length + tag.Length + ct.Length];
        Buffer.BlockCopy(iv, 0, envelope, 0, iv.Length);
        Buffer.BlockCopy(tag, 0, envelope, iv.Length, tag.Length);
        Buffer.BlockCopy(ct, 0, envelope, iv.Length + tag.Length, ct.Length);
        return Convert.ToBase64String(envelope);
    }

    public string? Decrypt(string? envelopeB64)
    {
        if (envelopeB64 == null) return null;
        if (envelopeB64 == "") return "";
        var key = LoadKey();
        var buf = Convert.FromBase64String(envelopeB64);
        if (buf.Length < 12 + 16 + 1) throw new Exception("Encrypted value too short");
        var iv = buf[..12];
        var tag = buf[12..28];
        var ct = buf[28..];
        var pt = new byte[ct.Length];
        using var gcm = new AesGcm(key, 16);
        gcm.Decrypt(iv, ct, tag, pt);
        return Encoding.UTF8.GetString(pt);
    }
}
