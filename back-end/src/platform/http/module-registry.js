// =============================================================================
//  PLATFORM — Sổ đăng ký Module (Module Registry)
// -----------------------------------------------------------------------------
//  Trái tim của Modular Monolith. Mỗi module tự khai báo một "manifest" trong
//  `src/modules/<tên>/index.js`:
//
//      module.exports = {
//        name: 'ordering',                 // định danh duy nhất
//        description: '...',               // mô tả nghiệp vụ
//        dependsOn: ['dining', 'catalog'], // module được phép gọi contract
//        owns: ['orders', 'order_items'],  // bảng CSDL module này sở hữu
//        basePath: '/api/orders',          // tiền tố REST
//        router,                           // express.Router()
//        contract,                         // API công khai cho module khác
//        register({ eventBus, modules }),  // đăng ký lắng nghe sự kiện
//        healthCheck?(),                   // tuỳ chọn
//      };
//
//  Registry chịu trách nhiệm:
//    1. Nạp tất cả module (tự khám phá thư mục).
//    2. Kiểm tra manifest hợp lệ, không trùng tên / trùng basePath / trùng bảng.
//    3. Kiểm tra `dependsOn` tồn tại và KHÔNG có phụ thuộc vòng.
//    4. Sắp xếp topo rồi gọi register() theo đúng thứ tự phụ thuộc.
//    5. Gắn router vào Express theo basePath.
//    6. Xuất bản đồ phụ thuộc để sinh tài liệu kiến trúc (npm run arch:graph).
// =============================================================================
const fs = require('fs');
const path = require('path');
const log = require('../../shared/logger').child('registry');

const MODULES_DIR = path.join(__dirname, '..', '..', 'modules');

class ModuleRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this.modules = new Map();
    this.loadOrder = [];
    this.booted = false;
  }

  /** Nạp manifest của tất cả module trong src/modules. */
  discover() {
    const dirs = fs
      .readdirSync(MODULES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name)
      .sort();

    for (const dir of dirs) {
      const entry = path.join(MODULES_DIR, dir, 'index.js');
      if (!fs.existsSync(entry)) {
        log.warn(`Bỏ qua '${dir}': thiếu index.js (manifest module).`);
        continue;
      }
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const manifest = require(entry);
      this._validate(manifest, dir);
      this.modules.set(manifest.name, manifest);
    }

    this._assertNoConflicts();
    this.loadOrder = this._topologicalSort();
    log.info(`Đã nạp ${this.modules.size} module: ${this.loadOrder.join(' → ')}`);
    return this;
  }

  _validate(manifest, dir) {
    const required = ['name', 'description'];
    for (const field of required) {
      if (!manifest[field]) throw new Error(`Module '${dir}': manifest thiếu trường '${field}'.`);
    }
    if (manifest.name !== dir) {
      throw new Error(`Module '${dir}': tên trong manifest ('${manifest.name}') phải trùng tên thư mục.`);
    }
    if (manifest.router && !manifest.basePath) {
      throw new Error(`Module '${dir}': có router nhưng thiếu 'basePath'.`);
    }
    manifest.dependsOn = manifest.dependsOn || [];
    manifest.owns = manifest.owns || [];
    // Chuẩn hoá: mọi module đều mô tả endpoint bằng mảng `routers`.
    // Một module có thể phơi nhiều tiền tố (vd. identity: /api/auth và /api/users).
    manifest.routers = manifest.routers || (manifest.router ? [{ path: manifest.basePath, router: manifest.router }] : []);
  }

  _assertNoConflicts() {
    const paths = new Map();
    const tables = new Map();
    for (const [name, m] of this.modules) {
      for (const entry of m.routers) {
        // `legacy: true` = route tương thích ngược cho client cũ. Được phép
        // dùng chung tiền tố với module khác vì nó chỉ phục vụ một đường dẫn
        // cụ thể đã công bố trước đây; registry gắn các route này SAU CÙNG.
        if (entry.legacy) continue;
        if (paths.has(entry.path)) {
          throw new Error(`Trùng đường dẫn REST '${entry.path}' giữa module '${paths.get(entry.path)}' và '${name}'.`);
        }
        paths.set(entry.path, name);
      }
      for (const table of m.owns) {
        if (tables.has(table)) {
          throw new Error(
            `Bảng '${table}' bị khai báo sở hữu bởi cả '${tables.get(table)}' và '${name}'. ` +
            `Trong Modular Monolith, mỗi bảng chỉ thuộc đúng một module.`
          );
        }
        tables.set(table, name);
      }
      for (const dep of m.dependsOn) {
        if (!this.modules.has(dep)) {
          throw new Error(`Module '${name}' phụ thuộc '${dep}' nhưng module này không tồn tại.`);
        }
      }
    }
  }

  /** Sắp xếp topo theo dependsOn; phát hiện phụ thuộc vòng. */
  _topologicalSort() {
    const visited = new Map(); // name → 'visiting' | 'done'
    const order = [];

    const visit = (name, trail = []) => {
      const state = visited.get(name);
      if (state === 'done') return;
      if (state === 'visiting') {
        throw new Error(
          `Phát hiện phụ thuộc vòng giữa các module: ${[...trail, name].join(' → ')}. ` +
          `Hãy tách phần dùng chung ra shared kernel hoặc giao tiếp bằng sự kiện (event bus).`
        );
      }
      visited.set(name, 'visiting');
      for (const dep of this.modules.get(name).dependsOn) visit(dep, [...trail, name]);
      visited.set(name, 'done');
      order.push(name);
    };

    for (const name of this.modules.keys()) visit(name);
    return order;
  }

  /**
   * Khởi động tất cả module theo thứ tự phụ thuộc.
   * @param {{eventBus:object, app:import('express').Express}} ctx
   */
  async boot(ctx) {
    const contracts = {};
    for (const name of this.loadOrder) {
      const m = this.modules.get(name);
      // Module chỉ nhìn thấy contract của những module nó khai báo phụ thuộc
      const visible = {};
      for (const dep of m.dependsOn) visible[dep] = contracts[dep];

      if (typeof m.register === 'function') {
        await m.register({ ...ctx, modules: visible, registry: this });
      }
      contracts[name] = m.contract || null;
      log.debug(`Module '${name}' đã khởi động`);
    }
    this.contracts = contracts;
    this.booted = true;
    return contracts;
  }

  /** Gắn router của mỗi module vào Express theo basePath. */
  mountRoutes(app) {
    const legacy = [];
    for (const name of this.loadOrder) {
      const m = this.modules.get(name);
      for (const entry of m.routers) {
        if (entry.legacy) { legacy.push({ name, entry }); continue; }
        app.use(entry.path, entry.router);
        log.debug(`Đã gắn ${entry.path} ← module '${name}'`);
      }
    }
    // Route tương thích ngược gắn sau cùng để không che route chính
    for (const { name, entry } of legacy) {
      app.use(entry.path, entry.router);
      log.debug(`Đã gắn ${entry.path} (tương thích ngược) ← module '${name}'`);
    }
  }

  /** Lấy contract công khai của một module. */
  contractOf(name) {
    const m = this.modules.get(name);
    if (!m) throw new Error(`Module '${name}' không tồn tại.`);
    return m.contract;
  }

  /** Sơ đồ kiến trúc dạng dữ liệu — dùng để sinh tài liệu & endpoint chẩn đoán. */
  describe() {
    return {
      count: this.modules.size,
      loadOrder: this.loadOrder,
      modules: this.loadOrder.map((name) => {
        const m = this.modules.get(name);
        return {
          name: m.name,
          description: m.description,
          basePaths: m.routers.map((r) => r.path),
          dependsOn: m.dependsOn,
          owns: m.owns,
          publishes: m.publishes || [],
          subscribes: m.subscribes || [],
          hasContract: Boolean(m.contract),
          contractMethods: m.contract ? Object.keys(m.contract) : [],
        };
      }),
    };
  }

  /** Gom healthCheck của tất cả module. */
  async health() {
    const out = {};
    for (const [name, m] of this.modules) {
      if (typeof m.healthCheck !== 'function') continue;
      try {
        out[name] = await m.healthCheck();
      } catch (err) {
        out[name] = { ok: false, error: err.message };
      }
    }
    return out;
  }
}

module.exports = new ModuleRegistry();
module.exports.ModuleRegistry = ModuleRegistry;
