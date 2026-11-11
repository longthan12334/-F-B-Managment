#!/usr/bin/env node
// =============================================================================
//  SINH SƠ ĐỒ KIẾN TRÚC TỪ MÃ NGUỒN
// -----------------------------------------------------------------------------
//  Tài liệu kiến trúc vẽ tay luôn lạc hậu sau vài sprint. Công cụ này đọc
//  manifest thật của các module và sinh ra sơ đồ Mermaid, nên hình vẽ trong
//  báo cáo LUÔN khớp với mã nguồn đang chạy.
//
//  Chạy:  npm run arch:graph            → in ra màn hình
//         npm run arch:graph > ARCH.md  → ghi ra tệp
// =============================================================================
const fs = require('fs');
const path = require('path');

const MODULES_DIR = path.join(__dirname, '..', 'src', 'modules');

function extractArray(src, field) {
  const m = new RegExp(`${field}\\s*:\\s*\\[([^\\]]*)\\]`, 's').exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

function extractString(src, field) {
  const m = new RegExp(`${field}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`).exec(src);
  return m ? m[1] : '';
}

function extractEventRefs(src, field) {
  const m = new RegExp(`${field}\\s*:\\s*\\[([^\\]]*)\\]`, 's').exec(src);
  if (!m) return [];
  const names = [...m[1].matchAll(/EVENTS\.([A-Z_]+)/g)].map((x) => x[1]);
  const literals = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
  return [...names, ...literals];
}

function load() {
  const out = [];
  for (const dir of fs.readdirSync(MODULES_DIR).sort()) {
    const entry = path.join(MODULES_DIR, dir, 'index.js');
    if (!fs.existsSync(entry)) continue;
    const src = fs.readFileSync(entry, 'utf-8');
    out.push({
      name: dir,
      description: extractString(src, 'description'),
      dependsOn: extractArray(src, 'dependsOn'),
      owns: extractArray(src, 'owns'),
      routers: [...src.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]),
      publishes: extractEventRefs(src, 'publishes'),
      subscribes: extractEventRefs(src, 'subscribes'),
    });
  }
  return out;
}

function render(modules) {
  const lines = [];

  lines.push('## Sơ đồ phụ thuộc giữa các module');
  lines.push('');
  lines.push('> Sinh tự động bằng `npm run arch:graph` — luôn khớp với mã nguồn.');
  lines.push('');
  lines.push('```mermaid');
  lines.push('graph TD');
  lines.push('  classDef foundation fill:#e3f2fd,stroke:#1565c0,stroke-width:2px');
  lines.push('  classDef core fill:#fff3e0,stroke:#e65100,stroke-width:2px');
  lines.push('  classDef readonly fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px');
  lines.push('');

  for (const m of modules) {
    const label = `${m.name}<br/><small>${m.owns.length} bảng</small>`;
    lines.push(`  ${m.name.replace(/-/g, '_')}["${label}"]`);
  }
  lines.push('');

  for (const m of modules) {
    for (const dep of m.dependsOn) {
      lines.push(`  ${m.name.replace(/-/g, '_')} -->|contract| ${dep.replace(/-/g, '_')}`);
    }
  }
  lines.push('');

  // Quan hệ qua sự kiện (nét đứt) — không phải phụ thuộc biên dịch
  const publisherOf = new Map();
  for (const m of modules) for (const e of m.publishes) publisherOf.set(e, m.name);
  for (const m of modules) {
    const seen = new Set();
    for (const e of m.subscribes) {
      const pub = publisherOf.get(e);
      if (!pub || pub === m.name || seen.has(pub)) continue;
      seen.add(pub);
      lines.push(`  ${pub.replace(/-/g, '_')} -.->|sự kiện| ${m.name.replace(/-/g, '_')}`);
    }
    if (m.subscribes.includes('*')) {
      lines.push(`  ordering -.->|mọi sự kiện| ${m.name.replace(/-/g, '_')}`);
    }
  }

  const foundations = modules.filter((m) => m.dependsOn.length <= 1).map((m) => m.name.replace(/-/g, '_'));
  if (foundations.length) lines.push(`  class ${foundations.join(',')} foundation`);
  lines.push('```');
  lines.push('');

  lines.push('## Bảng tổng hợp module');
  lines.push('');
  lines.push('| Module | Phụ thuộc | Bảng sở hữu | REST |');
  lines.push('|---|---|---|---|');
  for (const m of modules) {
    lines.push(`| **${m.name}** | ${m.dependsOn.join(', ') || '—'} | \`${m.owns.join('`, `') || '—'}\` | ${m.routers.join('<br/>') || '—'} |`);
  }
  lines.push('');

  lines.push('## Sự kiện');
  lines.push('');
  lines.push('| Module | Phát ra | Lắng nghe |');
  lines.push('|---|---|---|');
  for (const m of modules) {
    lines.push(`| **${m.name}** | ${m.publishes.length} | ${m.subscribes.includes('*') ? 'mọi sự kiện (`*`)' : m.subscribes.length} |`);
  }

  return lines.join('\n');
}

console.log(render(load()));
