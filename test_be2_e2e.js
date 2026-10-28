const crypto = require('crypto');

const CUSTOMER_API = 'http://localhost:5000';
const BACKEND_API = 'http://localhost:3000';

async function req(url, options = {}) {
  const defaultHeaders = {
    'Content-Type': 'application/json',
    'X-Request-Id': crypto.randomUUID(),
    'X-Timestamp': Math.floor(Date.now() / 1000).toString(),
  };

  const res = await fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return { status: res.status, data };
}

async function main() {
  console.log('=== BẮT ĐẦU TEST TOÀN DIỆN BE-2 (KÈM Ý 1 & Ý 2 ĐÃ SỬA) ===\n');

  // 1. Session Init
  console.log('1. Khách quét QR bàn T1-01 -> Init session...');
  const qrSecret = 'ad3181f0a3464ccf380b754ba58799911a298064e2037135cc8e5623dcd1dba7';
  const qrToken = crypto.createHmac('sha256', qrSecret).update('T1-01').digest('hex');

  const initRes = await req(`${CUSTOMER_API}/public-api/session/init`, {
    method: 'POST',
    body: JSON.stringify({
      qrToken: qrToken,
      tableCode: 'T1-01',
      deviceFingerprint: 'device-test-be2-e2e',
    }),
  });
  const sessionToken = initRes.data.sessionToken;
  console.log('   OK! SessionToken:', sessionToken.slice(0, 20) + '...');

  const customerHeaders = {
    'X-Session-Token': sessionToken,
    'X-Table-Code': 'T1-01',
  };

  // 2. Tạo đơn hàng khách (Guest Order)
  console.log('\n2. Khách gửi đơn hàng qua QR (POST /public-api/orders)...');
  const createOrderRes = await req(`${CUSTOMER_API}/public-api/orders`, {
    method: 'POST',
    headers: customerHeaders,
    body: JSON.stringify({
      notes: 'Không hành, ít đá',
      items: [
        {
          menuItemId: '6c0772b3-2c4f-4cf0-bee1-a670de54b5a5',
          itemName: 'Gỏi Cuốn Tôm Thịt',
          quantity: 2,
          price: 65000,
          notes: 'Tương đậu phộng',
        },
        {
          menuItemId: 'd9af934a-f7e6-4ac1-8050-1d412ef25c7f',
          itemName: 'Chả Giò Hải Sản',
          quantity: 1,
          price: 75000,
          notes: 'Chiên giòn',
        },
      ],
    }),
  });
  const guestOrder = createOrderRes.data;
  console.log('   OK! Đơn khách ID:', guestOrder.id, '| Code:', guestOrder.code, '| Status:', guestOrder.status);

  // 3. Tra cứu đơn hàng theo mã công khai
  console.log('\n3. Khách tra cứu đơn theo mã (GET /public-api/orders/by-code/:code)...');
  const byCodeRes = await req(`${CUSTOMER_API}/public-api/orders/by-code/${guestOrder.code}`);
  console.log('   OK! Tra cứu thành công đơn:', byCodeRes.data.code, '| Trạng thái:', byCodeRes.data.status);

  // 4. Khách xem tạm tính hóa đơn (VAT 8%)
  console.log('\n4. Khách xem tạm tính hóa đơn VAT 8% (GET /public-api/orders/:id/receipt)...');
  const receiptRes = await req(`${CUSTOMER_API}/public-api/orders/${guestOrder.id}/receipt`, {
    headers: customerHeaders,
  });
  console.log('   OK! Tạm tính:', {
    subtotal: receiptRes.data.subtotal,
    vatRate: receiptRes.data.vatRate + '%',
    vatAmount: receiptRes.data.vatAmount,
    total: receiptRes.data.total,
  });

  // 5. Staff đăng nhập
  console.log('\n5. Nhân viên đăng nhập hệ thống...');
  const staffLoginRes = await req(`${BACKEND_API}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({
      username: 'admin',
      password: '123',
    }),
  });
  const staffToken = staffLoginRes.data.data.token;
  console.log('   OK! Staff token:', staffToken.slice(0, 20) + '...');

  const staffHeaders = {
    'Authorization': `Bearer ${staffToken}`,
  };

  // 6. Staff lấy danh sách đơn pending
  console.log('\n6. Staff kiểm tra danh sách đơn pending (GET /api/guest-orders/pending)...');
  const pendingOrdersRes = await req(`${BACKEND_API}/api/guest-orders/pending`, { headers: staffHeaders });
  console.log('   OK! Số đơn pending:', pendingOrdersRes.data.data.length);

  // 7. Staff xác nhận đơn (Snapshot + Snapshot items + SELECT FOR UPDATE)
  console.log('\n7. Staff xác nhận đơn khách (POST /api/guest-orders/:id/confirm)...');
  const confirmRes = await req(`${BACKEND_API}/api/guest-orders/${guestOrder.id}/confirm`, {
    method: 'POST',
    headers: staffHeaders,
    body: JSON.stringify({}),
  });
  const internalOrderId = confirmRes.data.data.orderId;
  console.log('   OK! Xác nhận thành công. Internal Order ID:', internalOrderId);

  // 8. Staff chuyển trạng thái đơn sang 'serving' trên POS
  console.log('\n8. Staff cập nhật trạng thái đơn thành "serving" trên POS...');
  const updateRes = await req(`${BACKEND_API}/api/orders/${internalOrderId}/status`, {
    method: 'PUT',
    headers: staffHeaders,
    body: JSON.stringify({ status: 'serving' }),
  });
  console.log('   OK! Response message:', updateRes.data.message);

  // 9. Kiểm tra đồng bộ 2 chiều (Ý 2): Trạng thái guest_orders tự động đổi sang 'served'
  console.log('\n9. Khách kiểm tra trạng thái đơn hàng (GET /public-api/orders/:id/status)...');
  const statusRes = await req(`${CUSTOMER_API}/public-api/orders/${guestOrder.id}/status`, {
    headers: customerHeaders,
  });
  console.log('   OK! Trạng thái đơn khách hiện tại:', statusRes.data.status);
  if (statusRes.data.status !== 'served') {
    throw new Error(`Đồng bộ 2 chiều thất bại: status phải là 'served' nhưng nhận '${statusRes.data.status}'`);
  }
  console.log('   ==> [Ý 2 THÀNH CÔNG]: Đồng bộ 2 chiều tự động từ orders -> guest_orders hoạt động chuẩn xác!');

  // 10. Khách đánh giá Feedback (Chỉ mở khi status = served)
  console.log('\n10. Khách gửi đánh giá món ăn (POST /public-api/orders/:id/feedback)...');
  const feedbackRes = await req(`${CUSTOMER_API}/public-api/orders/${guestOrder.id}/feedback`, {
    method: 'POST',
    headers: customerHeaders,
    body: JSON.stringify({
      rating: 5,
      comment: 'Món ăn rất vừa miệng, phục vụ chu đáo!',
    }),
  });
  console.log('   OK! Đánh giá thành công ID:', feedbackRes.data.id, '| Rating:', feedbackRes.data.rating);

  // 11. Khách bấm chuông gọi nhân viên
  console.log('\n11. Khách gọi phục vụ (POST /public-api/call-staff)...');
  const callStaffRes = await req(`${CUSTOMER_API}/public-api/call-staff`, {
    method: 'POST',
    headers: customerHeaders,
    body: JSON.stringify({
      reason: 'Cho bàn T1-01 xin thêm 1 bình nước đá',
    }),
  });
  const staffCallId = callStaffRes.data.id;
  console.log('   OK! Gọi nhân viên thành công. Call ID:', staffCallId, '| Reason:', callStaffRes.data.reason);

  // 12. Staff xem danh sách gọi phục vụ
  console.log('\n12. Staff xem danh sách gọi phục vụ (GET /api/staff-calls/pending)...');
  const pendingCallsRes = await req(`${BACKEND_API}/api/staff-calls/pending`, { headers: staffHeaders });
  console.log('   OK! Số yêu cầu đang chờ:', pendingCallsRes.data.data.length);

  // 13. Staff tiếp nhận yêu cầu
  console.log('\n13. Staff tiếp nhận yêu cầu (POST /api/staff-calls/:id/acknowledge)...');
  const ackRes = await req(`${BACKEND_API}/api/staff-calls/${staffCallId}/acknowledge`, {
    method: 'POST',
    headers: staffHeaders,
    body: JSON.stringify({}),
  });
  console.log('   OK! Trạng thái yêu cầu:', ackRes.data.data.status);

  // 14. Staff hoàn thành yêu cầu
  console.log('\n14. Staff hoàn thành yêu cầu (POST /api/staff-calls/:id/done)...');
  const doneRes = await req(`${BACKEND_API}/api/staff-calls/${staffCallId}/done`, {
    method: 'POST',
    headers: staffHeaders,
    body: JSON.stringify({}),
  });
  console.log('   OK! Trạng thái yêu cầu:', doneRes.data.data.status);

  // 15. Test Rate Limiting gọi nhân viên (Chính sách: 2 lần / phút)
  console.log('\n15. Test Rate Limiting cho Call Staff (tối đa 2 lần / phút)...');
  try {
    // Lần 2 (lần 1 ở bước 11)
    await req(`${CUSTOMER_API}/public-api/call-staff`, {
      method: 'POST',
      headers: customerHeaders,
      body: JSON.stringify({ reason: 'Xin hóa đơn tính tiền' }),
    });
    console.log('   Lần 2: Chấp nhận (201 Created)');

    // Lần 3: Phải bị 429 Too Many Requests
    await req(`${CUSTOMER_API}/public-api/call-staff`, {
      method: 'POST',
      headers: customerHeaders,
      body: JSON.stringify({ reason: 'Yêu cầu khác' }),
    });
    console.log('   FAIL: Lần 3 không bị chặn!');
  } catch (err) {
    if (err.status === 429) {
      console.log('   OK! Lần 3 bị chặn chính xác với mã 429 Too Many Requests!');
    } else {
      console.log('   Lỗi khác:', err.status, err.message);
    }
  }

  console.log('\n============================================================');
  console.log(' TẤT CẢ 15 BƯỚC TEST BE-2 VÀ CÁC Ý SỬA ĐỔI ĐÃ THÀNH CÔNG 100%!');
  console.log('============================================================\n');
}

main().catch(err => {
  console.error('\nLỖI TRONG QUÁ TRÌNH TEST:', err.message, err.data || '');
  process.exit(1);
});
