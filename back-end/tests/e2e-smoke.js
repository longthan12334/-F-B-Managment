// =============================================================================
//  KIỂM THỬ ĐẦU-CUỐI (E2E) — chạy trên hệ thống đang hoạt động thật
// -----------------------------------------------------------------------------
//  Đi hết một ca bán hàng, nhấn mạnh LUỒNG MỚI của khách quét mã QR:
//
//    A. Nhân viên    : đăng nhập 3 vai trò, kiểm tra phân quyền
//    B. Sơ đồ bàn    : đọc hình chiếu trạng thái bàn
//    C. Khách QR     : mở phiên → xem thực đơn → gửi món → XEM LỊCH SỬ
//    D. Nhân viên    : thấy yêu cầu chờ duyệt → DUYỆT một phần, TỪ CHỐI một phần
//    E. Khách QR     : lịch sử cập nhật đúng trạng thái từng món
//    F. Thanh toán   : chặn khi còn món chờ duyệt, cho phép khi đã duyệt hết
//    G. Sau thanh toán: bàn về trống, phiên khách đóng, báo cáo cập nhật
//    H. Ranh giới    : vai trò không đủ quyền bị từ chối
//
//  Chạy:  node tests/e2e-smoke.js   (cần backend đang chạy ở BASE)
// =============================================================================
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';

let passed = 0; let failed = 0;
const G = '\x1b[32m'; const R = '\x1b[31m'; const Y = '\x1b[33m'; const D = '\x1b[2m'; const N = '\x1b[0m';

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ${G}✓${N} ${name}`); }
  else { failed++; console.log(`  ${R}✗${N} ${name}${detail ? `\n      ${D}${detail}${N}` : ''}`); }
}

function section(title) { console.log(`\n${Y}${title}${N}`); }

async function api(method, path, { token, guestToken, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (guestToken) headers['X-Guest-Token'] = guestToken;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

async function main() {
  console.log(`\n${D}Kiểm thử đầu-cuối RestoManager — ${BASE}${N}`);

  // ─── A. Xác thực ──────────────────────────────────────────────────────────
  section('A. Xác thực & phân quyền');

  const health = await api('GET', '/api/health');
  check('GET /api/health trả về ok', health.body?.data?.status === 'ok',
    JSON.stringify(health.body?.data?.checks || {}).slice(0, 200));

  const arch = await api('GET', '/api/architecture');
  check('Nạp đủ 8 module', arch.body?.data?.count === 8, `nhận ${arch.body?.data?.count}`);
  check('Thứ tự nạp tôn trọng phụ thuộc',
    arch.body?.data?.loadOrder?.indexOf('identity') === 0);

  const login = async (username) => {
    const r = await api('POST', '/api/auth/login', { body: { username, password: '123' } });
    return r.body?.data;
  };

  const admin = await login('admin');
  const cashier = await login('cashier');
  const waiter = await login('waiter');
  check('admin đăng nhập được', Boolean(admin?.token));
  check('cashier đăng nhập được', Boolean(cashier?.token));
  check('waiter đăng nhập được', Boolean(waiter?.token));

  const badLogin = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'sai' } });
  check('Sai mật khẩu → 401', badLogin.status === 401);
  check('Không tiết lộ tài khoản có tồn tại hay không',
    badLogin.body?.message === 'Tên đăng nhập hoặc mật khẩu không đúng');

  const noToken = await api('GET', '/api/orders');
  check('Không có token → 401', noToken.status === 401);

  const waiterSeesUsers = await api('GET', '/api/users', { token: waiter.token });
  check('waiter không xem được danh sách nhân viên → 403', waiterSeesUsers.status === 403);

  // ─── B. Sơ đồ bàn ─────────────────────────────────────────────────────────
  section('B. Sơ đồ bàn (hình chiếu trạng thái)');

  const tablesRes = await api('GET', '/api/tables?with_status=true', { token: waiter.token });
  const tables = tablesRes.body?.data || [];
  check('Lấy được sơ đồ bàn', tables.length > 0, `nhận ${tables.length} bàn`);
  check('Mỗi bàn có trạng thái', tables.every((t) => Boolean(t.state)));
  check('Mỗi bàn có mã QR riêng', tables.every((t) => Boolean(t.qr_slug)));
  check('Mã QR không trùng nhau', new Set(tables.map((t) => t.qr_slug)).size === tables.length);

  const table = tables.find((t) => t.state === 'empty' && t.is_active);
  check('Có bàn trống để kiểm thử', Boolean(table));
  if (!table) return finish();

  // ─── C. Khách quét QR ─────────────────────────────────────────────────────
  section('C. Khách quét mã QR — mở phiên và gọi món');

  const publicTable = await api('GET', `/api/public/table/${table.qr_slug}`);
  check('Quét mã QR tra được bàn (không cần đăng nhập)', publicTable.body?.data?.code === table.code);

  const guessed = await api('GET', '/api/public/table/khong-ton-tai-abc');
  check('Mã QR sai → 404', guessed.status === 404);

  const sessionRes = await api('POST', `/api/public/session/${table.qr_slug}`,
    { body: { display_name: 'Anh Minh' } });
  const guestToken = sessionRes.body?.data?.token;
  check('Mở được phiên khách', Boolean(guestToken));
  check('Phiên gắn đúng bàn', sessionRes.body?.data?.session?.table_code === table.code);
  check('Phiên có hạn sử dụng', Boolean(sessionRes.body?.data?.session?.expires_at));

  const noSession = await api('GET', '/api/public/menu');
  check('Xem thực đơn mà không có phiên → 401', noSession.status === 401);

  const menuRes = await api('GET', '/api/public/menu', { guestToken });
  const menu = menuRes.body?.data;
  check('Khách xem được thực đơn', (menu?.items?.length || 0) > 0, `${menu?.items?.length} món`);
  check('Thực đơn khách không lộ trường quản trị',
    menu?.items?.every((i) => i.is_active === undefined && i.image_key === undefined));

  const dish1 = menu.items[0];
  const dish2 = menu.items[1];
  const dish3 = menu.items[2];

  const submit1 = await api('POST', '/api/public/orders', {
    guestToken,
    body: { items: [{ menu_item_id: dish1.id, quantity: 2 }, { menu_item_id: dish2.id, quantity: 1 }] },
  });
  check('Khách gửi món thành công', submit1.status === 201, JSON.stringify(submit1.body).slice(0, 200));
  check('Yêu cầu ở trạng thái chờ duyệt', submit1.body?.data?.status === 'pending');
  const expected1 = dish1.price * 2 + dish2.price;
  check('Giá lấy từ CSDL, đúng tổng tiền', submit1.body?.data?.amount === expected1,
    `kỳ vọng ${expected1}, nhận ${submit1.body?.data?.amount}`);

  // Thử gian lận giá
  const cheat = await api('POST', '/api/public/orders', {
    guestToken,
    body: { items: [{ menu_item_id: dish3.id, quantity: 1, price: 1 }] },
  });
  const cheatAmount = cheat.body?.data?.amount;
  check('Khách KHÔNG sửa được giá (giá luôn từ CSDL)', cheatAmount === dish3.price,
    `gửi price=1, hệ thống tính ${cheatAmount} (giá thật ${dish3.price})`);

  const badItem = await api('POST', '/api/public/orders', {
    guestToken, body: { items: [{ menu_item_id: 'khong-phai-uuid', quantity: 1 }] },
  });
  check('menu_item_id sai định dạng → 422', badItem.status === 422);

  // ─── Lịch sử đặt món của khách ────────────────────────────────────────────
  section('D. LỊCH SỬ ĐẶT MÓN CỦA KHÁCH (tính năng mới)');

  const history1 = await api('GET', '/api/public/orders', { guestToken });
  const h1 = history1.body?.data;
  check('Khách xem được lịch sử của mình', (h1?.requests?.length || 0) === 2,
    `nhận ${h1?.requests?.length} lượt gửi`);
  check('Lịch sử ghi nhận còn món chờ duyệt', h1?.summary?.has_pending === true);
  check('Tiền chờ duyệt tính đúng', h1?.summary?.pending_amount === expected1 + dish3.price,
    `nhận ${h1?.summary?.pending_amount}`);
  check('Tiền đã xác nhận bằng 0 khi chưa ai duyệt', h1?.summary?.confirmed_amount === 0);
  check('Mỗi lượt gửi có nhãn trạng thái tiếng Việt',
    h1?.requests?.every((r) => Boolean(r.status_label)));

  // ─── E. Nhân viên duyệt ───────────────────────────────────────────────────
  section('E. Nhân viên xác nhận / từ chối món khách gọi');

  const pendingRes = await api('GET', '/api/guest-requests/pending', { token: cashier.token });
  const pending = pendingRes.body?.data || [];
  check('Nhân viên thấy hàng đợi yêu cầu', pending.length >= 2, `${pending.length} yêu cầu`);
  check('Yêu cầu hiển thị số phút đã chờ', pending.every((p) => typeof p.waiting_minutes === 'number'));

  const orderRes = await api('GET', `/api/orders/by-table/${table.id}`, { token: cashier.token });
  const order = orderRes.body?.data;
  check('Món khách gọi đã vào đơn của bàn', Boolean(order?.id));
  check('Đơn được đánh dấu nguồn QR', order?.source === 'qr');
  check('Tổng tiền đơn = 0 khi chưa duyệt món nào', order?.total_amount === 0,
    `nhận ${order?.total_amount}`);
  check('Đơn hiển thị riêng tiền chờ duyệt', order?.pending_amount > 0);

  const req1 = pending.find((p) => p.request_id === submit1.body?.data?.request_id);
  const req2 = pending.find((p) => p.request_id === cheat.body?.data?.request_id);

  const approve = await api('POST', `/api/orders/guest-requests/${req1.request_id}/review`,
    { token: cashier.token, body: { approve: true } });
  check('Duyệt lượt gửi thứ nhất', approve.status === 200, JSON.stringify(approve.body).slice(0, 200));
  check('Tổng tiền đơn cập nhật sau khi duyệt',
    approve.body?.data?.order?.total_amount === expected1,
    `nhận ${approve.body?.data?.order?.total_amount}`);

  const reject = await api('POST', `/api/orders/guest-requests/${req2.request_id}/review`,
    { token: cashier.token, body: { approve: false, reason: 'Hết nguyên liệu' } });
  check('Từ chối lượt gửi thứ hai', reject.status === 200);
  check('Món bị từ chối không tính tiền',
    reject.body?.data?.order?.total_amount === expected1,
    `nhận ${reject.body?.data?.order?.total_amount}`);

  const reReview = await api('POST', `/api/orders/guest-requests/${req1.request_id}/review`,
    { token: cashier.token, body: { approve: true } });
  check('Duyệt lại yêu cầu đã xử lý → 409', reReview.status === 409);

  // ─── F. Khách thấy kết quả ────────────────────────────────────────────────
  section('F. Khách thấy kết quả xác nhận');

  await new Promise((r) => setTimeout(r, 400)); // chờ event bus xử lý

  const history2 = await api('GET', '/api/public/orders', { guestToken });
  const h2 = history2.body?.data;
  const confirmedReq = h2?.requests?.find((r) => r.request_id === req1.request_id);
  const rejectedReq = h2?.requests?.find((r) => r.request_id === req2.request_id);

  check('Lượt gửi được duyệt hiện "đã xác nhận"', confirmedReq?.status === 'confirmed',
    `nhận ${confirmedReq?.status}`);
  check('Lượt gửi bị từ chối hiện "từ chối"', rejectedReq?.status === 'rejected',
    `nhận ${rejectedReq?.status}`);
  check('Khách thấy lý do bị từ chối', rejectedReq?.reject_reason === 'Hết nguyên liệu');
  check('Tổng tiền tạm tính của khách khớp đơn', h2?.summary?.confirmed_amount === expected1,
    `nhận ${h2?.summary?.confirmed_amount}`);
  check('Không còn món chờ duyệt', h2?.summary?.has_pending === false);

  // ─── G. Thanh toán ────────────────────────────────────────────────────────
  section('G. Thanh toán');

  // Gửi thêm một lượt để kiểm tra việc CHẶN thanh toán khi còn món chờ duyệt
  const submit3 = await api('POST', '/api/public/orders', {
    guestToken, body: { items: [{ menu_item_id: dish3.id, quantity: 1 }] },
  });
  check('Khách gửi thêm lượt thứ ba', submit3.status === 201);

  const blocked = await api('POST', '/api/invoices', {
    token: cashier.token, body: { order_id: order.id, cashier_name: 'Thu ngân' },
  });
  check('CHẶN thanh toán khi còn món chờ duyệt → 409', blocked.status === 409,
    `nhận ${blocked.status}: ${blocked.body?.message}`);

  await api('POST', `/api/orders/guest-requests/${submit3.body.data.request_id}/review`,
    { token: cashier.token, body: { approve: true } });

  const finalTotal = expected1 + dish3.price;
  const checkout = await api('POST', '/api/invoices', {
    token: cashier.token,
    body: { order_id: order.id, cashier_name: 'Trần Thị Lan', vat_rate: 8,
            payment_method: 'cash', paid_amount: 10_000_000 },
  });
  const invoice = checkout.body?.data;
  check('Thanh toán thành công', checkout.status === 201, JSON.stringify(checkout.body).slice(0, 200));
  check('Tiền hàng đúng', invoice?.total_amount === finalTotal,
    `kỳ vọng ${finalTotal}, nhận ${invoice?.total_amount}`);
  check('VAT 8% tính đúng', invoice?.vat_amount === Math.round(finalTotal * 0.08),
    `nhận ${invoice?.vat_amount}`);
  check('Thành tiền = tiền hàng + VAT', invoice?.final_amount === finalTotal + invoice?.vat_amount);
  check('Tiền thừa tính đúng', invoice?.change_amount === 10_000_000 - invoice?.final_amount);
  check('Hoá đơn chỉ gồm món đã xác nhận',
    invoice?.items?.length === 3, `nhận ${invoice?.items?.length} dòng`);

  const double = await api('POST', '/api/invoices', {
    token: cashier.token, body: { order_id: order.id, cashier_name: 'Thu ngân' },
  });
  check('Thanh toán lần hai bị chặn → 409', double.status === 409);

  const waiterCheckout = await api('POST', '/api/invoices', {
    token: waiter.token, body: { order_id: order.id, cashier_name: 'Phục vụ' },
  });
  check('waiter không được thanh toán → 403', waiterCheckout.status === 403);

  // ─── H. Sau thanh toán ────────────────────────────────────────────────────
  section('H. Sau thanh toán — sự kiện lan toả đúng');

  await new Promise((r) => setTimeout(r, 600));

  const tablesAfter = await api('GET', '/api/tables?with_status=true', { token: cashier.token });
  const tableAfter = tablesAfter.body?.data?.find((t) => t.id === table.id);
  check('Bàn trở về trạng thái trống', tableAfter?.state === 'empty', `nhận ${tableAfter?.state}`);
  check('Bàn không còn mã đơn đang mở', !tableAfter?.current_order_code);

  const guestAfter = await api('GET', '/api/public/orders', { guestToken });
  check('Phiên khách đã đóng sau thanh toán → 401', guestAfter.status === 401,
    `nhận ${guestAfter.status}`);

  const stats = await api('GET', '/api/stats/overview', { token: admin.token });
  check('Báo cáo ghi nhận hoá đơn mới', stats.body?.data?.summary?.invoice_count >= 1,
    `nhận ${stats.body?.data?.summary?.invoice_count}`);
  check('Doanh thu báo cáo khớp hoá đơn',
    stats.body?.data?.summary?.total_revenue >= invoice.final_amount);
  check('Báo cáo có món bán chạy', (stats.body?.data?.topItems?.length || 0) > 0);

  const logs = await api('GET', '/api/logs?limit=100', { token: admin.token });
  const actions = (logs.body?.data || []).map((l) => l.action);
  check('Nhật ký tự động ghi CHECKOUT', actions.includes('CHECKOUT'));
  check('Nhật ký tự động ghi QR_SUBMIT_ORDER', actions.includes('QR_SUBMIT_ORDER'));
  check('Nhật ký tự động ghi duyệt/từ chối món khách',
    actions.includes('CONFIRM_GUEST_ITEMS') || actions.includes('REJECT_GUEST_ITEMS'));

  const logsAsCashier = await api('GET', '/api/logs', { token: cashier.token });
  check('cashier không xem được nhật ký → 403', logsAsCashier.status === 403);

  // ─── I. Luồng nhân viên truyền thống ─────────────────────────────────────
  section('I. Luồng nhân viên (không qua QR)');

  const freeTable = (await api('GET', '/api/tables?with_status=true', { token: waiter.token }))
    .body?.data?.find((t) => t.state === 'empty' && t.is_active && t.id !== table.id);

  const staffOrder = await api('POST', '/api/orders', {
    token: waiter.token,
    body: { table_id: freeTable.id, waiter_name: 'Hoàng Nam',
            items: [{ menu_item_id: dish1.id, quantity: 3 }] },
  });
  check('Phục vụ mở đơn mới', staffOrder.status === 201, JSON.stringify(staffOrder.body).slice(0, 150));
  check('Món nhân viên nhập được duyệt ngay',
    staffOrder.body?.data?.items?.every((i) => i.status === 'confirmed'));
  check('Tổng tiền tính ngay', staffOrder.body?.data?.total_amount === dish1.price * 3);

  const dup = await api('POST', '/api/orders', {
    token: waiter.token,
    body: { table_id: freeTable.id, waiter_name: 'Hoàng Nam',
            items: [{ menu_item_id: dish1.id, quantity: 1 }] },
  });
  check('Mở đơn thứ hai cho cùng bàn bị chặn → 409', dup.status === 409);

  const cleared = await api('POST', `/api/orders/clear-table/${freeTable.id}`,
    { token: cashier.token, body: { reason: 'Khách bỏ về' } });
  check('Dọn bàn thành công', cleared.status === 200);

  await new Promise((r) => setTimeout(r, 400));
  const afterClear = (await api('GET', '/api/tables?with_status=true', { token: cashier.token }))
    .body?.data?.find((t) => t.id === freeTable.id);
  check('Bàn trống lại sau khi dọn', afterClear?.state === 'empty');

  finish();
}

function finish() {
  console.log(`\n${'─'.repeat(60)}`);
  const total = passed + failed;
  if (failed === 0) {
    console.log(`${G}✓ TẤT CẢ ${total} KIỂM THỬ ĐỀU ĐẠT${N}\n`);
    process.exit(0);
  }
  console.log(`${R}✗ ${failed}/${total} kiểm thử KHÔNG ĐẠT${N} ${D}(${passed} đạt)${N}\n`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`\n${R}Lỗi khi chạy kiểm thử:${N}`, err);
  process.exit(1);
});
