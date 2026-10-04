from __future__ import annotations

import base64
import json
import os
import re
import threading
import time
from datetime import datetime

# Phải đặt TRƯỚC khi import cv2: ép RTSP chạy qua TCP (ổn định hơn UDP).
# Nếu camera chỉ chạy tốt qua UDP thì đặt biến môi trường RTSP_TRANSPORT=udp
os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtsp_transport;" + os.environ.get("RTSP_TRANSPORT", "tcp"),
)

import cv2
import numpy as np
from flask import Flask, Response, jsonify, request, send_from_directory

try:
    from onvif import ONVIFCamera
except Exception:
    ONVIFCamera = None

try:
    from ultralytics import YOLO
except Exception:
    YOLO = None

app = Flask(__name__)

# CORS tự xử lý, không cần cài flask_cors.
# Mặc định cho phép mọi origin. Muốn giới hạn, đặt biến môi trường, ví dụ:
#   CORS_ORIGINS="http://127.0.0.1:5500,http://localhost:5500"
CORS_ORIGINS = [
    o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()
]


@app.after_request
def add_cors_headers(resp):
    origin = request.headers.get("Origin")
    if not origin:
        return resp

    if "*" in CORS_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = "*"
    elif origin in CORS_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
    else:
        return resp

    # Trả lời preflight (OPTIONS) do trình duyệt gửi trước khi POST JSON
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = (
        request.headers.get("Access-Control-Request-Headers")
        or "Content-Type, Authorization"
    )
    resp.headers["Access-Control-Max-Age"] = "600"
    return resp

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
IMAGE_DIR = os.path.join(BASE_DIR, "images")
os.makedirs(IMAGE_DIR, exist_ok=True)

RTSP_URL = os.environ.get("RTSP_URL", "rtsp://admin:admin@192.168.1.2:554/stream1")
ONVIF_IP = os.environ.get("ONVIF_IP", "192.168.1.2")
ONVIF_PORT = int(os.environ.get("ONVIF_PORT", "8899"))
ONVIF_USERNAME = os.environ.get("ONVIF_USERNAME", "admin")
ONVIF_PASSWORD = os.environ.get("ONVIF_PASSWORD", "admin")

FRAME_RATE = 15              # FPS tối đa gửi ra trình duyệt
JPEG_QUALITY = 80
PTZ_SPEED = 0.5

RTSP_OPEN_TIMEOUT_MS = 5000  # timeout khi mở kết nối RTSP
RTSP_READ_TIMEOUT_MS = 5000  # timeout khi đọc frame
RECONNECT_DELAY = 2.0        # giây chờ trước khi thử kết nối lại
STALE_SECONDS = 5.0          # frame cũ hơn mức này coi như camera offline

IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".bmp", ".webp")


def _mask_url(url: str) -> str:
    """Ẩn mật khẩu trong URL RTSP trước khi hiển thị ra ngoài."""
    return re.sub(r"//([^:/@]+):([^@]*)@", r"//\1:***@", url)


# ------------------------------
# Camera reader (thread nền duy nhất đọc camera)
# ------------------------------
class CameraReader:
    """Một thread nền đọc RTSP liên tục và giữ frame mới nhất.

    Stream / capture / detect chỉ đọc frame từ đây, không ai đụng trực tiếp
    vào cv2.VideoCapture, nên không còn tranh chấp khóa hay đọc song song.
    """

    def __init__(self, url: str):
        self.url = url
        self._cap = None
        self._cond = threading.Condition()
        self._frame = None
        self._jpeg = None
        self._seq = 0
        self._frame_time = 0.0
        self._stop = threading.Event()
        self._thread = None
        self._start_lock = threading.Lock()
        self.last_error = "Chưa kết nối"

    # ---- vòng đời ----
    def start(self):
        with self._start_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run, daemon=True, name="camera-reader"
            )
            self._thread.start()

    def stop(self):
        self._stop.set()

    # ---- nội bộ ----
    def _open(self):
        cap = None
        try:
            try:
                # Cần OpenCV >= 4.5.2
                cap = cv2.VideoCapture(
                    self.url,
                    cv2.CAP_FFMPEG,
                    [
                        cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, RTSP_OPEN_TIMEOUT_MS,
                        cv2.CAP_PROP_READ_TIMEOUT_MSEC, RTSP_READ_TIMEOUT_MS,
                    ],
                )
            except Exception:
                cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)

            if cap is not None and cap.isOpened():
                try:
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                except Exception:
                    pass
                return cap
        except Exception as exc:
            self.last_error = f"Lỗi mở camera: {exc}"

        try:
            if cap is not None:
                cap.release()
        except Exception:
            pass
        return None

    def _release(self):
        try:
            if self._cap is not None:
                self._cap.release()
        except Exception:
            pass
        self._cap = None

    def _run(self):
        fails = 0
        while not self._stop.is_set():
            if self._cap is None:
                self._cap = self._open()
                if self._cap is None:
                    self.last_error = "Không kết nối được RTSP (sai URL, sai tài khoản hoặc camera offline)"
                    self._stop.wait(RECONNECT_DELAY)
                    continue
                print("[CAM] connected")
                self.last_error = ""
                fails = 0

            try:
                ok, frame = self._cap.read()
            except Exception as exc:
                ok, frame = False, None
                self.last_error = f"Lỗi đọc frame: {exc}"

            if not ok or frame is None:
                fails += 1
                if fails >= 5:
                    print("[CAM] lost connection, reconnecting...")
                    self.last_error = "Mất kết nối, đang thử kết nối lại"
                    self._release()
                    self._stop.wait(RECONNECT_DELAY)
                else:
                    time.sleep(0.1)
                continue

            fails = 0
            with self._cond:
                self._frame = frame
                self._jpeg = None  # xóa cache JPEG của frame cũ
                self._seq += 1
                self._frame_time = time.monotonic()
                self._cond.notify_all()

        self._release()

    def _is_fresh(self) -> bool:
        return (
            self._frame is not None
            and (time.monotonic() - self._frame_time) <= STALE_SECONDS
        )

    # ---- API cho phần còn lại của app ----
    @property
    def online(self) -> bool:
        with self._cond:
            return self._is_fresh()

    def get_frame(self, wait: float = 0.0):
        """Trả về bản copy frame mới nhất, hoặc None nếu camera offline."""
        with self._cond:
            if wait > 0 and not self._is_fresh():
                self._cond.wait_for(self._is_fresh, timeout=wait)
            if not self._is_fresh():
                return None
            return self._frame.copy()

    def wait_for_jpeg(self, last_seq: int, timeout: float = 2.0):
        """Chờ frame mới (seq khác last_seq) và trả về (seq, jpeg_bytes).

        jpeg_bytes là None nếu camera offline. JPEG được mã hóa một lần cho mỗi
        frame và dùng chung cho tất cả client đang xem.
        """
        with self._cond:
            self._cond.wait_for(lambda: self._seq != last_seq, timeout=timeout)
            if not self._is_fresh():
                return last_seq, None
            if self._jpeg is None:
                ok, encoded = cv2.imencode(
                    ".jpg", self._frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY]
                )
                if ok:
                    self._jpeg = encoded.tobytes()
            return self._seq, self._jpeg


camera = CameraReader(RTSP_URL)

_offline_jpeg_cache = None


def _offline_jpeg() -> bytes:
    """Khung hình 'Camera offline' (đã ẩn mật khẩu), tạo một lần rồi cache."""
    global _offline_jpeg_cache
    if _offline_jpeg_cache is not None:
        return _offline_jpeg_cache

    frame = np.full((480, 640, 3), 20, dtype=np.uint8)
    cv2.putText(frame, "Camera offline", (120, 230), cv2.FONT_HERSHEY_SIMPLEX,
                1.2, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(frame, _mask_url(RTSP_URL)[:70], (20, 290), cv2.FONT_HERSHEY_SIMPLEX,
                0.5, (200, 200, 200), 1, cv2.LINE_AA)
    cv2.putText(frame, "Dang thu ket noi lai...", (20, 330), cv2.FONT_HERSHEY_SIMPLEX,
                0.5, (200, 200, 200), 1, cv2.LINE_AA)
    _, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    _offline_jpeg_cache = encoded.tobytes()
    return _offline_jpeg_cache


def _multipart(jpeg: bytes) -> bytes:
    return (
        b"--frame\r\n"
        b"Content-Type: image/jpeg\r\n"
        b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
        + jpeg
        + b"\r\n"
    )


def generate_video_stream():
    last_seq = -1
    interval = 1.0 / FRAME_RATE
    while True:
        started = time.monotonic()
        seq, jpeg = camera.wait_for_jpeg(last_seq, timeout=2.0)

        if jpeg is None:
            yield _multipart(_offline_jpeg())
            time.sleep(0.5)
            continue

        last_seq = seq
        yield _multipart(jpeg)

        elapsed = time.monotonic() - started
        if elapsed < interval:
            time.sleep(interval - elapsed)


# ------------------------------
# PTZ ONVIF section
# ------------------------------
PTZ_OK = False
ptz_svc = None
ptz_token = None
_ptz_lock = threading.Lock()
_ptz_vx = 0.0
_ptz_vy = 0.0
_ptz_event = threading.Event()


def _onvif_connect():
    """Kết nối ONVIF, tự thử lại mỗi 10 giây cho tới khi thành công."""
    global PTZ_OK, ptz_svc, ptz_token
    if ONVIFCamera is None:
        print("[PTZ] onvif package not installed")
        return

    while not PTZ_OK:
        try:
            cam = ONVIFCamera(ONVIF_IP, ONVIF_PORT, ONVIF_USERNAME, ONVIF_PASSWORD)
            media = cam.create_media_service()
            svc = cam.create_ptz_service()
            token = media.GetProfiles()[0].token
            ptz_svc, ptz_token = svc, token
            PTZ_OK = True
            print("[PTZ] connected")
        except Exception as exc:
            PTZ_OK = False
            ptz_svc = None
            ptz_token = None
            print(f"[PTZ] unavailable: {exc} (retry in 10s)")
            time.sleep(10)


def _ptz_worker():
    sent = (0.0, 0.0)

    while True:
        _ptz_event.wait()
        _ptz_event.clear()

        if not PTZ_OK:
            continue

        with _ptz_lock:
            target = (_ptz_vx, _ptz_vy)

        if target == sent:
            continue

        try:
            if target == (0.0, 0.0):
                ptz_svc.Stop({"ProfileToken": ptz_token})
            else:
                req = ptz_svc.create_type("ContinuousMove")
                req.ProfileToken = ptz_token
                req.Velocity = {"PanTilt": {"x": target[0], "y": target[1]}}
                ptz_svc.ContinuousMove(req)
            sent = target
        except Exception as exc:
            print(f"[PTZ] command error: {exc}")


def ptz_set(vx: float, vy: float):
    global _ptz_vx, _ptz_vy
    with _ptz_lock:
        _ptz_vx, _ptz_vy = vx, vy
    _ptz_event.set()


def ptz_move(x=0.0, y=0.0):
    ptz_set(float(x), float(y))


def ptz_stop():
    ptz_set(0.0, 0.0)


# ------------------------------
# YOLO hazard detection
# ------------------------------
safety_model = None
_yolo_load_lock = threading.Lock()
_yolo_infer_lock = threading.Lock()

YOLO_MODEL_CANDIDATES = [
    os.environ.get("YOLO_MODEL"),
    "yolov8m.pt",
    "yolov8s.pt",
    "yolov8n.pt",
]
YOLO_MODEL_CANDIDATES = [m for m in YOLO_MODEL_CANDIDATES if m and m.strip()]

HAZARD_LABELS = {
    "fire": "fire",
    "smoke": "smoke",
    "flood": "flood",
    "water": "flood",
    "storm": "storm",
    "rain": "storm",
    "landslide": "landslide",
    "rock": "rockfall",
    "debris": "debris",
    "tree": "tree_fall",
    "earthquake": "earthquake",
    "building": "building_damage",
    "crack": "building_damage",
    "person": "person",
    "truck": "vehicle",
    "car": "vehicle",
    "bus": "vehicle",
    "motorbike": "vehicle",
    "bicycle": "vehicle",
}

HAZARD_KEYWORDS = [
    "fire", "smoke", "flood", "water", "storm", "rain",
    "earthquake", "rock", "debris", "landslide", "tree",
    "building", "crack", "truck", "car", "bus", "person",
]

CRITICAL_CATEGORIES = {
    "fire", "flood", "landslide", "earthquake", "storm", "rockfall", "debris",
}


def load_yolo_model():
    global safety_model
    if YOLO is None:
        return None
    if safety_model is not None:
        return safety_model

    with _yolo_load_lock:
        if safety_model is not None:
            return safety_model

        last_error = None
        for model_name in YOLO_MODEL_CANDIDATES:
            try:
                safety_model = YOLO(model_name)
                print(f"[YOLO] loaded model: {model_name}")
                return safety_model
            except Exception as exc:
                last_error = exc
                print(f"[YOLO] failed to load {model_name}: {exc}")

        print(f"[YOLO] all candidate models failed: {last_error}")
        return None


def _normalize_label(label):
    if label is None:
        return ""
    return str(label).strip().lower()


def detect_hazards(frame):
    model = load_yolo_model()
    if model is None:
        return {
            "status": "not_ready",
            "message": "YOLO model chưa được tải. Cài đặt ultralytics và cho phép tải weights lần đầu.",
            "detections": [],
            "hazard_count": 0,
            "risk_level": "unknown",
        }

    with _yolo_infer_lock:
        results = model(frame, conf=0.25, verbose=False)

    detections = []
    for result in results:
        names = getattr(result, "names", None) or model.names
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            continue
        for box in boxes:
            cls_id = int(box.cls[0])
            label = names.get(cls_id, str(cls_id)) if isinstance(names, dict) else names[cls_id]
            score = float(box.conf[0]) if hasattr(box, "conf") and len(box.conf) > 0 else 0.0
            key = _normalize_label(label)
            if key in HAZARD_LABELS or any(keyword in key for keyword in HAZARD_KEYWORDS):
                detections.append({
                    "label": label,
                    "category": HAZARD_LABELS.get(key, key),
                    "confidence": round(score, 3),
                })

    risk_level = "normal"
    if detections:
        risk_level = "warning"
        if any(d["category"] in CRITICAL_CATEGORIES for d in detections):
            risk_level = "critical"

    return {
        "status": "ok",
        "risk_level": risk_level,
        "hazard_count": len(detections),
        "detections": detections,
    }


# ------------------------------
# Helpers
# ------------------------------
def _safe_filename(name: str | None, prefix: str = "capture") -> str:
    if name and str(name).strip():
        cleaned = os.path.basename(str(name).strip())
        if cleaned:
            return cleaned
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{prefix}_{timestamp}.jpg"


def api_response(status, message, data=None, code=200):
    payload = {
        "status": status,
        "message": message,
        "data": data if data is not None else {},
    }
    return jsonify(payload), code


def _get_latest_frame(wait: float = 3.0):
    """Frame mới nhất từ thread nền (chờ tối đa `wait` giây nếu chưa có)."""
    return camera.get_frame(wait=wait)


def _save_capture_record(filename: str, capture_data: dict, detection_data: dict):
    json_path = os.path.join(IMAGE_DIR, os.path.splitext(filename)[0] + ".json")
    record = {
        "filename": filename,
        "image_path": os.path.join(IMAGE_DIR, filename),
        "captured_at": datetime.now().isoformat(timespec="seconds"),
        "capture": capture_data,
        "detection": detection_data,
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
    return json_path


def _load_detection_history(date_str: str | None = None):
    if not os.path.isdir(IMAGE_DIR):
        return []

    target_date = (date_str or datetime.now().strftime("%Y-%m-%d")).strip()
    records = []

    for entry in sorted(os.listdir(IMAGE_DIR)):
        if not entry.lower().endswith(".json"):
            continue
        path = os.path.join(IMAGE_DIR, entry)
        try:
            with open(path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except Exception:
            continue

        if not isinstance(payload, dict):
            continue

        filename = payload.get("filename") or os.path.splitext(entry)[0] + ".jpg"
        captured_at = payload.get("captured_at") or payload.get("saved_at") or ""
        try:
            dt = datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
        except Exception:
            dt = None

        if target_date:
            if dt is not None:
                if dt.date().isoformat() != target_date:
                    continue
            elif not captured_at.startswith(target_date):
                continue

        detection = payload.get("detection") or {}
        records.append({
            "filename": filename,
            "image_url": f"/api/images/{filename}",
            "json_path": path,
            "captured_at": captured_at,
            "risk_level": detection.get("risk_level", "unknown"),
            "hazard_count": detection.get("hazard_count", 0),
            "detections": detection.get("detections", []),
            "capture": payload.get("capture") or {},
        })

    return records


def _capture_frame_with_analysis(filename=None, user_ptz=None, command_name="capture"):
    if user_ptz:
        try:
            ptz_move(float(user_ptz.get("x", 0.0)), float(user_ptz.get("y", 0.0)))
        except Exception:
            pass

    frame = _get_latest_frame()
    if frame is None:
        return None, api_response("error", "Không lấy được frame từ camera", code=503)

    filename = _safe_filename(filename, prefix="capture")
    image_path = os.path.join(IMAGE_DIR, filename)
    ok = cv2.imwrite(image_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        return None, api_response("error", "Lưu ảnh thất bại", code=500)

    detection = detect_hazards(frame)
    json_path = _save_capture_record(
        filename, {"action": command_name, "ptz": user_ptz or {}}, detection
    )

    return {
        "filename": filename,
        "path": image_path,
        "json_path": json_path,
        "saved_at": datetime.now().isoformat(timespec="seconds"),
        "ptz": user_ptz or {},
        "detection": detection,
    }, None


def _decode_image_data(data):
    if data is None:
        raise ValueError("Thiếu dữ liệu ảnh")

    if isinstance(data, (bytes, bytearray)):
        return bytes(data)

    if isinstance(data, str):
        value = data.strip()
        if value.startswith("data:image"):
            _, _, base64_data = value.partition(",")
            return base64.b64decode(base64_data)
        try:
            return base64.b64decode(value, validate=True)
        except Exception:
            return value.encode("utf-8")

    return str(data).encode("utf-8")


# ------------------------------
# API routes
# ------------------------------
@app.route("/")
def home():
    return jsonify({
        "service": "camera_api",
        "status": "ok",
        "endpoints": {
            "live_stream": "/api/camera/stream",
            "camera_status": "/api/camera/status",
            "capture": "/api/capture",
            "image_list": "/api/images",
            "image_detail": "/api/images/<filename>",
            "ptz_move": "/api/ptz/move",
            "ptz_stop": "/api/ptz/stop",
            "detect": "/api/detect",
            "detection_history": "/api/detections?date=YYYY-MM-DD",
        }
    })


@app.route("/api/camera/status")
def camera_status():
    online = camera.online
    image_count = 0
    if os.path.isdir(IMAGE_DIR):
        image_count = sum(
            1 for f in os.listdir(IMAGE_DIR) if f.lower().endswith(IMAGE_EXTENSIONS)
        )
    return jsonify({
        "status": "online" if online else "offline",
        "online": online,
        "ptz_connected": PTZ_OK,
        "rtsp_url": _mask_url(RTSP_URL),
        "image_dir": IMAGE_DIR,
        "image_count": image_count,
        "yolo_loaded": safety_model is not None,
        "last_error": camera.last_error,
        "message": "Camera đang hoạt động" if online else "Camera RTSP đang offline hoặc URL không hợp lệ",
    })


@app.route("/api/camera/stream")
def camera_stream():
    resp = Response(
        generate_video_stream(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"  # tắt buffer nếu đứng sau nginx
    return resp


@app.route("/api/ptz/move")
def ptz_move_route():
    try:
        x = float(request.args.get("x", 0.0))
        y = float(request.args.get("y", 0.0))
    except Exception:
        return jsonify({"status": "error", "message": "x/y không hợp lệ"}), 400

    ptz_move(x, y)
    return jsonify({"status": "ok", "x": x, "y": y, "ptz_connected": PTZ_OK})


@app.route("/api/ptz/stop")
def ptz_stop_route():
    ptz_stop()
    return jsonify({"status": "ok", "ptz_connected": PTZ_OK})


@app.route("/api/ptz/up")
def ptz_up():
    ptz_move(0.0, PTZ_SPEED)
    return jsonify({"status": "ok", "direction": "up"})


@app.route("/api/ptz/down")
def ptz_down():
    ptz_move(0.0, -PTZ_SPEED)
    return jsonify({"status": "ok", "direction": "down"})


@app.route("/api/ptz/left")
def ptz_left():
    ptz_move(-PTZ_SPEED, 0.0)
    return jsonify({"status": "ok", "direction": "left"})


@app.route("/api/ptz/right")
def ptz_right():
    ptz_move(PTZ_SPEED, 0.0)
    return jsonify({"status": "ok", "direction": "right"})


@app.route("/api/command", methods=["GET", "POST"])
def external_command_handler():
    payload = request.get_json(silent=True) or {}
    action = request.args.get("action") or payload.get("action") or payload.get("command")
    if not action:
        return api_response("error", "Thiếu action trong payload", code=400)

    action = str(action).lower()
    ptz = payload.get("ptz") if isinstance(payload.get("ptz"), dict) else {}
    filename = payload.get("filename") or request.args.get("filename")

    if action in {"capture", "shoot"}:
        result, err = _capture_frame_with_analysis(
            filename=filename, user_ptz=ptz, command_name=action
        )
        if err is not None:
            return err
        return api_response("ok", "Chụp ảnh và lưu kết quả thành công", result, code=200)

    if action in {"move", "ptz_move"}:
        try:
            x = float(request.args.get("x", payload.get("x", 0.0)))
            y = float(request.args.get("y", payload.get("y", 0.0)))
        except Exception:
            return api_response("error", "x/y không hợp lệ", code=400)
        ptz_move(x, y)
        return api_response("ok", "Đã di chuyển PTZ", {"x": x, "y": y, "ptz_connected": PTZ_OK}, code=200)

    if action in {"stop", "ptz_stop"}:
        ptz_stop()
        return api_response("ok", "Đã dừng PTZ", {"ptz_connected": PTZ_OK}, code=200)

    if action == "detect":
        frame = _get_latest_frame()
        if frame is None:
            return api_response("error", "Không có frame camera", code=503)
        detection = detect_hazards(frame)
        return api_response("ok", "Phân tích nguy cơ hoàn tất", {"detection": detection}, code=200)

    return api_response("error", "Action không hỗ trợ", code=400)


@app.route("/api/capture", methods=["GET", "POST"])
def capture_image():
    payload = request.get_json(silent=True) or {}
    command = request.args.get("command") or payload.get("command") or payload.get("action")

    if command and str(command).lower() not in {"capture", "shoot"}:
        return api_response("error", "Lệnh không hợp lệ", code=400)

    result, err = _capture_frame_with_analysis(
        filename=request.args.get("filename") or payload.get("filename") or payload.get("name"),
        user_ptz=payload.get("ptz") if isinstance(payload.get("ptz"), dict) else {},
        command_name="capture",
    )
    if err is not None:
        return err
    return api_response("ok", "Chụp ảnh và lưu kết quả thành công", result, code=200)


@app.route("/api/images", methods=["GET", "POST"])
def manage_images():
    if request.method == "GET":
        files = []
        if os.path.isdir(IMAGE_DIR):
            files = sorted(os.listdir(IMAGE_DIR))
        return jsonify(files)

    payload = request.get_json(silent=True) or {}

    try:
        if request.files and "image" in request.files:
            uploaded = request.files["image"]
            filename = _safe_filename(request.form.get("filename") or uploaded.filename, prefix="upload")
            data = uploaded.read()
        else:
            filename = _safe_filename(payload.get("filename") or payload.get("name"), prefix="upload")
            data = _decode_image_data(payload.get("image") or payload.get("data"))
    except ValueError as exc:
        return jsonify({"status": "error", "message": str(exc)}), 400

    path = os.path.join(IMAGE_DIR, filename)
    with open(path, "wb") as f:
        f.write(data)

    return jsonify({
        "status": "ok",
        "filename": filename,
        "path": path,
        "saved_at": datetime.now().isoformat(timespec="seconds"),
    }), 201


@app.route("/api/images/<filename>", methods=["GET", "PUT", "DELETE"])
def image_detail(filename):
    safe_name = os.path.basename(filename)
    path = os.path.join(IMAGE_DIR, safe_name)

    if request.method == "GET":
        if not os.path.exists(path):
            return jsonify({"status": "error", "message": "Không tìm thấy ảnh"}), 404
        return send_from_directory(IMAGE_DIR, safe_name)

    if request.method == "DELETE":
        if not os.path.exists(path):
            return jsonify({"status": "error", "message": "Không tìm thấy ảnh"}), 404
        os.remove(path)
        return jsonify({"status": "ok", "deleted": safe_name})

    if request.method == "PUT":
        if not os.path.exists(path):
            return jsonify({"status": "error", "message": "Không tìm thấy ảnh"}), 404

        payload = request.get_json(silent=True) or {}
        new_name = payload.get("new_name")
        if new_name:
            new_path = os.path.join(IMAGE_DIR, _safe_filename(new_name, prefix="renamed"))
            os.rename(path, new_path)
            return jsonify({
                "status": "ok",
                "old_name": safe_name,
                "new_name": os.path.basename(new_path),
            })

        if "image" in payload or "data" in payload:
            try:
                data = _decode_image_data(payload.get("image") or payload.get("data"))
            except ValueError as exc:
                return jsonify({"status": "error", "message": str(exc)}), 400
            with open(path, "wb") as f:
                f.write(data)
            return jsonify({"status": "ok", "filename": safe_name})

        return jsonify({"status": "error", "message": "Không có dữ liệu để cập nhật"}), 400

    return jsonify({"status": "error", "message": "Method không hỗ trợ"}), 405


@app.route("/api/images/<filename>/download")
def download_image(filename):
    safe_name = os.path.basename(filename)
    filepath = os.path.join(IMAGE_DIR, safe_name)
    if not os.path.exists(filepath):
        return jsonify({"status": "error", "message": "Không tìm thấy ảnh"}), 404
    return send_from_directory(IMAGE_DIR, safe_name, as_attachment=True)


@app.route("/api/detect", methods=["GET", "POST"])
def detect_route():
    frame = _get_latest_frame()
    if frame is None:
        return api_response("error", "Không có frame camera", code=503)

    result = detect_hazards(frame)
    return api_response("ok", "Phân tích nguy cơ hoàn tất", {"detection": result}, code=200)


@app.route("/api/detections", methods=["GET"])
@app.route("/api/history/detections", methods=["GET"])
def detection_history_route():
    date_value = (
        request.args.get("date")
        or request.args.get("day")
        or datetime.now().strftime("%Y-%m-%d")
    )
    records = _load_detection_history(date_value)
    return api_response(
        "ok",
        "Lấy lịch sử phát hiện theo ngày thành công",
        {
            "date": date_value,
            "count": len(records),
            "records": records,
        },
        code=200,
    )


# ------------------------------
# Khởi động các thread nền
# ------------------------------
_workers_started = False
_workers_lock = threading.Lock()


def start_background_workers():
    global _workers_started
    with _workers_lock:
        if _workers_started:
            return
        _workers_started = True

    camera.start()
    threading.Thread(target=_onvif_connect, daemon=True, name="onvif-connect").start()
    threading.Thread(target=_ptz_worker, daemon=True, name="ptz-worker").start()
    # Tải YOLO ở nền để request đầu tiên không bị chậm
    threading.Thread(target=load_yolo_model, daemon=True, name="yolo-preload").start()


start_background_workers()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)