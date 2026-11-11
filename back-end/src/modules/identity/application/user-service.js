// =============================================================================
//  MODULE identity · APPLICATION — Use-case quản lý nhân viên
// =============================================================================
const users = require('../infrastructure/user-repository');
const tokens = require('../infrastructure/refresh-token-repository');
const { assertValidNewUser, assertValidPassword, assertNotLastAdmin, toPublic } = require('../domain/user');
const { ROLES } = require('../domain/roles');
const { AppError } = require('../../../shared/errors');
const EVENTS = require('../../../platform/events/event-names');
const bus = require('../../../platform/events/event-bus');

const actorMeta = (actor) => ({ actor: actor?.full_name || null });

async function list(filters = {}) {
  return users.findAll(filters);
}

async function create(input, actor) {
  assertValidNewUser(input);

  const username = String(input.username).trim();
  if (await users.findByUsername(username)) {
    throw AppError.conflict('Tên đăng nhập đã tồn tại');
  }

  const user = await users.create({ ...input, username });
  bus.publish(EVENTS.USER_CREATED, {
    actor_id: actor?.id, actor_name: actor?.full_name,
    user_id: user.id, username: user.username, role: user.role,
  }, actorMeta(actor));
  return user;
}

async function update(id, patch, actor) {
  const target = await users.findById(id);
  if (!target) throw AppError.notFound('Nhân viên không tồn tại');

  // Bất biến: không được hạ cấp / khoá admin cuối cùng
  const disabling = patch.is_active === false || patch.is_active === 'false';
  const demoting = patch.role && patch.role !== ROLES.ADMIN;
  if (target.role === ROLES.ADMIN && target.is_active && (disabling || demoting)) {
    assertNotLastAdmin(
      { activeAdminCount: await users.countActiveAdmins(), targetIsActiveAdmin: true },
      disabling ? 'khoá' : 'hạ quyền'
    );
  }

  const updated = await users.update(id, patch);
  // Khoá tài khoản → thu hồi mọi phiên để người đó bị đăng xuất ngay
  if (disabling) await tokens.revokeAllForUser(id).catch(() => {});

  bus.publish(EVENTS.USER_UPDATED, {
    actor_id: actor?.id, actor_name: actor?.full_name, user_id: id, changes: patch,
  }, actorMeta(actor));
  return updated;
}

async function resetPassword(id, password, actor) {
  assertValidPassword(password);
  const updated = await users.setPassword(id, password);
  if (!updated) throw AppError.notFound('Nhân viên không tồn tại');

  // Đặt lại mật khẩu → mọi phiên cũ hết hiệu lực
  await tokens.revokeAllForUser(id).catch(() => {});

  bus.publish(EVENTS.USER_PASSWORD_RESET, {
    actor_id: actor?.id, actor_name: actor?.full_name, user_id: id, self: false,
  }, actorMeta(actor));
  return updated;
}

async function remove(id, actor) {
  if (actor && String(actor.id) === String(id)) {
    throw AppError.conflict('Không thể tự xoá tài khoản của chính mình');
  }
  const target = await users.findById(id);
  if (!target) throw AppError.notFound('Nhân viên không tồn tại');

  if (target.role === ROLES.ADMIN && target.is_active) {
    assertNotLastAdmin(
      { activeAdminCount: await users.countActiveAdmins(), targetIsActiveAdmin: true },
      'xoá'
    );
  }

  const removed = await users.remove(id);
  bus.publish(EVENTS.USER_DELETED, {
    actor_id: actor?.id, actor_name: actor?.full_name, user_id: id, username: target.username,
  }, actorMeta(actor));
  return removed;
}

module.exports = { list, create, update, resetPassword, remove, toPublic };
