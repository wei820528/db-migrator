using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace DbMigrator.Web.Adapters;

internal static class SqlHelpers
{
    public static string Bracket(string name, char open = '[', char close = ']') =>
        open + name.Replace(close.ToString(), new string(close, 2)) + close;

    public static string DoubleQuote(string name) => "\"" + name.Replace("\"", "\"\"") + "\"";

    public static string Backtick(string name) => "`" + name.Replace("`", "``") + "`";

    public enum StringStyle { AnsiSingle, NPrefix, MySqlEscaped }

    public static string EscapeAnsi(string s) => "'" + s.Replace("'", "''") + "'";

    public static string EscapeNPrefix(string s) => "N'" + s.Replace("'", "''") + "'";

    public static string EscapeMySql(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('\'');
        foreach (var ch in s)
        {
            switch (ch)
            {
                case '\0': sb.Append(@"\0"); break;
                case '\n': sb.Append(@"\n"); break;
                case '\r': sb.Append(@"\r"); break;
                case '\\': sb.Append(@"\\"); break;
                case '\'': sb.Append(@"\'"); break;
                case '"': sb.Append("\\\""); break;
                case '\x1a': sb.Append(@"\Z"); break;
                default: sb.Append(ch); break;
            }
        }
        sb.Append('\'');
        return sb.ToString();
    }

    public class FormatOptions
    {
        public Func<string, string> EscapeString { get; set; } = EscapeAnsi;
        public Func<byte[], string> FormatBinary { get; set; } = bytes => "X'" + Convert.ToHexString(bytes) + "'";
        public bool BoolAs01 { get; set; } = false;
    }

    public static string FormatValue(object? v, FormatOptions o)
    {
        if (v is null || v is DBNull) return "NULL";
        return v switch
        {
            bool b => o.BoolAs01 ? (b ? "1" : "0") : (b ? "TRUE" : "FALSE"),
            byte by => by.ToString(CultureInfo.InvariantCulture),
            sbyte sb => sb.ToString(CultureInfo.InvariantCulture),
            short s => s.ToString(CultureInfo.InvariantCulture),
            ushort us => us.ToString(CultureInfo.InvariantCulture),
            int i => i.ToString(CultureInfo.InvariantCulture),
            uint ui => ui.ToString(CultureInfo.InvariantCulture),
            long l => l.ToString(CultureInfo.InvariantCulture),
            ulong ul => ul.ToString(CultureInfo.InvariantCulture),
            float f => f.ToString("R", CultureInfo.InvariantCulture),
            double d => d.ToString("R", CultureInfo.InvariantCulture),
            decimal m => m.ToString(CultureInfo.InvariantCulture),
            DateTime dt => "'" + dt.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "'",
            DateTimeOffset dto => "'" + dto.UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "'",
            TimeSpan ts => "'" + ts.ToString(@"hh\:mm\:ss", CultureInfo.InvariantCulture) + "'",
            Guid g => o.EscapeString(g.ToString()),
            byte[] bytes => o.FormatBinary(bytes),
            string str => o.EscapeString(str),
            _ => o.EscapeString(v.ToString() ?? ""),
        };
    }

    // Strip -- and /* */ comments, split on ';' outside string/identifier literals.
    public static IEnumerable<string> SplitSqlStatements(string sql, char identQuote = '"')
    {
        var sb = new StringBuilder();
        bool inSingle = false, inDouble = false, inIdent = false;
        int i = 0;
        while (i < sql.Length)
        {
            char ch = sql[i];
            char next = i + 1 < sql.Length ? sql[i + 1] : '\0';
            if (!inSingle && !inDouble && !inIdent)
            {
                if (ch == '-' && next == '-') { while (i < sql.Length && sql[i] != '\n') i++; continue; }
                if (ch == '/' && next == '*') { i += 2; while (i + 1 < sql.Length && !(sql[i] == '*' && sql[i + 1] == '/')) i++; i += 2; continue; }
            }
            if ((inSingle || inDouble) && ch == '\\')
            {
                sb.Append(ch);
                if (i + 1 < sql.Length) sb.Append(sql[++i]);
                i++; continue;
            }
            if (!inDouble && !inIdent && ch == '\'') inSingle = !inSingle;
            else if (!inSingle && !inIdent && ch == '"' && identQuote != '"') inDouble = !inDouble;
            else if (!inSingle && !inDouble && ch == identQuote) inIdent = !inIdent;

            if (ch == ';' && !inSingle && !inDouble && !inIdent)
            {
                var stmt = sb.ToString().Trim();
                if (stmt.Length > 0) yield return stmt;
                sb.Clear();
            }
            else sb.Append(ch);
            i++;
        }
        var last = sb.ToString().Trim();
        if (last.Length > 0) yield return last;
    }

    // Routine block markers — mirror of node-express _shared.js. Wrap procedures /
    // functions / events whose bodies contain ';' so restore can pull them out
    // intact instead of splitting on internal semicolons.
    public const string RoutineBegin = "-- ROUTINE_BEGIN";
    public const string RoutineEnd   = "-- ROUTINE_END";

    public enum BlockKind { Sql, Routine }
    public record SqlBlock(BlockKind Kind, string Body);

    public static IEnumerable<SqlBlock> ExtractRoutineBlocks(string text)
    {
        int i = 0;
        while (i < text.Length)
        {
            int begin = text.IndexOf(RoutineBegin, i, StringComparison.Ordinal);
            if (begin == -1)
            {
                var rest = text[i..].Trim();
                if (rest.Length > 0) yield return new SqlBlock(BlockKind.Sql, rest);
                yield break;
            }
            if (begin > i)
            {
                var rest = text[i..begin].Trim();
                if (rest.Length > 0) yield return new SqlBlock(BlockKind.Sql, rest);
            }
            int newlineAfterBegin = text.IndexOf('\n', begin);
            int bodyStart = newlineAfterBegin == -1 ? begin + RoutineBegin.Length : newlineAfterBegin + 1;
            int end = text.IndexOf(RoutineEnd, bodyStart, StringComparison.Ordinal);
            if (end == -1)
            {
                yield return new SqlBlock(BlockKind.Routine, text[bodyStart..].Trim());
                yield break;
            }
            yield return new SqlBlock(BlockKind.Routine, text[bodyStart..end].Trim());
            int nextLine = text.IndexOf('\n', end);
            i = nextLine == -1 ? text.Length : nextLine + 1;
        }
    }

    // MSSQL: split on lines that are exactly 'GO'.
    public static IEnumerable<string> SplitMsSqlBatches(string text)
    {
        var rx = new Regex(@"^\s*GO\s*$", RegexOptions.IgnoreCase | RegexOptions.Multiline);
        int last = 0;
        foreach (Match m in rx.Matches(text))
        {
            var s = text.Substring(last, m.Index - last).Trim();
            if (s.Length > 0) yield return s;
            last = m.Index + m.Length;
        }
        var tail = text.Substring(last).Trim();
        if (tail.Length > 0) yield return tail;
    }

    public static List<string> ParseTableNamesFromDump(string sqlFilePath, char identQuote = '`')
    {
        var text = File.ReadAllText(sqlFilePath);
        var escQ = Regex.Escape(identQuote.ToString());
        var rx = new Regex($@"CREATE TABLE(?:\s+IF NOT EXISTS)?\s+{escQ}?([^{escQ}\s(]+){escQ}?",
            RegexOptions.IgnoreCase);
        var set = new HashSet<string>();
        foreach (Match m in rx.Matches(text)) set.Add(m.Groups[1].Value);
        return set.ToList();
    }

    // Extract the primary table this SQL statement targets.
    // Returns null for header statements (SET / BEGIN / COMMIT / USE / PRAGMA / GO / comments).
    public static string? ExtractTableName(string stmt, char identQuote = '`')
    {
        var head = stmt.TrimStart();
        if (head.Length > 200) head = head[..200];
        if (Regex.IsMatch(head, @"^(SET|BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|USE|PRAGMA|GO|--|/\*)", RegexOptions.IgnoreCase))
            return null;
        // Identifier delimiter: brackets need open/close pair
        var isBracket = identQuote == '[';
        var escOpen = Regex.Escape(identQuote.ToString());
        var escClose = isBracket ? @"\]" : escOpen;
        var innerNeg = isBracket ? @"\]" : escOpen;
        var pattern = $@"^(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|INSERT\s+INTO|REPLACE\s+INTO|ALTER\s+TABLE|TRUNCATE(?:\s+TABLE)?)\s+(?:{escOpen}([^{innerNeg}]+){escClose}|([\w.]+))";
        var m = Regex.Match(head, pattern, RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        var name = m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value;
        return name.Contains('.') ? name.Split('.')[^1] : name;
    }

    // Filter SQL to only include statements touching tables in `allowedTables`.
    // Header statements are always kept.
    public static (string Sql, int Kept, int Skipped) FilterSqlByTables(
        string text, IEnumerable<string> allowedTables, char identQuote = '`')
    {
        var allowed = new HashSet<string>(
            allowedTables.Select(t => t.Contains('.') ? t.Split('.')[^1] : t)
        );
        var kept = new List<string>();
        int skipped = 0;
        foreach (var s in SplitSqlStatements(text, identQuote))
        {
            var t = ExtractTableName(s, identQuote);
            if (t == null || allowed.Contains(t)) kept.Add(s);
            else skipped++;
        }
        return (string.Join(";\n\n", kept) + ";\n", kept.Count, skipped);
    }
}
