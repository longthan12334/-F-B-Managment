// =============================================================================
//  MODULE: catalog — Thực đơn
// -----------------------------------------------------------------------------
//  Phạm vi nghiệp vụ: danh mục món, món ăn, giá bán, ảnh món, trạng thái bán.
//  Là "nguồn chân lý về giá": mọi module khác muốn biết giá một món đều phải
//  hỏi catalog qua contract.priceBasket().
// =============================================================================
const contract = require('./contract');
const menuRoutes = require('./interface/menu-routes');
const fileRoutes = require('./interface/file-routes');
const repo = require('./infrastructure/menu-repository');
const storage = require('../../platform/storage');
const { config } = require('../../shared/config');
const EVENTS = require('../../platform/events/event-names');
const log = require('../../shared/logger').child('catalog');

module.exports = {
  name: 'catalog',
  description: 'Thực đơn: danh mục, món ăn, giá bán, ảnh món lưu trên MinIO/S3/R2.',

  dependsOn: ['identity'],
  owns: ['menu_categories', 'menu_items'],

  routers: [
    { path: '/api/menu',  router: menuRoutes },
    { path: '/api/files', router: fileRoutes },
  ],

  publishes: [EVENTS.MENU_ITEM_CREATED, EVENTS.MENU_ITEM_UPDATED, EVENTS.MENU_ITEM_DELETED],
  subscribes: [],

  contract,

  async register() {
    if (config.seed.enabled && (await repo.countItems()) === 0) {
      await repo.seedSampleItems();
      log.info('Đã nạp thực đơn mẫu (14 món)');
    }
  },

  async healthCheck() {
    return { ok: true, items: await repo.countItems(), storage: await storage.healthCheck() };
  },
};
