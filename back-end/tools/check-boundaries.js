#!/usr/bin/env node
// =============================================================================
//  CÔNG CỤ KIỂM TRA RANH GIỚI MODULE
// -----------------------------------------------------------------------------
//  Modular Monolith chỉ giữ được kỷ luật nếu ranh giới được KIỂM TRA TỰ ĐỘNG.
//  Không có công cụ này, chỉ cần một lập trình viên vội vàng gõ
//  `require('../../ordering/infrastructure/order-repository')` là kiến trúc
//  lặng lẽ thoái hoá về monolith rối rắm — và không ai phát hiện ra.
//
//  Bốn quy tắc được kiểm tra:
//
//  R1. Module A chỉ được import `modules/B/contract.js` của module khác.
//      Cấm chạm vào domain/, application/, infrastructure/, interface/ của B.
//
//  R2. Mọi import xuyên module phải được khai báo trong `dependsOn` của
//      manifest. Phụ thuộc ngầm là phụ thuộc không ai nhìn thấy.
//
//  R3. Repository của module A chỉ được viết SQL lên bảng A sở hữu (trường
//      `owns` trong manifest). Đụng bảng của module khác là vi phạm.
//
//  R4. Không có phụ thuộc vòng (kiểm tra bởi chính Module Registry khi nạp).
//
//  Chạy:  npm run check:boundaries      (và trong CI trước khi merge)
// =============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
const MODULES_DIR = path.join(ROOT, 'modules');

const RED = '\x1b[31m'; const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m'; const DIM = '\x1b[2m'; const RESET = '\x1b[0m';

const violations = [];
const warnings = [];

// ─── Nạp manifest ────────────────────────────────────────────────────────────
function loadManifests() {
  const out = new Map();
  for (const dir of fs.readdirSync(MODULES_DIR)) {
    const entry = path.join(MODULES_DIR, dir, 'index.js');
    if (!fs.existsSync(entry)) continue;
    const src = fs.readFileSync(entry, 'utf-8');
    out.set(dir, {
      name: dir,
      dependsOn: extractArray(src, 'dependsOn'),
      owns: extractArray(src, 'owns'),
    });
  }
  return out;
}

/** Đọc mảng chuỗi trong manifest mà không cần thực thi mã (an toàn, nhanh). */
function extractArray(src, field) {
  const m = new RegExp(`${field}\\s*:\\s*\\[([^\\]]*)\\]`, 's').exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

/**
 * Loại bỏ chú thích trước khi quét SQL.
 * Không làm bước này, một câu chú thích kiểu "trước đây dùng SELECT ... FROM
 * tables" sẽ bị báo nhầm là vi phạm — công cụ kêu sai vài lần là người ta bắt
 * đầu bỏ qua nó, và thế là mất tác dụng.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // chú thích khối
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // chú thích dòng (giữ lại "http://")
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// ─── R1 + R2: kiểm tra import xuyên module ───────────────────────────────────
function checkImports(manifests) {
  for (const [moduleName, manifest] of manifests) {
    const moduleRoot = path.join(MODULES_DIR, moduleName);
    for (const file of walk(moduleRoot)) {
      const src = stripComments(fs.readFileSync(file, 'utf-8'));
      const rel = path.relative(ROOT, file);

      for (const match of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = match[1];
        if (!spec.startsWith('.')) continue; // package npm

        const resolved = path.resolve(path.dirname(file), spec);
        const relToModules = path.relative(MODULES_DIR, resolved);
        if (relToModules.startsWith('..')) continue; // shared/ hoặc platform/ — hợp lệ

        const targetModule = relToModules.split(path.sep)[0];
        if (targetModule === moduleName) continue; // nội bộ module

        const rest = relToModules.split(path.sep).slice(1).join('/');
        const isContract = rest === 'contract' || rest === 'contract.js';

        if (!isContract) {
          violations.push({
            rule: 'R1',
            file: rel,
            message: `import vào nội bộ module '${targetModule}' (${rest || 'index'}). ` +
                     `Chỉ được dùng modules/${targetModule}/contract.`,
          });
        }
        if (!manifest.dependsOn.includes(targetModule)) {
          violations.push({
            rule: 'R2',
            file: rel,
            message: `dùng module '${targetModule}' nhưng manifest của '${moduleName}' ` +
                     `không khai báo trong dependsOn: [${manifest.dependsOn.join(', ')}].`,
          });
        }
      }
    }
  }
}

// ─── R3: kiểm tra bảng được truy vấn trong SQL ───────────────────────────────
const SQL_TABLE_RE = /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)/gi;

// Từ khoá SQL và bí danh thường gặp — không phải tên bảng
const NOT_TABLES = new Set([
  'select', 'where', 'set', 'values', 'lateral', 'unnest', 'jsonb_each_text',
  'generate_series', 'dual', 'only', 'conflict', 'as', 'on', 'using',
]);

function checkTableOwnership(manifests) {
  const owner = new Map();
  for (const [name, m] of manifests) for (const t of m.owns) owner.set(t, name);

  for (const [moduleName, manifest] of manifests) {
    const moduleRoot = path.join(MODULES_DIR, moduleName);
    for (const file of walk(moduleRoot)) {
      const src = stripComments(fs.readFileSync(file, 'utf-8'));
      const rel = path.relative(ROOT, file);

      for (const match of src.matchAll(SQL_TABLE_RE)) {
        const table = match[1].toLowerCase();
        if (NOT_TABLES.has(table)) continue;
        if (!owner.has(table)) continue;           // không phải bảng nghiệp vụ đã khai báo
        if (owner.get(table) === moduleName) continue;

        violations.push({
          rule: 'R3',
          file: rel,
          message: `truy vấn bảng '${table}' do module '${owner.get(table)}' sở hữu. ` +
                   `Hãy gọi qua modules/${owner.get(table)}/contract.`,
        });
      }
    }
  }
}

// ─── Cảnh báo: module không có contract nhưng lại được khai báo phụ thuộc ────
function checkContracts(manifests) {
  for (const [name] of manifests) {
    const contractPath = path.join(MODULES_DIR, name, 'contract.js');
    const isDependedOn = [...manifests.values()].some((m) => m.dependsOn.includes(name));
    if (isDependedOn && !fs.existsSync(contractPath)) {
      warnings.push(`Module '${name}' được module khác phụ thuộc nhưng không có contract.js.`);
    }
  }
}

// ─── Kiểm tra lớp shared / platform không phụ thuộc ngược vào module ────────
function checkLayering() {
  for (const layer of ['shared', 'platform']) {
    const dir = path.join(ROOT, layer);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const src = fs.readFileSync(file, 'utf-8');
      if (/require\(\s*['"][^'"]*modules\//.test(src)) {
        violations.push({
          rule: 'R5',
          file: path.relative(ROOT, file),
          message: `lớp '${layer}' import vào modules/ — hạ tầng không được phụ thuộc nghiệp vụ.`,
        });
      }
    }
  }
}

// ─── Chạy ────────────────────────────────────────────────────────────────────
function main() {
  const manifests = loadManifests();
  console.log(`${DIM}Kiểm tra ranh giới của ${manifests.size} module...${RESET}\n`);

  checkImports(manifests);
  checkTableOwnership(manifests);
  checkContracts(manifests);
  checkLayering();

  // In bảng quyền sở hữu để tiện đối chiếu khi review
  console.log(`${DIM}Quyền sở hữu bảng CSDL:${RESET}`);
  for (const [name, m] of manifests) {
    console.log(`  ${name.padEnd(14)} ${DIM}→${RESET} ${m.owns.join(', ') || DIM + '(không sở hữu bảng)' + RESET}`);
  }
  console.log();

  if (warnings.length) {
    console.log(`${YELLOW}Cảnh báo:${RESET}`);
    warnings.forEach((w) => console.log(`  ${YELLOW}!${RESET} ${w}`));
    console.log();
  }

  if (violations.length === 0) {
    console.log(`${GREEN}✓ Không phát hiện vi phạm ranh giới module.${RESET}`);
    process.exit(0);
  }

  console.log(`${RED}✗ Phát hiện ${violations.length} vi phạm ranh giới:${RESET}\n`);
  const byRule = violations.reduce((acc, v) => {
    (acc[v.rule] ||= []).push(v);
    return acc;
  }, {});
  for (const [rule, list] of Object.entries(byRule)) {
    console.log(`${RED}[${rule}]${RESET} ${list.length} vi phạm`);
    for (const v of list) console.log(`  ${v.file}\n    ${DIM}${v.message}${RESET}`);
    console.log();
  }
  process.exit(1);
}

main();
