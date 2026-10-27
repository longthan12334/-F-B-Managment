import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

export default function DemoQrPage() {
  const [origin, setOrigin] = useState('http://192.168.2.183:5173');

  const baseUrl = origin.trim().replace(/\/+$/, '');

  const tables = [
    { code: 'T1-01', qr: 'demo-table-01' },
    { code: 'T1-02', qr: 'demo-table-02' },
  ];

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold">
        QR gọi món — bản demo
      </h1>

      <label className="block">
        <span className="block mb-2">
          Địa chỉ frontend mà điện thoại truy cập được
        </span>

        <input
          className="w-full border rounded-lg p-3"
          value={origin}
          onChange={event => setOrigin(event.target.value)}
          placeholder="http://192.168.2.183:5173"
        />
      </label>

      <p className="text-sm text-gray-500">
        QR đang dùng IP máy tính 192.168.2.183. Điện thoại cần cùng mạng Wi-Fi với máy tính.
      </p>

      <div className="grid gap-6 sm:grid-cols-2">
        {tables.map(table => {
          const url =
            `${baseUrl}/customer?qr=${encodeURIComponent(table.qr)}`;

          return (
            <article
              key={table.code}
              className="border rounded-xl p-6 flex flex-col items-center gap-4"
            >
              <h2 className="font-bold text-xl">
                Bàn {table.code}
              </h2>

              <QRCodeSVG
                value={url}
                size={220}
                level="M"
                marginSize={4}
              />

              <p>Quét mã để xem thực đơn</p>

              <a
                href={url}
                className="text-sm text-primary break-all text-center"
              >
                {url}
              </a>
            </article>
          );
        })}
      </div>
    </div>
  );
}