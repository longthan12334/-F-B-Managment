// =============================================================================
//  MODULE: auditing — Nhật ký hoạt động
// -----------------------------------------------------------------------------
//  MINH HOẠ RÕ NHẤT VỀ TÁCH RỜI BẰNG SỰ KIỆN:
//  Module này lắng nghe mẫu đại diện '*' (mọi sự kiện) và tự ghi nhật ký.
//  Không module nào biết nó tồn tại, không module nào gọi nó. Xoá thư mục này
//  đi thì hệ thống vẫn chạy bình thường, chỉ mất tính năng nhật ký.
//
//  So sánh với phiên bản trước: mỗi controller phải tự gọi
//  `LogModel.write({...}).catch(() => {})` — 23 lời gọi rải rác, dễ quên khi
//  thêm tính năng mới, và mỗi lần đổi định dạng nhật ký phải sửa cả 23 chỗ.
// =============================================================================
const service = require('./application/audit-service');
const logRoutes = require('./interface/log-routes');
const repo = require('./infrastructure/log-repository');
const log = require('../../shared/logger').child('auditing');

module.exports = {
  name: 'auditing',
  description: 'Nhật ký hoạt động toàn hệ thống, ghi tự động bằng cách lắng nghe mọi sự kiện trên event bus.',

  dependsOn: ['identity'],
  owns: ['activity_logs'],

  routers: [{ path: '/api/logs', router: logRoutes }],

  publishes: [],
  subscribes: ['*'],

  contract: {
    list: service.list,
    timelineFor: service.timelineFor,
  },

  async register({ eventBus }) {
    // Một dòng duy nhất thay cho 23 lời gọi ghi nhật ký rải rác khắp mã nguồn
    eventBus.subscribe('*', service.record, 'auditing');
    log.debug('Đang lắng nghe mọi sự kiện để ghi nhật ký');

    // Tác vụ nền: giữ nhật ký 180 ngày
    const timer = setInterval(() => {
      repo.purgeOlderThan(180)
        .then((n) => n && log.info(`Đã xoá ${n} dòng nhật ký cũ hơn 180 ngày`))
        .catch((e) => log.warn(`Dọn nhật ký lỗi: ${e.message}`));
    }, 24 * 60 * 60 * 1000);
    timer.unref();
  },

  async healthCheck() {
    return { ok: true, entries: await repo.count() };
  },
};
