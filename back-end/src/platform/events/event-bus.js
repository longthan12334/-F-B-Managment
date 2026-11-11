// =============================================================================
//  PLATFORM — Event Bus nội tiến trình (In-Process Domain Events)
// -----------------------------------------------------------------------------
//  Đây là "xương sống" tách rời (decoupling) của Modular Monolith.
//
//  Vấn đề: module `ordering` khi tạo đơn cần (1) ghi nhật ký, (2) đẩy realtime,
//  (3) cập nhật thống kê. Nếu gọi trực tiếp → ordering phụ thuộc cứng vào
//  auditing/realtime/analytics, phá vỡ ranh giới module.
//
//  Cách làm: ordering chỉ `publish('ordering.order.created', payload)`. Các
//  module khác tự `subscribe` ở bước khởi động. Ordering không biết ai nghe.
//
//  Quy ước tên sự kiện:  <module>.<đối tượng>.<hành động ở thì quá khứ>
//      ordering.order.created      billing.invoice.issued
//      ordering.order.cancelled    guest.request.submitted
//
//  Lưu ý về giao dịch: handler chạy BẤT ĐỒNG BỘ sau khi transaction đã commit
//  (publish được gọi ở application layer sau commit). Handler lỗi KHÔNG làm
//  hỏng luồng chính — chỉ ghi log. Đây là đánh đổi có chủ đích: nhật ký hay
//  realtime hỏng không được phép làm hỏng việc tạo đơn.
//
//  Khi cần tách thành microservice: thay thân hàm publish bằng một message
//  broker (RabbitMQ/Kafka) — chữ ký hàm và nơi gọi giữ nguyên.
// =============================================================================
const log = require('../../shared/logger').child('events');

class EventBus {
  constructor() {
    /** @type {Map<string, Array<{module:string, handler:Function}>>} */
    this.handlers = new Map();
    this.history = []; // vòng đệm phục vụ chẩn đoán (/api/health/events)
    this.maxHistory = 100;
  }

  /**
   * Đăng ký lắng nghe một sự kiện.
   * @param {string}   eventName  Tên đầy đủ hoặc có ký tự đại diện: 'ordering.*'
   * @param {Function} handler    async (payload, meta) => void
   * @param {string}   subscriber Tên module đăng ký (để ghi log & chẩn đoán)
   */
  subscribe(eventName, handler, subscriber = 'unknown') {
    if (!this.handlers.has(eventName)) this.handlers.set(eventName, []);
    this.handlers.get(eventName).push({ module: subscriber, handler });
    return () => this.unsubscribe(eventName, handler);
  }

  unsubscribe(eventName, handler) {
    const list = this.handlers.get(eventName);
    if (!list) return;
    const idx = list.findIndex((h) => h.handler === handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  /**
   * Tìm handler khớp với một tên sự kiện. Ba dạng mẫu:
   *   'ordering.order.created'  — khớp chính xác
   *   'ordering.*'              — mọi sự kiện của module ordering
   *   '*'                       — MỌI sự kiện (module auditing dùng mẫu này)
   */
  _matching(eventName) {
    const matched = [...(this.handlers.get(eventName) || [])];
    for (const [pattern, list] of this.handlers) {
      if (pattern === eventName) continue; // đã lấy ở trên
      if (pattern === '*') { matched.push(...list); continue; }
      if (pattern.endsWith('.*') && eventName.startsWith(pattern.slice(0, -1))) matched.push(...list);
    }
    return matched;
  }

  /**
   * Phát sự kiện. Không chờ handler hoàn tất (fire-and-forget) để không làm
   * chậm phản hồi HTTP; lỗi handler được bắt và ghi log.
   */
  publish(eventName, payload = {}, meta = {}) {
    const envelope = {
      event: eventName,
      occurredAt: new Date().toISOString(),
      correlationId: meta.correlationId || null,
      actor: meta.actor || null,
    };

    this.history.push({ ...envelope, payloadKeys: Object.keys(payload) });
    if (this.history.length > this.maxHistory) this.history.shift();

    const subscribers = this._matching(eventName);
    if (subscribers.length === 0) {
      log.debug(`Sự kiện không có người nghe: ${eventName}`);
      return envelope;
    }

    for (const { module, handler } of subscribers) {
      Promise.resolve()
        .then(() => handler(payload, envelope))
        .catch((err) =>
          log.error(`Handler của [${module}] lỗi khi xử lý ${eventName}`, { message: err.message })
        );
    }
    return envelope;
  }

  /** Phát sự kiện và CHỜ tất cả handler xong — dùng cho test và tác vụ nền. */
  async publishAndWait(eventName, payload = {}, meta = {}) {
    const envelope = { event: eventName, occurredAt: new Date().toISOString(), ...meta };
    const subscribers = this._matching(eventName);
    const results = await Promise.allSettled(subscribers.map(({ handler }) => handler(payload, envelope)));
    results
      .filter((r) => r.status === 'rejected')
      .forEach((r) => log.error(`Handler lỗi khi xử lý ${eventName}`, { message: r.reason?.message }));
    return envelope;
  }

  /** Bản đồ "ai nghe sự kiện nào" — dùng để vẽ sơ đồ phụ thuộc giữa module. */
  describe() {
    const out = {};
    for (const [event, list] of this.handlers) out[event] = list.map((h) => h.module);
    return out;
  }

  recentEvents(limit = 20) {
    return this.history.slice(-limit).reverse();
  }
}

module.exports = new EventBus();
module.exports.EventBus = EventBus;
