# Camera + PTZ + Hazard Detection API

Backend Flask cho camera IP/RTSP, điều khiển PTZ (ONVIF), chụp ảnh, lưu ảnh kèm file JSON metadata, và phân tích nguy cơ bằng YOLO.

Mục tiêu của API này là phục vụ cho website hoặc app mobile riêng của bạn, với JSON chuẩn hóa và ít phụ thuộc giao diện.

## 1. Tính năng chính

- Truy cập camera RTSP/live stream
- Điều khiển PTZ qua API
- Chụp ảnh và lưu tự động
- Lưu ảnh + file JSON đồng bộ cùng tên
- Phân tích nguy cơ bằng YOLO
- Hỗ trợ gọi từ frontend web/mobile bằng JSON

## 2. Cài đặt nhanh

### Yêu cầu

- Python 3.10+
- Flask
- OpenCV
- ultralytics
- onvif-zeep (nếu dùng PTZ ONVIF)

### Cài đặt

```bash
python -m venv .venv
.venv\Scripts\activate
pip install flask opencv-python ultralytics onvif-zeep
```

### Chạy server

```bash
python app.py
```

Mặc định server chạy ở:

- http://localhost:5000

## 3. Biến môi trường

Bạn có thể cấu hình trong shell hoặc file .env nếu framework của bạn hỗ trợ.

```bash
set RTSP_URL=rtsp://admin:admin@192.168.1.9:554/stream1
set ONVIF_IP=192.168.1.9
set ONVIF_PORT=8899
set ONVIF_USERNAME=admin
set ONVIF_PASSWORD=admin
set YOLO_MODEL=yolov8m.pt
```

Ghi chú:

- `YOLO_MODEL` có thể bỏ trống để app tự chọn model mạnh hơn trước: `yolov8m.pt`, `yolov8s.pt`, `yolov8n.pt`
- Với bộ Ultralytics mới, bạn có thể dùng weight tương thích với phiên bản package của bạn. Không nên hardcode model không có sẵn trong environment.
- Các danh mục nguy cơ như fire, smoke, flood, landslide, earthquake, vehicle, building damage được phân loại theo label mà YOLO trả về và mapping trong backend.

## 4. API endpoints

### 4.1 Kiểm tra trạng thái hệ thống

#### GET /api/camera/status

Trả về trạng thái camera, PTZ, model YOLO.

Response mẫu:

```json
{
  "status": "online",
  "online": true,
  "ptz_connected": false,
  "rtsp_url": "rtsp://admin:admin@192.168.1.9:554/stream1",
  "image_dir": "C:/.../images",
  "image_count": 12,
  "yolo_loaded": true
}
```

### 4.2 Live stream

#### GET /api/camera/stream

Trả về MJPEG stream.

```bash
curl http://localhost:5000/api/camera/stream
```

URL stream đang chạy trên môi trường public:

```text
https://ambassador-plan-foundations-theatre.trycloudflare.com/api/camera/stream
```

Dùng trong frontend web bằng tag `<img>`:

```html
<img src="https://ambassador-plan-foundations-theatre.trycloudflare.com/api/camera/stream" alt="Camera stream" />
```

Hoặc dùng JavaScript để nối stream vào video element:

```html
<img id="cameraStream" src="https://ambassador-plan-foundations-theatre.trycloudflare.com/api/camera/stream" alt="Camera stream" />
```

```javascript
const img = document.getElementById('cameraStream');
img.onload = () => console.log('Stream camera đã load');
img.onerror = () => console.warn('Không lấy được stream camera');
```

### 4.3 PTZ điều khiển

#### GET /api/ptz/move?x=0.2&y=-0.1

```bash
curl "http://localhost:5000/api/ptz/move?x=0.2&y=-0.1"
```

#### GET /api/ptz/stop

```bash
curl http://localhost:5000/api/ptz/stop
```

#### GET /api/ptz/up
#### GET /api/ptz/down
#### GET /api/ptz/left
#### GET /api/ptz/right

### 4.4 Chụp ảnh và phân tích nguy cơ

#### POST /api/capture

Payload mẫu:

```json
{
  "action": "capture",
  "ptz": { "x": 0.2, "y": -0.1 },
  "filename": "scene_001.jpg",
  "alert_id": "hazard-001",
  "reason": "warning_fire"
}
```

Hoặc gọi trực tiếp:

```bash
curl -X POST http://localhost:5000/api/capture \
  -H "Content-Type: application/json" \
  -d '{"action":"capture","ptz":{"x":0.2,"y":-0.1},"alert_id":"hazard-001","reason":"warning_fire"}'
```

Response mẫu:

```json
{
  "status": "ok",
  "message": "Chụp ảnh và lưu kết quả thành công",
  "data": {
    "filename": "capture_20250101_120530.jpg",
    "path": "C:/.../images/capture_20250101_120530.jpg",
    "json_path": "C:/.../images/capture_20250101_120530.json",
    "saved_at": "2025-01-01T12:05:30",
    "ptz": { "x": 0.2, "y": -0.1 },
    "alert_id": "hazard-001",
    "reason": "warning_fire",
    "detection": {
      "status": "ok",
      "risk_level": "warning",
      "hazard_count": 1,
      "detections": [
        {
          "label": "fire",
          "category": "fire",
          "confidence": 0.91
        }
      ]
    }
  }
}
```

#### Luồng cảnh báo -> chụp ảnh lại hiện trường

Khi hệ thống phát hiện cảnh báo, frontend có thể gọi ngay API chụp ảnh để lưu hiện trường và sau đó xem lại ảnh đã lưu ở thời điểm đó.

```javascript
async function captureSceneOnWarning(alertId, reason) {
  const res = await fetch('https://ambassador-plan-foundations-theatre.trycloudflare.com/api/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'capture',
      alert_id: alertId,
      reason,
      ptz: { x: 0.2, y: -0.1 }
    })
  });

  const json = await res.json();
  console.log('Captured scene:', json);
  return json;
}
```

Sau khi gọi, frontend nhận về trường `filename` và `saved_at`, dùng để hiển thị ảnh đã lưu đồng thời cảnh báo.

```javascript
async function loadSavedImage(filename) {
  const url = `https://ambassador-plan-foundations-theatre.trycloudflare.com/api/images/${filename}`;
  return url;
}
```

### 4.5 Endpoint chuẩn hóa cho app/backend ngoài

#### POST /api/command

Đây là endpoint chính để tích hợp từ server web hoặc app mobile riêng của bạn.

Payload mẫu:

```json
{
  "action": "capture",
  "ptz": { "x": 0.2, "y": -0.1 }
}
```

Các action hỗ trợ:

- `capture` / `shoot`
- `move` / `ptz_move`
- `stop` / `ptz_stop`
- `detect`

Ví dụ:

```bash
curl -X POST http://localhost:5000/api/command \
  -H "Content-Type: application/json" \
  -d '{"action":"capture","ptz":{"x":0.2,"y":-0.1}}'
```

### 4.6 Kiểm tra phát hiện ngay trên frame hiện tại

#### GET /api/detect

```bash
curl http://localhost:5000/api/detect
```

### 4.7 Danh sách ảnh đã lưu

#### GET /api/images

Trả về danh sách file ảnh trong thư mục `images`.

Ví dụ:

```bash
curl http://localhost:5000/api/images
```

Ví dụ response:

```json
{
  "status": "ok",
  "images": [
    {
      "filename": "capture_20250101_120530.jpg",
      "saved_at": "2025-01-01T12:05:30",
      "url": "/api/images/capture_20250101_120530.jpg"
    }
  ]
}
```

#### GET /api/images/<filename>

Lấy ảnh theo tên file.

```html
<img src="https://ambassador-plan-foundations-theatre.trycloudflare.com/api/images/capture_20250101_120530.jpg" alt="Ảnh cảnh báo" />
```

#### DELETE /api/images/<filename>

Xóa ảnh.

#### GET /api/images/<filename>/download

Tải ảnh xuống.

### 4.8 Xem lại ảnh tại thời điểm cảnh báo

Để xem lại hình ảnh đã lưu theo cảnh báo, nên lưu lại cả `filename` và `saved_at` ở phía frontend khi gọi capture. Sau đó gọi:

```javascript
const imageUrl = `https://ambassador-plan-foundations-theatre.trycloudflare.com/api/images/${filename}`;
const img = document.getElementById('savedImage');
img.src = imageUrl;
```

Nếu muốn danh sách lịch sử cảnh báo:

```javascript
async function loadImageHistory() {
  const res = await fetch('https://ambassador-plan-foundations-theatre.trycloudflare.com/api/images');
  const data = await res.json();
  console.log(data.images);
}
```

## 5. Định dạng lưu ảnh + JSON

Khi capture thành công, backend lưu:

- `images/capture_20250101_120530.jpg`
- `images/capture_20250101_120530.json`

File JSON mẫu:

```json
{
  "filename": "capture_20250101_120530.jpg",
  "image_path": "C:/.../images/capture_20250101_120530.jpg",
  "captured_at": "2025-01-01T12:05:30",
  "capture": {
    "action": "capture",
    "ptz": { "x": 0.2, "y": -0.1 }
  },
  "detection": {
    "status": "ok",
    "risk_level": "critical",
    "hazard_count": 2,
    "detections": [
      { "label": "fire", "category": "fire", "confidence": 0.91 },
      { "label": "smoke", "category": "smoke", "confidence": 0.87 }
    ]
  }
}
```

Bạn có thể đọc JSON này trên frontend để hiển thị lịch sử, cảnh báo, hoặc đưa lên dashboard web.

## 6. Ví dụ tích hợp frontend web

### JavaScript fetch

```javascript
async function captureHazard() {
  const res = await fetch('http://localhost:5000/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'capture',
      ptz: { x: 0.2, y: -0.1 }
    })
  });

  const data = await res.json();
  console.log(data);
}
```

### Tải stream camera

```html
<img src="http://localhost:5000/api/camera/stream" />
```

### Gửi lệnh PTZ

```javascript
await fetch('http://localhost:5000/api/command', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'move', x: 0.2, y: -0.1 })
});
```

## 7. Ghi chú về YOLO và phát hiện thiên tai

- Backend đang dùng model YOLO theo lệnh `YOLO_MODEL` hoặc bộ candidate mặc định.
- Nếu bạn muốn độ chính xác cao hơn cho cảnh báo thiên tai, hãy dùng model nặng hơn và weight tương thích với package Ultralytics của bạn.
- Mô hình YOLO phổ quát có thể nhận ra các đối tượng quan trọng như fire, smoke, flood, vehicle, person, debris, damaged building, tree fall.
- Với phân loại chính xác như landslide hoặc earthquake, cần dataset chuyên biệt hoặc fine-tune mô hình theo dữ liệu tự xây dựng.

## 8. Nếu muốn dùng cho web/mobile riêng

- Backend nên chạy trên máy chủ riêng hoặc VPS.
- Frontend web/mobile chỉ cần gọi các endpoint JSON.
- Nên đặt CORS hoặc reverse-proxy nếu chạy frontend và backend trên domain khác nhau.
- Nếu bạn muốn add auth, nên thêm token hoặc API key cho các endpoint nhạy cảm như caputure và PTZ.

## 9. Mẫu JSON chuẩn hóa cho client

```json
{
  "status": "ok",
  "message": "Chụp ảnh và lưu kết quả thành công",
  "data": {
    "filename": "capture_001.jpg",
    "path": "/images/capture_001.jpg",
    "json_path": "/images/capture_001.json",
    "saved_at": "2025-01-01T12:05:30",
    "ptz": { "x": 0.2, "y": -0.1 },
    "detection": {
      "status": "ok",
      "risk_level": "warning",
      "hazard_count": 1,
      "detections": []
    }
  }
}
```

Đây là format bạn có thể dễ dàng consume trong React, Vue, Next.js, mobile app, hoặc dashboard nội bộ.

## 10. Hỗ trợ tiếp theo

Nếu bạn muốn, tôi có thể tiếp tục làm thêm một trong các phần sau:

1. Thêm CORS để web khác domain có thể gọi api
2. Thêm xác thực API key cho client web/mobile
3. Thêm endpoint lấy danh sách lịch sử phát hiện theo ngày
4. Chuyển backend sang chuẩn REST/JSON rõ ràng hơn cho production
5. Đưa ra list model YOLO phù hợp với gói ultralytics đang cài đặt trên máy bạn
