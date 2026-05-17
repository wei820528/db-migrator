// IP whitelist matching: supports plain IPv4, IPv4 CIDR, and "*" wildcard.
// Stored in users.ip_whitelist as JSON array, e.g. ["1.2.3.4", "10.0.0.0/8", "192.168.*"].

function parseList(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function matchOne(rule, ip) {
  if (!rule) return false;
  if (rule === '*' || rule === '0.0.0.0/0') return true;
  if (rule === ip) return true;
  if (rule.includes('/')) {
    // CIDR
    const [base, bits] = rule.split('/');
    const baseInt = ipv4ToInt(base);
    const ipInt = ipv4ToInt(ip);
    const n = Number(bits);
    if (baseInt === null || ipInt === null || isNaN(n)) return false;
    const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
    return (baseInt & mask) === (ipInt & mask);
  }
  if (rule.includes('*')) {
    // Wildcard. `*` means "anything (incl. dots)" — `192.168.*` matches `192.168.1.100`.
    // Use `.+` for `*` so it requires at least one char.
    const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&');   // escape regex specials BUT keep *
    const re = new RegExp('^' + escaped.replace(/\*/g, '.+') + '$');
    return re.test(ip);
  }
  return false;
}

// Returns { ok, allowed: bool, reason? }
function checkAllowed(whitelistJson, ip) {
  const list = parseList(whitelistJson);
  if (list.length === 0) return { allowed: true };  // no whitelist = allow all
  const matched = list.some((rule) => matchOne(rule, ip));
  if (matched) return { allowed: true };
  return { allowed: false, reason: `IP ${ip} not in whitelist (${list.join(', ')})` };
}

module.exports = { checkAllowed, parseList };
