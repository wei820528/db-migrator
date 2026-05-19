// In-memory metric registry — v2 Theme E Phase 1。
//
// 為什麼自寫：避免再加 prom-client 或 opentelemetry 之類的 npm dep。我們需要的功能
// 很少（counter / gauge + label set），自寫 < 100 行就解決。Prometheus exposition
// 格式是個簡單文字協定（# HELP / # TYPE / 每行一個 sample）。
//
// 用法：
//   const m = require('./metrics');
//   m.counter('dbmigrator_jobs_total', 'Jobs by kind+status').inc({ kind: 'export', status: 'done' });
//   m.gauge('dbmigrator_uptime_seconds', 'Process uptime').set(process.uptime());
//   ...
//   GET /metrics → text/plain — m.render()
//
// 線程安全性：Node 單一 thread；無同步問題。

class Counter {
  constructor(name, help) {
    this.name = name; this.help = help; this.type = 'counter';
    this.values = new Map();          // key="label=val,label=val" → number
  }
  inc(labels = {}, by = 1) {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) || 0) + by);
    return this;
  }
}

class Gauge {
  constructor(name, help) {
    this.name = name; this.help = help; this.type = 'gauge';
    this.values = new Map();
  }
  set(arg1, arg2) {
    // Allow gauge.set(123) for no-label, or gauge.set({label:v}, 123)
    const labels = typeof arg1 === 'object' ? arg1 : {};
    const value  = typeof arg1 === 'object' ? arg2 : arg1;
    this.values.set(labelKey(labels), value);
    return this;
  }
  inc(labels = {}, by = 1) {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) || 0) + by);
    return this;
  }
  dec(labels = {}, by = 1) { return this.inc(labels, -by); }
}

// Histogram MVP — only buckets count + sum, no quantile estimation.
// 對我們的用途夠用（追 dump 時間 / 大小分布）；複雜的留將來。
class Histogram {
  constructor(name, help, buckets) {
    this.name = name; this.help = help; this.type = 'histogram';
    this.buckets = buckets || [0.1, 0.5, 1, 5, 10, 30, 60, 300];
    this.values = new Map(); // labelKey → { counts: number[], sum, count }
  }
  observe(labels = {}, value) {
    if (typeof labels === 'number') { value = labels; labels = {}; }
    const k = labelKey(labels);
    let entry = this.values.get(k);
    if (!entry) {
      entry = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.values.set(k, entry);
    }
    entry.sum += value;
    entry.count++;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) entry.counts[i]++;
    }
    return this;
  }
}

// ============ Registry ============

const registry = new Map();   // name → metric instance

function counter(name, help) {
  if (!registry.has(name)) registry.set(name, new Counter(name, help));
  return registry.get(name);
}
function gauge(name, help) {
  if (!registry.has(name)) registry.set(name, new Gauge(name, help));
  return registry.get(name);
}
function histogram(name, help, buckets) {
  if (!registry.has(name)) registry.set(name, new Histogram(name, help, buckets));
  return registry.get(name);
}

function clear() { registry.clear(); }
function list()  { return [...registry.keys()].sort(); }

// ============ Prometheus exposition format ============
// https://prometheus.io/docs/instrumenting/exposition_formats/

function render() {
  const lines = [];
  for (const m of registry.values()) {
    lines.push(`# HELP ${m.name} ${escapeHelp(m.help)}`);
    lines.push(`# TYPE ${m.name} ${m.type}`);
    if (m.type === 'histogram') {
      for (const [k, v] of m.values) {
        const labelStr = k ? `{${k},le="X"}` : `{le="X"}`;
        for (let i = 0; i < m.buckets.length; i++) {
          lines.push(`${m.name}_bucket${labelStr.replace('X', m.buckets[i])} ${v.counts[i]}`);
        }
        lines.push(`${m.name}_bucket${labelStr.replace('X', '+Inf')} ${v.count}`);
        lines.push(`${m.name}_sum${k ? '{' + k + '}' : ''} ${v.sum}`);
        lines.push(`${m.name}_count${k ? '{' + k + '}' : ''} ${v.count}`);
      }
    } else {
      // counter / gauge
      if (m.values.size === 0) lines.push(`${m.name} 0`);
      else for (const [k, v] of m.values) {
        lines.push(`${m.name}${k ? '{' + k + '}' : ''} ${v}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

// ============ Helpers ============

// 把 label 物件序列化成 Prometheus label string "k1=\"v1\",k2=\"v2\""，
// key 按字母排序確保 stable。
function labelKey(labels) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}="${escapeLabel(String(labels[k]))}"`).join(',');
}

function escapeLabel(s) {
  // Prometheus label values：要 escape \ " 跟換行
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeHelp(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

module.exports = { counter, gauge, histogram, render, list, clear };
