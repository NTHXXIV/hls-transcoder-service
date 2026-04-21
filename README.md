# HLS Transcoder Service (GitHub Actions)

Hệ thống băm video sang HLS (Adaptive Bitrate) sử dụng máy ảo GitHub Actions để xử lý FFmpeg miễn phí.

## 🚀 Tính năng chính

- Tự động băm video sang 480p, 720p, 1080p (tùy chỉnh).
- Hỗ trợ mã hóa RSA cho các Key R2 nhạy cảm (Không lộ key trong log).
- Tự động upload lên Cloudflare R2 sau khi băm xong.
- Callback kết quả về API của bạn qua Webhook.

## 🔐 Thiết lập Bảo mật (RSA Encryption)

Để bảo mật tuyệt đối, bạn nên mã hóa `access_key_id` và `secret_access_key` của R2 trước khi gửi payload.

1. **Tạo cặp khóa RSA:**

   ```bash
   # Tạo khóa riêng (Private Key)
   openssl genrsa -out private.pem 2048

   # Trích xuất khóa công khai (Public Key)
   openssl rsa -in private.pem -pubout -out public.pem
   ```

2. **Cấu hình GitHub Secrets:**
   - Vào Settings của Repo này -> Secrets and variables -> Actions.
   - Tạo một Secret mới tên là `TRANSCODER_PRIVATE_KEY`.
   - Copy toàn bộ nội dung file `private.pem` dán vào đó.

3. **Cấu hình tại phía gửi (Worker/App):**
   - Lưu nội dung file `public.pem` tại project gửi.
   - Trước khi gửi payload, dùng Public Key để mã hóa các chuỗi nhạy cảm.

## 📡 Cách Trigger từ bên ngoài

Callback webhook hỗ trợ 2 chế độ:

- Single secret: đặt `HLS_CALLBACK_SECRET`.
- Multi-client secret: đặt `HLS_CALLBACK_SECRET_<CALLBACK_CLIENT_ID>` theo dạng biến môi trường đã chuẩn hóa.

Ví dụ với `callback_client_id = "stagapps-sandbox"` thì secret cần set là `HLS_CALLBACK_SECRET_STAGAPPS_SANDBOX`.
Trong GitHub repo transcoder, có thể tạo sẵn các secret như `HLS_CALLBACK_SECRET_STAGAPPS_SANDBOX` và `HLS_CALLBACK_SECRET_STAGAPPS_PROD` để dùng cho các payload tương ứng.

Gửi một POST request tới GitHub API:

```bash
curl -X POST \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Authorization: token YOUR_GITHUB_PAT" \
  https://api.github.com/repos/YOUR_USERNAME/media-processor-service/dispatches \
  -d '{
    "event_type": "build-hls",
    "client_payload": {
      "source_url": "https://domain.com/source.mp4",
      "lesson_id": "lesson-123",
      "callback_client_id": "stagapps-sandbox",
      "variants": "480p,720p",
      "callback_url": "https://api.yourdomain.com/hls-done",
      "target_r2_config": {
        "endpoint": "https://<id>.r2.cloudflarestorage.com",
        "access_key_id": "ENCRYPTED_OR_RAW_KEY",
        "secret_access_key": "ENCRYPTED_OR_RAW_KEY",
        "bucket": "my-bucket",
        "prefix": "lessons/123/hls/v1",
        "public_base_url": "https://cdn.example.com"
      }
    }
  }'
```

Callback thành công sẽ có schema chính:

- `lessonId`
- `status: "processing" | "ready" | "failed"`
- `hlsManifestUrl`
- `hlsVersion`
- `prefix`
- `files`
- `generatedAt`
- `sourceMp4Url`

Callback lỗi sẽ trả về `status: "failed"` và `error`.
