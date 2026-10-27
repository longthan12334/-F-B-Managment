import { demoOrderApi } from './demoOrderApi';
import { mockCustomerApi } from './mockCustomerApi';

// Menu công khai dùng cùng database với trang nhân viên.
// Phiên QR vẫn dùng mock cho tới khi có API phiên khách.
async function publicGet(path) {
  let response;
  try {
    response = await fetch('/api' + path, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
    });
  } catch {
    throw new Error('Không thể kết nối máy chủ để tải thực đơn.');
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error('Không tải được thực đơn. Kiểm tra backend và proxy /api.');
  }
  if (!response.ok || json.success === false) {
    throw new Error(json.message || 'Không tải được thực đơn.');
  }
  if (!Array.isArray(json.data)) {
    throw new Error('Dữ liệu thực đơn không đúng định dạng.');
  }
  return json;
}

async function loadMenuItems() {
  const items = [];
  let page = 1;
  while (true) {
    const result = await publicGet('/menu?active=true&limit=200&page=' + page);
    items.push(...result.data);
    const pages = Number(result.meta?.pages);
    if (Number.isFinite(pages) ? page >= pages : result.data.length < 200) break;
    page += 1;
  }
  return items;
}

export const CustomerApi = {
  ...mockCustomerApi,
  ...demoOrderApi,
  async getMenu() {
    const [items, categories] = await Promise.all([
      loadMenuItems(),
      publicGet('/menu/categories').then(result => result.data),
    ]);
    return { items, categories };
  },
};
