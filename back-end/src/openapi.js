// =============================================================================
//  Đặc tả OpenAPI 3.0 — sinh tại thời điểm khởi động
// -----------------------------------------------------------------------------
//  Tag của tài liệu được sinh TỪ manifest của các module, nên Swagger UI luôn
//  phản ánh đúng cấu trúc module hiện tại: thêm module mới là tài liệu tự có
//  mục mới, không cần cập nhật tay.
// =============================================================================
const { config } = require('./shared/config');

const ENVELOPE_OK = (schema) => ({
  type: 'object',
  properties: {
    success: { type: 'boolean', example: true },
    data: schema || { nullable: true },
    message: { type: 'string' },
    meta: { type: 'object', nullable: true },
  },
});

const ERROR = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    message: { type: 'string', example: 'Dữ liệu không hợp lệ' },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', example: 'VALIDATION_ERROR' },
        details: { nullable: true },
        request_id: { type: 'string', nullable: true },
      },
    },
  },
};

const errorResponse = (description) => ({ description, content: { 'application/json': { schema: ERROR } } });
const okResponse = (description, schema) => ({
  description, content: { 'application/json': { schema: ENVELOPE_OK(schema) } },
});

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

const SCHEMAS = {
  User: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      username: { type: 'string' },
      full_name: { type: 'string' },
      role: { type: 'string', enum: ['admin', 'cashier', 'waiter'] },
      email: { type: 'string', nullable: true },
      phone: { type: 'string', nullable: true },
      is_active: { type: 'boolean' },
      last_login_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  LoginRequest: {
    type: 'object', required: ['username', 'password'],
    properties: { username: { type: 'string', example: 'admin' }, password: { type: 'string', example: '123' } },
  },
  TokenPair: {
    type: 'object',
    properties: {
      token: { type: 'string' },
      refresh_token: { type: 'string' },
      expires_in: { type: 'integer', example: 900 },
      refresh_expires_in: { type: 'integer', example: 2592000 },
      token_type: { type: 'string', example: 'Bearer' },
      user: ref('User'),
    },
  },
  MenuItem: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: 'string', nullable: true },
      price: { type: 'integer', description: 'Số nguyên đồng (VND)' },
      category_code: { type: 'string', nullable: true },
      emoji: { type: 'string', nullable: true },
      image_url: { type: 'string', nullable: true },
      is_active: { type: 'boolean' },
    },
  },
  Table: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      code: { type: 'string', example: 'T1-01' },
      zone: { type: 'string', example: 'indoor' },
      zone_name: { type: 'string', example: 'Trong nhà' },
      capacity: { type: 'integer' },
      qr_slug: { type: 'string', description: 'Tham số trong URL mã QR của bàn' },
      is_active: { type: 'boolean' },
      state: {
        type: 'string',
        enum: ['empty', 'ordering', 'serving', 'awaiting_payment', 'inactive'],
        description: 'Chỉ có khi gọi với ?with_status=true',
      },
      current_order_code: { type: 'string', nullable: true },
      current_amount: { type: 'integer' },
      pending_guest_requests: { type: 'integer', description: 'Số yêu cầu khách QR đang chờ duyệt' },
      minutes_occupied: { type: 'integer' },
    },
  },
  OrderItem: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      item_name: { type: 'string' },
      quantity: { type: 'integer' },
      price: { type: 'integer' },
      total_price: { type: 'integer' },
      notes: { type: 'string', nullable: true },
      status: {
        type: 'string',
        enum: ['pending_confirm', 'confirmed', 'rejected', 'served', 'cancelled'],
        description: 'pending_confirm = khách gọi qua QR, chờ nhân viên duyệt',
      },
      source: { type: 'string', enum: ['staff', 'qr'] },
      guest_request_id: { type: 'string', format: 'uuid', nullable: true },
      reject_reason: { type: 'string', nullable: true },
    },
  },
  Order: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      code: { type: 'string', example: 'ORD-260301120000-ab12' },
      table_code: { type: 'string' },
      waiter_name: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'serving', 'completed', 'cancelled'] },
      source: { type: 'string', enum: ['staff', 'qr'] },
      total_amount: { type: 'integer', description: 'Chỉ tính các món đã xác nhận' },
      pending_amount: { type: 'integer', description: 'Tiền các món khách gọi đang chờ duyệt' },
      pending_count: { type: 'integer' },
      items: { type: 'array', items: ref('OrderItem') },
    },
  },
  Invoice: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      code: { type: 'string', example: 'INV-260301120500-cd34' },
      order_id: { type: 'string', format: 'uuid' },
      table_code: { type: 'string' },
      cashier_name: { type: 'string' },
      total_amount: { type: 'integer' },
      discount: { type: 'integer' },
      vat_rate: { type: 'number' },
      vat_amount: { type: 'integer' },
      final_amount: { type: 'integer' },
      paid_amount: { type: 'integer' },
      change_amount: { type: 'integer' },
      payment_method: { type: 'string' },
      payment_label: { type: 'string' },
      items: { type: 'array', items: ref('OrderItem') },
    },
  },
  GuestSession: {
    type: 'object',
    properties: {
      session_id: { type: 'string', format: 'uuid' },
      table_code: { type: 'string' },
      display_name: { type: 'string', nullable: true },
      status: { type: 'string', enum: ['active', 'closed', 'expired', 'blocked'] },
      expires_at: { type: 'string', format: 'date-time' },
      request_count: { type: 'integer' },
      total_amount: { type: 'integer' },
    },
  },
  GuestRequest: {
    type: 'object',
    properties: {
      request_id: { type: 'string', format: 'uuid' },
      code: { type: 'string', example: 'REQ-260301120000-ef56' },
      status: {
        type: 'string',
        enum: ['pending', 'confirmed', 'partially_confirmed', 'rejected', 'cancelled'],
      },
      status_label: { type: 'string', example: 'Đang chờ nhà hàng xác nhận' },
      table_code: { type: 'string' },
      order_code: { type: 'string', nullable: true },
      items_count: { type: 'integer' },
      amount: { type: 'integer' },
      confirmed_amount: { type: 'integer' },
      reject_reason: { type: 'string', nullable: true },
      submitted_at: { type: 'string', format: 'date-time' },
      items: { type: 'array', items: ref('OrderItem') },
    },
  },
  GuestOrderHistory: {
    type: 'object',
    properties: {
      session: { type: 'object' },
      summary: {
        type: 'object',
        properties: {
          request_count: { type: 'integer' },
          confirmed_amount: { type: 'integer' },
          pending_amount: { type: 'integer' },
          estimated_total: { type: 'integer' },
          has_pending: { type: 'boolean' },
        },
      },
      requests: { type: 'array', items: ref('GuestRequest') },
    },
  },
};

const bearer = [{ bearerAuth: [] }];
const guestAuth = [{ guestToken: [] }];

const uuidPath = (name, desc) => ({
  name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: desc,
});

function buildPaths() {
  return {
    // ─── identity ───────────────────────────────────────────────────────────
    '/api/auth/login': {
      post: {
        tags: ['identity'], summary: 'Đăng nhập', security: [],
        requestBody: { required: true, content: { 'application/json': { schema: ref('LoginRequest') } } },
        responses: {
          200: okResponse('Đăng nhập thành công', ref('TokenPair')),
          401: errorResponse('Sai tên đăng nhập hoặc mật khẩu'),
          429: errorResponse('Quá nhiều lần thử'),
        },
      },
    },
    '/api/auth/refresh': {
      post: {
        tags: ['identity'], summary: 'Làm mới phiên (xoay vòng refresh token)', security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['refresh_token'],
            properties: { refresh_token: { type: 'string' } } } } },
        },
        responses: { 200: okResponse('Cặp token mới', ref('TokenPair')), 401: errorResponse('Refresh token không hợp lệ') },
      },
    },
    '/api/auth/logout': {
      post: { tags: ['identity'], summary: 'Đăng xuất', security: bearer,
        responses: { 200: okResponse('Đã đăng xuất') } },
    },
    '/api/auth/me': {
      get: { tags: ['identity'], summary: 'Thông tin tài khoản hiện tại', security: bearer,
        responses: { 200: okResponse('Tài khoản', ref('User')) } },
    },
    '/api/users': {
      get: { tags: ['identity'], summary: 'Danh sách nhân viên (admin)', security: bearer,
        responses: { 200: okResponse('Danh sách', { type: 'array', items: ref('User') }) } },
      post: { tags: ['identity'], summary: 'Tạo nhân viên (admin)', security: bearer,
        responses: { 201: okResponse('Đã tạo', ref('User')), 409: errorResponse('Trùng tên đăng nhập') } },
    },
    '/api/users/{id}': {
      put: { tags: ['identity'], summary: 'Cập nhật nhân viên (admin)', security: bearer,
        parameters: [uuidPath('id')], responses: { 200: okResponse('Đã cập nhật', ref('User')) } },
      delete: { tags: ['identity'], summary: 'Xoá nhân viên (admin)', security: bearer,
        parameters: [uuidPath('id')], responses: { 200: okResponse('Đã xoá') } },
    },

    // ─── catalog ────────────────────────────────────────────────────────────
    '/api/menu': {
      get: {
        tags: ['catalog'], summary: 'Thực đơn', security: bearer,
        parameters: [
          { name: 'active', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: okResponse('Danh sách món', { type: 'array', items: ref('MenuItem') }) },
      },
      post: {
        tags: ['catalog'], summary: 'Thêm món (admin, multipart)', security: bearer,
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object',
          properties: {
            name: { type: 'string' }, price: { type: 'number' },
            description: { type: 'string' }, category_id: { type: 'string', format: 'uuid' },
            emoji: { type: 'string' }, image: { type: 'string', format: 'binary' },
          } } } } },
        responses: { 201: okResponse('Đã thêm', ref('MenuItem')) },
      },
    },
    '/api/menu/{id}': {
      put: { tags: ['catalog'], summary: 'Sửa món (admin)', security: bearer,
        parameters: [uuidPath('id')], responses: { 200: okResponse('Đã cập nhật', ref('MenuItem')) } },
      delete: { tags: ['catalog'], summary: 'Xoá món (admin)', security: bearer,
        parameters: [uuidPath('id')], responses: { 200: okResponse('Đã xoá') } },
    },
    '/api/files/upload': {
      post: { tags: ['catalog'], summary: 'Tải tệp lên kho MinIO/S3/R2', security: bearer,
        responses: { 201: okResponse('Đã tải lên', { type: 'object',
          properties: { key: { type: 'string' }, url: { type: 'string' }, size: { type: 'integer' } } }) } },
    },

    // ─── dining ─────────────────────────────────────────────────────────────
    '/api/tables': {
      get: {
        tags: ['dining'], summary: 'Sơ đồ bàn', security: bearer,
        parameters: [
          { name: 'zone', in: 'query', schema: { type: 'string' } },
          { name: 'with_status', in: 'query', schema: { type: 'string', enum: ['true', 'false'] },
            description: 'true = kèm trạng thái bàn theo thời gian thực' },
        ],
        responses: { 200: okResponse('Danh sách bàn', { type: 'array', items: ref('Table') }) },
      },
      post: { tags: ['dining'], summary: 'Thêm bàn (admin)', security: bearer,
        responses: { 201: okResponse('Đã tạo', ref('Table')) } },
    },
    '/api/tables/{id}/qr': {
      get: { tags: ['dining'], summary: 'Dữ liệu in mã QR của bàn', security: bearer,
        parameters: [uuidPath('id')],
        responses: { 200: okResponse('Thông tin mã QR', { type: 'object', properties: {
          table_code: { type: 'string' }, qr_slug: { type: 'string' }, order_path: { type: 'string' },
        } }) } },
    },
    '/api/tables/{id}/rotate-qr': {
      post: { tags: ['dining'], summary: 'Cấp mã QR mới cho bàn (admin)', security: bearer,
        parameters: [uuidPath('id')], responses: { 200: okResponse('Đã cấp mã mới') } },
    },
    '/api/tables/{id}/active': {
      patch: { tags: ['dining'], summary: 'Bật/tắt bàn', security: bearer,
        parameters: [uuidPath('id')], responses: { 200: okResponse('Đã cập nhật', ref('Table')) } },
    },

    // ─── ordering ───────────────────────────────────────────────────────────
    '/api/orders': {
      get: { tags: ['ordering'], summary: 'Danh sách đơn', security: bearer,
        parameters: [{ name: 'status', in: 'query', schema: { type: 'string' },
          description: 'Nhiều giá trị cách nhau bằng dấu phẩy: pending,serving' }],
        responses: { 200: okResponse('Danh sách', { type: 'array', items: ref('Order') }) } },
      post: { tags: ['ordering'], summary: 'Mở đơn mới', security: bearer,
        responses: { 201: okResponse('Đã mở đơn', ref('Order')),
          409: errorResponse('Bàn đang có đơn mở') } },
    },
    '/api/orders/pending-items': {
      get: { tags: ['ordering'], summary: 'Món khách gọi qua QR đang chờ duyệt', security: bearer,
        responses: { 200: okResponse('Hàng đợi', { type: 'array', items: ref('OrderItem') }) } },
    },
    '/api/orders/{id}/items': {
      post: { tags: ['ordering'], summary: 'Thêm món vào đơn', security: bearer,
        parameters: [uuidPath('id')], responses: { 200: okResponse('Đã thêm', ref('Order')) } },
    },
    '/api/orders/{id}/items/{itemId}/confirm': {
      post: { tags: ['ordering'], summary: 'Xác nhận một món khách gọi', security: bearer,
        parameters: [uuidPath('id'), uuidPath('itemId')],
        responses: { 200: okResponse('Đã xác nhận', ref('Order')) } },
    },
    '/api/orders/{id}/items/{itemId}/reject': {
      post: { tags: ['ordering'], summary: 'Từ chối một món khách gọi', security: bearer,
        parameters: [uuidPath('id'), uuidPath('itemId')],
        responses: { 200: okResponse('Đã từ chối', ref('Order')) } },
    },
    '/api/orders/guest-requests/{requestId}/review': {
      post: {
        tags: ['ordering'], summary: 'Duyệt / từ chối cả lượt khách gửi', security: bearer,
        parameters: [uuidPath('requestId')],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
          required: ['approve'],
          properties: { approve: { type: 'boolean' }, reason: { type: 'string' } } } } } },
        responses: { 200: okResponse('Đã xử lý'), 409: errorResponse('Yêu cầu đã được xử lý') },
      },
    },
    '/api/orders/{id}/move': {
      post: { tags: ['ordering'], summary: 'Chuyển đơn sang bàn khác', security: bearer,
        parameters: [uuidPath('id')], responses: { 200: okResponse('Đã chuyển', ref('Order')) } },
    },
    '/api/orders/clear-table/{tableId}': {
      post: { tags: ['ordering'], summary: 'Dọn bàn (huỷ đơn, không lập hoá đơn)', security: bearer,
        parameters: [uuidPath('tableId')], responses: { 200: okResponse('Đã dọn bàn') } },
    },

    // ─── billing ────────────────────────────────────────────────────────────
    '/api/invoices': {
      get: { tags: ['billing'], summary: 'Lịch sử hoá đơn', security: bearer,
        responses: { 200: okResponse('Danh sách', { type: 'array', items: ref('Invoice') }) } },
      post: {
        tags: ['billing'], summary: 'Thanh toán & lập hoá đơn', security: bearer,
        description: 'Thay cho POST /api/orders/{id}/checkout của phiên bản 2 (vẫn còn hoạt động nhưng đã lỗi thời).',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
          required: ['order_id'],
          properties: {
            order_id: { type: 'string', format: 'uuid' },
            discount: { type: 'number' }, discount_note: { type: 'string' },
            vat_rate: { type: 'number', default: 8 },
            payment_method: { type: 'string', enum: ['cash', 'card', 'transfer', 'momo', 'vnpay', 'zalopay', 'banking', 'grab', 'online'] },
            paid_amount: { type: 'number' },
          } } } } },
        responses: {
          201: okResponse('Đã thanh toán', ref('Invoice')),
          409: errorResponse('Đơn đã thanh toán hoặc còn món chờ duyệt'),
        },
      },
    },

    // ─── guest-access (công khai) ───────────────────────────────────────────
    '/api/public/table/{qrKey}': {
      get: { tags: ['guest-access'], summary: 'Thông tin bàn từ mã QR', security: [],
        parameters: [{ name: 'qrKey', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: okResponse('Thông tin bàn') } },
    },
    '/api/public/session/{qrKey}': {
      post: {
        tags: ['guest-access'], summary: 'Khách quét QR: mở phiên gọi món', security: [],
        parameters: [{ name: 'qrKey', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
          display_name: { type: 'string', description: 'Không bắt buộc' },
          phone: { type: 'string', description: 'Không bắt buộc' },
        } } } } },
        responses: { 201: okResponse('Đã mở phiên', { type: 'object', properties: {
          token: { type: 'string', description: 'Lưu vào localStorage, gửi qua header X-Guest-Token' },
          session: ref('GuestSession'),
        } }) },
      },
    },
    '/api/public/menu': {
      get: { tags: ['guest-access'], summary: 'Thực đơn cho khách', security: guestAuth,
        responses: { 200: okResponse('Thực đơn') } },
    },
    '/api/public/orders': {
      post: {
        tags: ['guest-access'], summary: 'Khách gửi món', security: guestAuth,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: { type: 'object',
              required: ['menu_item_id', 'quantity'],
              properties: {
                menu_item_id: { type: 'string', format: 'uuid' },
                quantity: { type: 'integer', minimum: 1 },
                notes: { type: 'string' },
              } } },
            note: { type: 'string' },
          } } } } },
        responses: { 201: okResponse('Đã gửi yêu cầu', ref('GuestRequest')) },
      },
      get: {
        tags: ['guest-access'],
        summary: 'LỊCH SỬ ĐẶT MÓN CỦA KHÁCH ("Đơn của tôi")',
        description: 'Trả về toàn bộ các lần khách bấm "Gửi", kèm trạng thái xác nhận của từng món.',
        security: guestAuth,
        responses: { 200: okResponse('Lịch sử đơn', ref('GuestOrderHistory')) },
      },
    },
    '/api/guest-requests/pending': {
      get: { tags: ['guest-access'], summary: 'Hàng đợi yêu cầu khách chờ duyệt (nhân viên)', security: bearer,
        responses: { 200: okResponse('Danh sách', { type: 'array', items: ref('GuestRequest') }) } },
    },

    // ─── analytics & auditing ───────────────────────────────────────────────
    '/api/stats/overview': {
      get: { tags: ['analytics'], summary: 'Tổng quan doanh thu', security: bearer,
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { 200: okResponse('Số liệu tổng quan') } },
    },
    '/api/stats/daily': {
      get: { tags: ['analytics'], summary: 'Doanh thu theo ngày', security: bearer,
        parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 14, maximum: 90 } }],
        responses: { 200: okResponse('Chuỗi thời gian') } },
    },
    '/api/logs': {
      get: { tags: ['auditing'], summary: 'Nhật ký hoạt động (admin)', security: bearer,
        responses: { 200: okResponse('Danh sách nhật ký') } },
    },

    // ─── vận hành ───────────────────────────────────────────────────────────
    '/api/health': {
      get: { tags: ['platform'], summary: 'Kiểm tra sức khoẻ hệ thống', security: [],
        responses: { 200: okResponse('Bình thường'), 503: errorResponse('Suy giảm') } },
    },
    '/api/architecture': {
      get: { tags: ['platform'], summary: 'Bản đồ module & phụ thuộc (tự sinh)', security: [],
        responses: { 200: okResponse('Mô tả kiến trúc') } },
    },
  };
}

/** @param {{describe:Function}} registry Module Registry để sinh danh sách tag */
function build(registry) {
  const described = registry?.describe?.() || { modules: [] };
  const tags = [
    ...described.modules.map((m) => ({
      name: m.name,
      description: `${m.description} — sở hữu bảng: ${m.owns.join(', ') || 'không'}`,
    })),
    { name: 'platform', description: 'Endpoint vận hành: sức khoẻ, kiến trúc, tài liệu' },
  ];

  return {
    openapi: '3.0.3',
    info: {
      title: `${config.appName} API`,
      version: config.appVersion,
      description: [
        '## Kiến trúc Modular Monolith',
        '',
        'Hệ thống gồm các module nghiệp vụ độc lập, mỗi module sở hữu bảng CSDL riêng và',
        'chỉ giao tiếp với nhau qua **contract** (gọi hàm) hoặc **event bus** (sự kiện).',
        'Xem bản đồ phụ thuộc thực tế tại `GET /api/architecture`.',
        '',
        '## Hai loại xác thực',
        '',
        '| Loại | Header | Dành cho |',
        '|---|---|---|',
        '| `bearerAuth` | `Authorization: Bearer <access token>` | Nhân viên (admin / thu ngân / phục vụ) |',
        '| `guestToken` | `X-Guest-Token: <guest token>` | Khách quét mã QR tại bàn |',
        '',
        '## Định dạng phản hồi',
        '',
        '```json',
        '{ "success": true,  "data": …, "message": "", "meta": {…} }',
        '{ "success": false, "message": "…", "error": { "code": "…", "details": … } }',
        '```',
        '',
        'Mọi số tiền là **số nguyên đồng (VND)**.',
      ].join('\n'),
      contact: { name: 'RestoManager' },
    },
    servers: [
      { url: '/', description: 'Máy chủ hiện tại' },
      { url: 'http://localhost:8080', description: 'Phát triển cục bộ (qua Nginx)' },
    ],
    tags,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        guestToken: { type: 'apiKey', in: 'header', name: 'X-Guest-Token' },
      },
      schemas: SCHEMAS,
    },
    security: [{ bearerAuth: [] }],
    paths: buildPaths(),
  };
}

module.exports = { build };
