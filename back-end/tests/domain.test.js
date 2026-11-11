// =============================================================================
//  KIỂM THỬ ĐƠN VỊ — tầng domain (thuần tuý, không cần CSDL)
// -----------------------------------------------------------------------------
//  Đây là lợi ích cụ thể của việc tách tầng domain: toàn bộ quy tắc nghiệp vụ
//  quan trọng nhất (tính tiền, máy trạng thái đơn, chặn thanh toán khi còn món
//  chờ duyệt, ký token khách) chạy được trong vài mili-giây, không cần dựng
//  PostgreSQL hay MinIO.
//
//  Chạy:  npm test
// =============================================================================
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789';
process.env.REFRESH_SECRET = 'test-refresh-secret-abcdef0123456789abcdef';
process.env.GUEST_SECRET = 'test-guest-secret-0123456789abcdef0123';

const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../src/shared/money');
const order = require('../src/modules/ordering/domain/order');
const invoice = require('../src/modules/billing/domain/invoice');
const guest = require('../src/modules/guest-access/domain/guest-session');
const roles = require('../src/modules/identity/domain/roles');
const table = require('../src/modules/dining/domain/table');
const { AppError } = require('../src/shared/errors');

// ─── Tiền tệ ────────────────────────────────────────────────────────────────
test('money: VND luôn làm tròn về số nguyên đồng', () => {
  assert.equal(money.toAmount(1234.4), 1234);
  assert.equal(money.toAmount(1234.5), 1235);
  assert.equal(money.toAmount('65000'), 65000);
  assert.equal(money.toAmount(undefined), 0);
});

test('money: VAT tính trên số đã làm tròn, không tích luỹ sai số', () => {
  assert.equal(money.percentOf(185_000, 8), 14_800);
  assert.equal(money.percentOf(65_000, 8), 5_200);
  // 10% của 12.345 = 1.234,5 → làm tròn lên 1.235
  assert.equal(money.percentOf(12_345, 10), 1_235);
});

// ─── Máy trạng thái đơn hàng ────────────────────────────────────────────────
test('order: chỉ cho phép chuyển trạng thái hợp lệ', () => {
  assert.doesNotThrow(() => order.assertTransition('pending', 'serving'));
  assert.doesNotThrow(() => order.assertTransition('serving', 'completed'));
  assert.doesNotThrow(() => order.assertTransition('pending', 'cancelled'));

  assert.throws(() => order.assertTransition('pending', 'completed'), AppError,
    'không được nhảy thẳng từ pending sang completed');
  assert.throws(() => order.assertTransition('completed', 'serving'), AppError,
    'đơn đã thanh toán là trạng thái kết thúc');
  assert.throws(() => order.assertTransition('cancelled', 'pending'), AppError);
});

test('order: tổng tiền CHỈ cộng món đã xác nhận hoặc đã phục vụ', () => {
  const items = [
    { status: 'confirmed',       total_price: 100_000 },
    { status: 'served',          total_price: 50_000 },
    { status: 'pending_confirm', total_price: 999_000 }, // chưa duyệt → không tính
    { status: 'rejected',        total_price: 888_000 }, // bị từ chối → không tính
    { status: 'cancelled',       total_price: 777_000 },
  ];
  assert.equal(order.computeTotal(items), 150_000);
  assert.equal(order.computePendingTotal(items), 999_000);
  assert.equal(order.hasPendingItems(items), true);
});

test('order: CHẶN thanh toán khi còn món khách gọi chờ duyệt', () => {
  const open = { id: 'x', code: 'ORD-1', status: 'serving' };
  const withPending = [
    { status: 'confirmed', total_price: 100_000 },
    { status: 'pending_confirm', total_price: 50_000 },
  ];
  assert.throws(() => order.assertReadyForCheckout(open, withPending), /chờ duyệt/);

  const allConfirmed = [{ status: 'confirmed', total_price: 100_000 }];
  assert.doesNotThrow(() => order.assertReadyForCheckout(open, allConfirmed));
});

test('order: không thanh toán được đơn rỗng hoặc toàn món bị từ chối', () => {
  const open = { id: 'x', code: 'ORD-2', status: 'serving' };
  assert.throws(() => order.assertReadyForCheckout(open, []), /chưa có món nào/);
  assert.throws(
    () => order.assertReadyForCheckout(open, [{ status: 'rejected', total_price: 10 }]),
    /chưa có món nào/
  );
});

test('order: giỏ món sai định dạng bị chặn ngay ở domain', () => {
  assert.throws(() => order.assertValidBasket([]), AppError);
  assert.throws(() => order.assertValidBasket([{ menu_item_id: 'a', quantity: 0 }]), AppError);
  assert.throws(() => order.assertValidBasket([{ menu_item_id: 'a', quantity: 1.5 }]), AppError);
  assert.throws(() => order.assertValidBasket([{ quantity: 1 }]), AppError, 'thiếu định danh món');
  assert.doesNotThrow(() => order.assertValidBasket([{ menu_item_id: 'a', quantity: 2 }]));
});

// ─── Tính tiền hoá đơn ──────────────────────────────────────────────────────
test('invoice: công thức tính tiền đầy đủ', () => {
  const t = invoice.computeTotals({ subtotal: 500_000, discount: 50_000, vatRate: 8, paidAmount: 600_000 });
  assert.equal(t.total_amount, 500_000);
  assert.equal(t.discount, 50_000);
  assert.equal(t.vat_amount, 36_000);      // 8% của 450.000
  assert.equal(t.final_amount, 486_000);   // 450.000 + 36.000
  assert.equal(t.change_amount, 114_000);  // 600.000 − 486.000
});

test('invoice: VAT 0% hợp lệ (hộ kinh doanh không chịu thuế)', () => {
  const t = invoice.computeTotals({ subtotal: 200_000, vatRate: 0 });
  assert.equal(t.vat_amount, 0);
  assert.equal(t.final_amount, 200_000);
});

test('invoice: chặn giảm giá vượt tiền hàng', () => {
  assert.throws(
    () => invoice.computeTotals({ subtotal: 100_000, discount: 150_000 }),
    (err) => err instanceof AppError
      && err.code === 'VALIDATION_ERROR'
      && err.details.some((d) => d.startsWith('discount:'))
  );
});

test('invoice: chặn khách trả thiếu', () => {
  assert.throws(
    () => invoice.computeTotals({ subtotal: 100_000, vatRate: 8, paidAmount: 50_000 }),
    /trả thiếu/
  );
});

test('invoice: không truyền paid_amount → coi như trả đúng, tiền thừa 0', () => {
  const t = invoice.computeTotals({ subtotal: 100_000, vatRate: 8 });
  assert.equal(t.paid_amount, t.final_amount);
  assert.equal(t.change_amount, 0);
});

test('invoice: chặn phương thức thanh toán lạ', () => {
  assert.throws(() => invoice.assertValidPaymentMethod('bitcoin'), AppError);
  assert.doesNotThrow(() => invoice.assertValidPaymentMethod('momo'));
});

// ─── Token phiên khách ──────────────────────────────────────────────────────
test('guest: token hợp lệ giải mã được đúng mã phiên', () => {
  const sid = '550e8400-e29b-41d4-a716-446655440000';
  const exp = new Date(Date.now() + 3600_000);
  const token = guest.issueToken(sid, exp);
  const parsed = guest.parseToken(token);
  assert.equal(parsed.sid, sid);
});

test('guest: token bị sửa chữ ký → từ chối', () => {
  const sid = '550e8400-e29b-41d4-a716-446655440000';
  const token = guest.issueToken(sid, new Date(Date.now() + 3600_000));
  const tampered = `${token.slice(0, -4)}AAAA`;
  assert.throws(() => guest.parseToken(tampered), /không hợp lệ/);
});

test('guest: đổi mã phiên trong token → chữ ký không khớp, từ chối', () => {
  const token = guest.issueToken('550e8400-e29b-41d4-a716-446655440000', new Date(Date.now() + 3600_000));
  const parts = token.split('.');
  const forged = ['660e8400-e29b-41d4-a716-446655440000', parts[1], parts[2]].join('.');
  assert.throws(() => guest.parseToken(forged), /không hợp lệ/);
});

test('guest: token hết hạn → từ chối với mã riêng', () => {
  const token = guest.issueToken('550e8400-e29b-41d4-a716-446655440000', new Date(Date.now() - 1000));
  assert.throws(() => guest.parseToken(token), (err) => err.code === 'GUEST_SESSION_EXPIRED');
});

test('guest: tên hiển thị bị làm sạch ký tự nguy hiểm', () => {
  assert.equal(guest.sanitizeDisplayName('  Anh Minh  '), 'Anh Minh');
  assert.equal(guest.sanitizeDisplayName('<script>alert(1)</script>'), 'scriptalert(1)/script');
  assert.equal(guest.sanitizeDisplayName(''), null);
  assert.equal(guest.sanitizeDisplayName('x'.repeat(100)).length, 40);
});

test('guest: số điện thoại Việt Nam được kiểm tra định dạng', () => {
  assert.equal(guest.sanitizePhone('0901234567'), '0901234567');
  assert.equal(guest.sanitizePhone('090 123 4567'), '0901234567');
  assert.throws(() => guest.sanitizePhone('12345'), AppError);
});

test('guest: phiên đã đóng hoặc hết hạn không dùng được', () => {
  const future = new Date(Date.now() + 3600_000);
  assert.doesNotThrow(() => guest.assertSessionUsable({ status: 'active', expires_at: future }));
  assert.throws(() => guest.assertSessionUsable({ status: 'closed', expires_at: future }), AppError);
  assert.throws(() => guest.assertSessionUsable({ status: 'blocked', expires_at: future }), /tạm khoá/);
  assert.throws(
    () => guest.assertSessionUsable({ status: 'active', expires_at: new Date(Date.now() - 1000) }),
    AppError
  );
});

// ─── Phân quyền ─────────────────────────────────────────────────────────────
test('roles: ma trận quyền đúng với từng vai trò', () => {
  assert.equal(roles.can('admin', 'user.write'), true);
  assert.equal(roles.can('cashier', 'user.write'), false);
  assert.equal(roles.can('waiter', 'order.create'), true);
  assert.equal(roles.can('cashier', 'order.create'), false, 'thu ngân không mở đơn mới');
  assert.equal(roles.can('cashier', 'invoice.checkout'), true);
  assert.equal(roles.can('waiter', 'invoice.checkout'), false);
  assert.equal(roles.can('waiter', 'order.confirm_guest'), true, 'phục vụ duyệt được món khách gọi');
});

test('roles: hành động chưa khai báo thì mặc định TỪ CHỐI', () => {
  assert.equal(roles.can('admin', 'hanh.dong.khong.ton.tai'), false);
});

// ─── Bàn ────────────────────────────────────────────────────────────────────
test('table: không tạm ngưng được bàn đang có khách', () => {
  assert.throws(
    () => table.assertCanDeactivate({ state: 'serving', table_code: 'T1-01', current_order_code: 'ORD-1' }),
    /đang có đơn mở/
  );
  assert.doesNotThrow(() => table.assertCanDeactivate({ state: 'empty', table_code: 'T1-01' }));
});

test('table: mã bàn phải đúng quy ước', () => {
  assert.doesNotThrow(() => table.assertValidTable({ code: 'T1-01', capacity: 4 }));
  assert.doesNotThrow(() => table.assertValidTable({ code: 'VIP-01', capacity: 10 }));
  assert.throws(() => table.assertValidTable({ code: 'a', capacity: 4 }), AppError);
  assert.throws(() => table.assertValidTable({ code: 'T1-01', capacity: 0 }), AppError);
  assert.throws(() => table.assertValidTable({ code: 'T1-01', capacity: 99 }), AppError);
});
