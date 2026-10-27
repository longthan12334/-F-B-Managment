import { mockMenu, mockCategories } from '../data/mockMenu';

const demoSessions = {
  'demo-table-01': {
    session_id: 'demo-session-01',
    table_code: 'T1-01',
  },
  'demo-table-02': {
    session_id: 'demo-session-02',
    table_code: 'T1-02',
  },
};

export const mockCustomerApi = {
  async resolveSession(qr) {
    const session = demoSessions[qr];

    if (!session) {
      throw new Error('Mã QR không hợp lệ. Vui lòng quét lại mã tại bàn.');
    }

    return { ...session };
  },

  async getMenu() {
    return {
      items: mockMenu,
      categories: mockCategories,
    };
  },
};