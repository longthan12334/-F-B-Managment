// =============================================================================
//  MODULE dining · APPLICATION — Use-case quản lý bàn & sơ đồ bàn
// =============================================================================
const repo = require('../infrastructure/table-repository');
const stateRepo = require('../infrastructure/table-state-repository');
const {
  TABLE_STATE, STATE_LABELS, assertValidTable, assertCanDeactivate, assertCanDelete, minutesOccupied,
} = require('../domain/table');
const { AppError } = require('../../../shared/errors');
const { toAmount } = require('../../../shared/money');
const EVENTS = require('../../../platform/events/event-names');
const bus = require('../../../platform/events/event-bus');

/** Ghép thông tin bàn + trạng thái thành góc nhìn cho màn hình sơ đồ bàn. */
function toFloorPlanView(row) {
  return {
    id: row.id,
    code: row.code,
    zone: row.zone,
    zone_name: row.zone_name,
    capacity: row.capacity,
    qr_slug: row.qr_slug,
    note: row.note,
    is_active: row.is_active,
    state: row.state,
    state_label: STATE_LABELS[row.state]?.label || row.state,
    state_tone: STATE_LABELS[row.state]?.tone || 'neutral',
    current_order_id: row.current_order_id,
    current_order_code: row.current_order_code,
    current_amount: toAmount(row.current_amount),
    pending_guest_requests: Number(row.pending_guest_requests || 0),
    occupied_since: row.occupied_since,
    minutes_occupied: minutesOccupied(row.occupied_since),
  };
}

async function listZones() {
  return repo.listZones({ activeOnly: true });
}

async function listTables({ zone, withStatus } = {}) {
  if (!withStatus) return repo.findAll({ zone });
  const rows = await stateRepo.listWithTables({ zone });
  return rows.map(toFloorPlanView);
}

async function getTable(id) {
  const t = await repo.findById(id);
  if (!t) throw AppError.notFound('Bàn không tồn tại');
  return t;
}

async function createTable(input, actor) {
  assertValidTable(input);
  const zone = String(input.zone || '').trim();
  if (!(await repo.zoneExists(zone))) {
    const zones = (await repo.listZones({ activeOnly: true })).map((z) => z.code);
    throw AppError.validation('Khu vực không hợp lệ', [`zone: phải thuộc {${zones.join('|')}}`]);
  }

  const code = String(input.code).trim().toUpperCase();
  if (await repo.findByCode(code)) throw AppError.conflict(`Bàn ${code} đã tồn tại`);

  const table = await repo.create({ code, zone, capacity: Number(input.capacity), note: input.note });
  await stateRepo.ensureRow(table.id, table.code, table.is_active);

  bus.publish(EVENTS.TABLE_CREATED, {
    actor_id: actor?.id, actor_name: actor?.full_name,
    table_id: table.id, table_code: table.code, zone: table.zone,
  }, { actor: actor?.full_name });

  return table;
}

async function updateTable(id, patch, actor) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Bàn không tồn tại');
  assertValidTable(patch, { partial: true });

  if (patch.zone && !(await repo.zoneExists(patch.zone))) {
    const zones = (await repo.listZones({ activeOnly: true })).map((z) => z.code);
    throw AppError.validation('Khu vực không hợp lệ', [`zone: phải thuộc {${zones.join('|')}}`]);
  }
  if (patch.code) {
    const code = String(patch.code).trim().toUpperCase();
    const other = await repo.findByCode(code);
    if (other && other.id !== id) throw AppError.conflict(`Bàn ${code} đã tồn tại`);
    patch.code = code;
  }

  // Tạm ngưng bàn: chỉ được phép khi bàn đang trống
  if (patch.is_active === false || patch.is_active === 'false') {
    assertCanDeactivate(await stateRepo.get(id));
  }

  const table = await repo.update(id, patch);
  if (patch.is_active !== undefined) {
    await stateRepo.setInactive(id, patch.is_active === false || patch.is_active === 'false');
  }
  if (patch.code) await stateRepo.ensureRow(id, table.code, table.is_active);

  bus.publish(EVENTS.TABLE_UPDATED, {
    actor_id: actor?.id, actor_name: actor?.full_name,
    table_id: id, table_code: table.code, changes: Object.keys(patch),
  }, { actor: actor?.full_name });

  return table;
}

async function setActive(id, isActive, actor) {
  return updateTable(id, { is_active: isActive }, actor);
}

async function removeTable(id, actor) {
  const existing = await repo.findById(id);
  if (!existing) throw AppError.notFound('Bàn không tồn tại');
  assertCanDelete(await stateRepo.get(id));

  await stateRepo.removeRow(id);
  const removed = await repo.remove(id);

  bus.publish(EVENTS.TABLE_DELETED, {
    actor_id: actor?.id, actor_name: actor?.full_name, table_id: id, table_code: existing.code,
  }, { actor: actor?.full_name });

  return removed;
}

async function rotateQr(id, actor) {
  const table = await repo.rotateQrSlug(id);
  if (!table) throw AppError.notFound('Bàn không tồn tại');
  bus.publish(EVENTS.TABLE_UPDATED, {
    actor_id: actor?.id, actor_name: actor?.full_name,
    table_id: id, table_code: table.code, changes: ['qr_slug'],
  }, { actor: actor?.full_name });
  return table;
}

/** Thông tin để in mã QR: đường dẫn tương đối, FE ghép với domain thực tế. */
function qrDescriptorFor(table) {
  return {
    table_id: table.id,
    table_code: table.code,
    zone: table.zone,
    qr_slug: table.qr_slug,
    order_path: `/order/${table.qr_slug}`,
    legacy_path: `/order/${table.code}`,
  };
}

// ─── Cập nhật hình chiếu (gọi bởi event handler, không phơi ra REST) ────────
async function applyOrderOpened({ table_id, table_code, order_id, order_code, amount, occupied_since, state }) {
  if (!table_id) return;
  await stateRepo.set(table_id, {
    table_code,
    state: state || TABLE_STATE.ORDERING,
    order_id, order_code,
    amount: toAmount(amount),
    occupied_since: occupied_since || new Date().toISOString(),
  });
  bus.publish(EVENTS.TABLE_STATE_CHANGED, { table_id, table_code, state: state || TABLE_STATE.ORDERING });
}

async function applyTableReleased({ table_id, table_code }) {
  if (!table_id) return;
  await stateRepo.release(table_id);
  bus.publish(EVENTS.TABLE_STATE_CHANGED, { table_id, table_code, state: TABLE_STATE.EMPTY });
}

async function adjustPendingGuestRequests(table_id, delta) {
  if (!table_id) return;
  await stateRepo.setPendingGuestRequests(table_id, delta);
  bus.publish(EVENTS.TABLE_STATE_CHANGED, { table_id, pending_delta: delta });
}

module.exports = {
  listZones, listTables, getTable, createTable, updateTable, setActive, removeTable,
  rotateQr, qrDescriptorFor, toFloorPlanView,
  applyOrderOpened, applyTableReleased, adjustPendingGuestRequests,
};
