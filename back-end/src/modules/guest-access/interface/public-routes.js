// =============================================================================
//  MODULE guest-access · INTERFACE — REST /api/public (KHÔNG cần đăng nhập)
// -----------------------------------------------------------------------------
//  Bề mặt công khai duy nhất của hệ thống. Nguyên tắc thiết kế:
//    • Chỉ 2 nhóm thao tác: xem thực đơn & gửi/xem món của CHÍNH MÌNH.
//    • Không trả doanh thu, không trả thông tin nhân viên, không trả đơn của
//      bàn khác. Mọi truy vấn đều bị giới hạn bởi phiên khách.
//    • Giá luôn lấy từ CSDL (qua catalog), client không gửi giá lên.
//    • Giới hạn tần suất theo IP thật (sau Cloudflare + Caddy).
// =============================================================================
const express = require('express');
const sessionService = require('../application/guest-session-service');
const orderService = require('../application/guest-order-service');
const { requireGuestSession } = require('./guest-middleware');
const { ok, created, asyncHandler } = require('../../../shared/http');
const { validateBody, validateParams } = require('../../../shared/validation');
const { publicLimiter } = require('../../../platform/http/rate-limit');

const router = express.Router();

// Mọi route công khai đều bị giới hạn tần suất
router.use(publicLimiter);

const qrParam = validateParams({ qrKey: { required: true, type: 'string', minLength: 1, maxLength: 64 } });

const meta = (req) => ({ ip: req.clientIp || req.ip, userAgent: req.headers['user-agent'] });

/**
 * Bước 1 — Khách quét QR: mở phiên (hoặc tiếp tục phiên cũ nếu còn hiệu lực).
 * Trả về guest token để lưu trong localStorage.
 */
router.post('/session/:qrKey', qrParam,
  validateBody({
    display_name: { type: 'string', maxLength: 40 },
    phone:        { type: 'string', maxLength: 20 },
  }),
  asyncHandler(async (req, res) => {
    const result = await sessionService.startSession({
      qrKey: req.params.qrKey,
      existingToken: req.headers['x-guest-token'],
      displayName: req.body?.display_name,
      phone: req.body?.phone,
      meta: meta(req),
    });
    return result.resumed
      ? ok(res, result, { message: 'Tiếp tục phiên gọi món' })
      : created(res, result, 'Đã mở phiên gọi món');
  })
);

/** Thông tin bàn gắn với mã QR — hiển thị trước khi khách mở phiên. */
router.get('/table/:qrKey', qrParam, asyncHandler(async (req, res) => {
  const table = await sessionService.resolveTableFromQr(req.params.qrKey);
  return ok(res, { code: table.code, zone: table.zone, zone_name: table.zone_name, capacity: table.capacity });
}));

/** Thực đơn cho khách (cần phiên để biết khách đang ở bàn nào). */
router.get('/menu', requireGuestSession, asyncHandler(async (req, res) =>
  ok(res, await orderService.menuForGuest(req.guestSession))
));

/** Thông tin phiên hiện tại. */
router.get('/session', requireGuestSession, asyncHandler(async (req, res) =>
  ok(res, await orderService.orderHistory(req.guestSession))
));

/** Cập nhật tên hiển thị / số điện thoại (tuỳ chọn). */
router.put('/session', requireGuestSession,
  validateBody({
    display_name: { type: 'string', maxLength: 40 },
    phone:        { type: 'string', maxLength: 20 },
  }),
  asyncHandler(async (req, res) =>
    ok(res, await sessionService.updateProfile(req.guestSession, req.body), { message: 'Đã cập nhật' })
  )
);

/** Bước 2 — Khách gửi món. */
router.post('/orders', requireGuestSession,
  validateBody({
    items: { required: true, type: 'array' },
    note:  { type: 'string', maxLength: 300 },
  }),
  asyncHandler(async (req, res) => {
    const result = await orderService.submitOrder(req.guestSession, req.body, meta(req));
    return created(res, result,
      result.status === 'pending'
        ? 'Đã gửi yêu cầu, nhà hàng sẽ xác nhận trong giây lát'
        : 'Đã gửi món, nhà hàng sẽ phục vụ ngay');
  })
);

/**
 * Bước 3 — LỊCH SỬ ĐẶT MÓN CỦA KHÁCH.
 * Đây là màn hình "Đơn của tôi" mà phiên bản trước còn thiếu.
 */
router.get('/orders', requireGuestSession, asyncHandler(async (req, res) =>
  ok(res, await orderService.orderHistory(req.guestSession))
));

/** Khách chủ động kết thúc phiên (bấm "Xong"). */
router.post('/session/close', requireGuestSession, asyncHandler(async (req, res) =>
  ok(res, await sessionService.closeSession(req.guestSession), { message: 'Đã kết thúc phiên gọi món' })
));

module.exports = router;
