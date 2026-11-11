// =============================================================================
//  PLATFORM — Adapter lưu trữ tương thích S3
// -----------------------------------------------------------------------------
//  Một adapter phục vụ cả ba nhà cung cấp, chỉ khác tham số kết nối:
//
//    STORAGE_DRIVER=minio   → MinIO tự host trong Docker Compose (mặc định)
//        S3_ENDPOINT=minio  S3_PORT=9000  S3_USE_SSL=false
//
//    STORAGE_DRIVER=s3      → Amazon S3
//        S3_ENDPOINT=s3.ap-southeast-1.amazonaws.com  S3_PORT=443
//        S3_USE_SSL=true    S3_REGION=ap-southeast-1  S3_FORCE_PATH_STYLE=false
//
//    STORAGE_DRIVER=r2      → Cloudflare R2
//        S3_ENDPOINT=<account_id>.r2.cloudflarestorage.com  S3_PORT=443
//        S3_USE_SSL=true    S3_REGION=auto   S3_SIGNED_URLS=true
//        S3_PUBLIC_URL=https://cdn.<domain>   (R2 custom domain qua Cloudflare)
//
//  Hai chế độ phát URL ảnh:
//    • Bucket public-read (MinIO/dev)  → URL tĩnh, cache tốt, không hết hạn.
//    • Bucket riêng tư (R2/S3 prod)    → URL ký (presigned) có thời hạn; bật
//      bằng S3_SIGNED_URLS=true. Khi R2 gắn custom domain qua Cloudflare thì
//      vẫn nên dùng URL tĩnh (S3_PUBLIC_URL) để tận dụng CDN.
// =============================================================================
const Minio = require('minio');
const crypto = require('crypto');
const path = require('path');
const { StoragePort } = require('./storage-port');
const { config } = require('../../shared/config');
const { AppError } = require('../../shared/errors');
const log = require('../../shared/logger').child('storage');

/** Ký tự an toàn cho khoá đối tượng — chặn path traversal và ký tự lạ. */
function safeExtension(originalName = '') {
  const ext = path.extname(String(originalName)).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

class S3CompatibleAdapter extends StoragePort {
  constructor(settings = config.storage) {
    super();
    this.settings = settings;
    this.bucket = settings.bucket;
    this.client = new Minio.Client({
      endPoint: settings.endpoint,
      port: settings.port,
      useSSL: settings.useSSL,
      accessKey: settings.accessKey,
      secretKey: settings.secretKey,
      region: settings.region,
      pathStyle: settings.forcePathStyle,
    });
  }

  get driverName() {
    return this.settings.driver;
  }

  /**
   * Khởi tạo bucket + chính sách truy cập.
   *
   * Thử nhanh vài lần (chặn khởi động), nếu kho chưa sẵn sàng thì CHUYỂN SANG
   * THỬ LẠI NỀN và cho server lên luôn. Lý do: POS phải nhận đơn được ngay cả
   * khi kho ảnh đang bảo trì — mất ảnh món là phiền, nhưng không bán được hàng
   * mới là hỏng. `/api/health` vẫn báo `degraded` để đội vận hành biết.
   */
  async init({ quickAttempts = 3, quickDelayMs = 1000, backgroundDelayMs = 15000 } = {}) {
    const connected = await this._tryInit(quickAttempts, quickDelayMs);
    if (connected) return;

    log.warn('Kho đối tượng chưa sẵn sàng — server vẫn khởi động, sẽ thử lại ở chế độ nền.');
    const retry = setInterval(async () => {
      if (await this._tryInit(1, 0)) {
        clearInterval(retry);
        log.info('Kho đối tượng đã kết nối lại.');
      }
    }, backgroundDelayMs);
    retry.unref();
  }

  async _tryInit(maxRetries, delayMs) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const exists = await this.client.bucketExists(this.bucket).catch(() => false);
        if (!exists) {
          await this.client.makeBucket(this.bucket, this.settings.region);
          log.info(`Đã tạo bucket '${this.bucket}' trên ${this.driverName}`);
        } else {
          log.info(`Bucket '${this.bucket}' đã sẵn sàng (${this.driverName})`);
        }

        // Chỉ đặt policy public-read khi KHÔNG dùng URL ký.
        // R2/S3 production nên giữ bucket riêng tư → bỏ qua bước này.
        if (!this.settings.signedUrls) {
          const policy = {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { AWS: ['*'] },
                Action: ['s3:GetObject'],
                Resource: [`arn:aws:s3:::${this.bucket}/*`],
              },
            ],
          };
          await this.client
            .setBucketPolicy(this.bucket, JSON.stringify(policy))
            .catch((e) => log.warn(`Không đặt được bucket policy: ${e.message}`));
        }
        this.ready = true;
        return true;
      } catch (err) {
        if (maxRetries > 1) {
          log.warn(`Kho đối tượng chưa sẵn sàng (${attempt}/${maxRetries}): ${err.message}`);
        }
        if (attempt < maxRetries && delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    this.ready = false;
    return false;
  }

  /**
   * @param {Buffer} buffer
   * @param {{originalName?:string, contentType?:string, prefix?:string, metadata?:object}} opts
   */
  async upload(buffer, { originalName = '', contentType = 'application/octet-stream', prefix = 'misc', metadata = {} } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw AppError.validation('Tệp tải lên rỗng hoặc không hợp lệ');
    }
    if (buffer.length > this.settings.maxUploadBytes) {
      throw new AppError(`Tệp vượt quá ${Math.round(this.settings.maxUploadBytes / 1024 / 1024)}MB`, {
        status: 413, code: 'FILE_TOO_LARGE',
      });
    }

    const safePrefix = String(prefix).replace(/[^a-z0-9/_-]/gi, '').replace(/^\/+|\/+$/g, '') || 'misc';
    const key = `${safePrefix}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExtension(originalName)}`;

    await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...metadata,
    });

    return { key, url: await this.urlFor(key), size: buffer.length, contentType };
  }

  async remove(key) {
    if (!key) return;
    try {
      await this.client.removeObject(this.bucket, key);
    } catch (err) {
      log.warn(`Không xoá được đối tượng ${key}: ${err.message}`);
    }
  }

  async urlFor(key) {
    if (!key) return null;
    if (this.settings.signedUrls) {
      return this.client.presignedGetObject(this.bucket, key, this.settings.signedUrlTtlSec);
    }
    return `${this.settings.publicUrl}/${this.bucket}/${key}`;
  }

  async healthCheck() {
    const started = Date.now();
    try {
      await this.client.bucketExists(this.bucket);
      return { ok: true, driver: this.driverName, bucket: this.bucket, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, driver: this.driverName, bucket: this.bucket, error: err.message };
    }
  }
}

module.exports = { S3CompatibleAdapter };
