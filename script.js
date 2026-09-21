// ================== CẤU HÌNH ==================
// Ẩn trang loading khi mọi thứ đã load xong (có delay nhẹ để tạo cảm giác mượt)
window.addEventListener("load", () => {
  setTimeout(() => {
    const loader = document.getElementById("pageLoader");
    if (loader) loader.classList.add("hidden");
  }, 600); // Đợi 600ms
});

// Cho phép đổi topic bằng query string: index.html?topic=terraguard/sensors/esp32
const params = new URLSearchParams(window.location.search);

const MQTT_HOST = "broker.hivemq.com";
const MQTT_WS_PORT = 8884;          // cổng WebSocket-SSL công khai của HiveMQ
const MQTT_TOPIC = params.get("topic") || "terraguard/sensors/esp32";
const MQTT_CONFIG_TOPIC = params.get("configTopic") || "terraguard/config/esp32/baseline_distance";
const MQTT_SOIL_THRESHOLD_TOPIC = params.get("soilThresholdTopic") || "terraguard/config/esp32/soil_threshold";
const MQTT_WATER_THRESHOLD_TOPIC = params.get("waterThresholdTopic") || "terraguard/config/esp32/water_threshold";
const MQTT_MOTION_WARNING_THRESHOLD_TOPIC = params.get("motionWarningThresholdTopic") || "terraguard/config/esp32/motion_warning_threshold";
const MQTT_MOTION_DANGER_THRESHOLD_TOPIC = params.get("motionDangerThresholdTopic") || "terraguard/config/esp32/motion_danger_threshold";
const CAMERA_API_BASE = "https://ambassador-plan-foundations-theatre.trycloudflare.com";
const CAMERA_STREAM_URL = `${CAMERA_API_BASE}/api/camera/stream`;
const THRESHOLD_CONFIG_TOPICS = [
  MQTT_SOIL_THRESHOLD_TOPIC,
  MQTT_WATER_THRESHOLD_TOPIC,
  MQTT_MOTION_WARNING_THRESHOLD_TOPIC,
  MQTT_MOTION_DANGER_THRESHOLD_TOPIC
];

// Ngưỡng phân loại độ rung (mặc định, có thể cập nhật từ UI và ESP32)
const DEFAULT_MOVEMENT_WARNING = 0.5;
const DEFAULT_MOVEMENT_DANGER = 2.0;

const MAX_LOG_ITEMS = 30;
const MAX_CHART_POINTS = 60;

// ================== DOM ==================
const connDot = document.getElementById("connDot");
const connText = document.getElementById("connText");

const stateBanner = document.getElementById("stateBanner");
const stateIcon = document.getElementById("stateIcon");
const stateLabel = document.getElementById("stateLabel");
const stateDesc = document.getElementById("stateDesc");
const movementValue = document.getElementById("movementValue");
const movementKpiEl = document.getElementById("movementKpi");

const axX = document.getElementById("axX");
const axY = document.getElementById("axY");
const axZ = document.getElementById("axZ");
const barX = document.getElementById("barX");
const barY = document.getElementById("barY");
const barZ = document.getElementById("barZ");
const magnitudeEl = document.getElementById("magnitude");

const baseX = document.getElementById("baseX");
const baseY = document.getElementById("baseY");
const baseZ = document.getElementById("baseZ");

const soilHumidityEl = document.getElementById("soilHumidity");
const soilHumidityKpiEl = document.getElementById("soilHumidityKpi");
const soilKpiNoteEl = document.getElementById("soilKpiNote");
const soilStatus = document.getElementById("soilStatus");
const soilDot = document.getElementById("soilDot");
const soilStatusText = document.getElementById("soilStatusText");

// Mực nước (siêu âm)
const waterDistanceEl = document.getElementById("waterDistance");
const waterDistanceKpiEl = document.getElementById("waterDistanceKpi");
const waterKpiNoteEl = document.getElementById("waterKpiNote");
const waterLevelChangeEl = document.getElementById("waterLevelChange");
const waterLevelLabel = document.getElementById("waterLevelLabel");
const baselineInput = document.getElementById("baselineInput");
const baselineSetBtn = document.getElementById("baselineSetBtn");
const baselineCurrentNote = document.getElementById("baselineCurrentNote");

// Ngưỡng phân loại độ ẩm đất — chỉnh lại cho phù hợp loại cây / loại đất của bạn
const SOIL_DRY_MAX = 30;   // dưới mức này: đất khô, cần tưới
const SOIL_WET_MIN = 80;   // trên mức này: đất quá ướt / ngập úng
const DEFAULT_SOIL_WARNING_THRESHOLD = 80;
const DEFAULT_WATER_WARNING_THRESHOLD = 10;

const soilThresholdInput = document.getElementById("soilThresholdInput");
const waterThresholdInput = document.getElementById("waterThresholdInput");
const soilThresholdCurrentValueEl = document.getElementById("soilThresholdCurrentValue");
const waterThresholdCurrentValueEl = document.getElementById("waterThresholdCurrentValue");
const soilThresholdConfirmBtn = document.getElementById("soilThresholdConfirmBtn");
const waterThresholdConfirmBtn = document.getElementById("waterThresholdConfirmBtn");
const soilThresholdCurrentEl = document.getElementById("soilThresholdCurrent");
const waterThresholdCurrentEl = document.getElementById("waterThresholdCurrent");
const motionWarningInput = document.getElementById("motionWarningInput");
const motionDangerInput = document.getElementById("motionDangerInput");
const motionThresholdConfirmBtn = document.getElementById("motionThresholdConfirmBtn");
const motionWarningThresholdDisplay = document.getElementById("motionWarningThresholdDisplay");
const motionDangerThresholdDisplay = document.getElementById("motionDangerThresholdDisplay");
const motionThresholdCurrentEl = document.getElementById("motionThresholdCurrent");

let currentSoilThreshold = DEFAULT_SOIL_WARNING_THRESHOLD;
let currentWaterThreshold = DEFAULT_WATER_WARNING_THRESHOLD;
let currentMotionWarningThreshold = DEFAULT_MOVEMENT_WARNING;
let currentMotionDangerThreshold = DEFAULT_MOVEMENT_DANGER;

const deviceIdEl = document.getElementById("deviceId");
const topicNameEl = document.getElementById("topicName");
const lastUpdateEl = document.getElementById("lastUpdate");
const warningFlagEl = document.getElementById("warningFlag");
const cameraStreamEl = document.getElementById("cameraStream");
const cameraStatusEl = document.getElementById("cameraStatus");
const cameraRefreshBtn = document.getElementById("cameraRefreshBtn");
const cameraCaptureBtn = document.getElementById("cameraCaptureBtn");
const latestCaptureImageEl = document.getElementById("latestCaptureImage");
const latestCaptureMetaEl = document.getElementById("latestCaptureMeta");
const cameraHistoryListEl = document.getElementById("cameraHistoryList");

const logList = document.getElementById("logList");
const canvas = document.getElementById("movementChart");
const ctx = canvas.getContext("2d");
const alertStack = document.getElementById("alertStack");
const gpsStatusEl = document.getElementById("gpsStatus");

const alertCooldowns = new Map();
let gpsMap = null;
let gpsMarker = null;
let gpsCircle = null;
let browserGpsWatchId = null;
let cameraHistoryPoller = null;

topicNameEl.textContent = MQTT_TOPIC;

function reloadCameraStream() {
  if (!cameraStreamEl) return;
  if (cameraStatusEl) {
    cameraStatusEl.textContent = "Đang tải stream camera...";
    cameraStatusEl.classList.remove("error");
  }

  const timestamp = `?t=${Date.now()}`;
  cameraStreamEl.src = `${CAMERA_STREAM_URL}${timestamp}`;
}

if (cameraStreamEl) {
  cameraStreamEl.onerror = () => {
    if (cameraStatusEl) {
      cameraStatusEl.textContent = "Không thể tải stream camera. Kiểm tra máy chủ camera hoặc URL.";
      cameraStatusEl.classList.add("error");
    }
  };

  cameraStreamEl.onload = () => {
    if (cameraStatusEl) {
      cameraStatusEl.textContent = "Đang hiển thị camera trực tiếp";
      cameraStatusEl.classList.remove("error");
    }
  };
}

function isImageFileName(filename) {
  if (!filename || typeof filename !== "string") return false;
  const lower = filename.toLowerCase();
  return [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".bmp",
    ".gif"
  ].some((ext) => lower.endsWith(ext));
}

function openCameraPreview(imageUrl, filename) {
  const overlay = document.getElementById("cameraPreviewOverlay");
  if (!overlay) return;

  const previewImg = document.getElementById("cameraPreviewImage");
  const previewName = document.getElementById("cameraPreviewName");

  if (previewImg) previewImg.src = imageUrl;
  if (previewName) previewName.textContent = filename;

  overlay.classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeCameraPreview() {
  const overlay = document.getElementById("cameraPreviewOverlay");
  if (!overlay) return;
  overlay.classList.remove("active");
  document.body.style.overflow = "";
}

// Nút thoát xem ảnh lớn
(function initCameraPreviewListeners() {
  const closeBtn = document.getElementById("cameraPreviewClose");
  if (closeBtn) {
    closeBtn.addEventListener("click", closeCameraPreview);
  }

  const overlay = document.getElementById("cameraPreviewOverlay");
  if (overlay) {
    // Click vào nền tối (backdrop) để thoát
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        closeCameraPreview();
      }
    });
  }

  // Nhấn Escape để thoát
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeCameraPreview();
    }
  });
})();

function buildCameraHistoryItem(filename, savedAt, imageUrl) {
  const item = document.createElement("div");
  item.className = "camera-history-item";

  const img = document.createElement("img");
  img.src = imageUrl;
  img.alt = filename;
  img.style.cursor = "pointer";
  img.addEventListener("click", () => openCameraPreview(imageUrl, filename));

  const meta = document.createElement("div");
  meta.className = "meta";

  const title = document.createElement("strong");
  title.textContent = filename;

  const time = document.createElement("span");
  time.textContent = savedAt || "Ảnh lưu";

  meta.appendChild(title);
  meta.appendChild(time);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "camera-delete-btn";
  deleteBtn.textContent = "Xóa";
  deleteBtn.title = `Xóa ${filename}`;
  deleteBtn.addEventListener("click", async () => {
    await deleteCameraImage(filename);
  });

  item.appendChild(img);
  item.appendChild(meta);
  item.appendChild(deleteBtn);
  return item;
}

async function deleteCameraImage(filename) {
  if (!filename) return;

  try {
    const res = await fetch(`${CAMERA_API_BASE}/api/images/${encodeURIComponent(filename)}`, {
      method: "DELETE",
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || "Không xóa được ảnh");
    }

    if (latestCaptureImageEl && latestCaptureImageEl.src.includes(encodeURIComponent(filename))) {
      latestCaptureImageEl.removeAttribute("src");
      latestCaptureImageEl.style.display = "none";
      latestCaptureMetaEl.textContent = "Chưa có hình ảnh nào được lưu.";
    }

    const items = [...cameraHistoryListEl.children];
    const target = items.find((node) => node.dataset.filename === filename);
    if (target) {
      target.remove();
    }

    showAlert({
      type: "info",
      title: "Đã xóa ảnh",
      message: `Ảnh ${filename} đã được xóa khỏi lưu trữ.`,
      key: `camera-delete-${filename}`
    });

    await loadCameraHistory();
  } catch (error) {
    console.error("[Camera] Delete failed:", error);
    showAlert({
      type: "warning",
      title: "Không xóa được ảnh",
      message: error.message || "Vui lòng thử lại.",
      key: "camera-delete-fail"
    });
  }
}

function startCameraHistoryPolling() {
  if (cameraHistoryPoller) clearInterval(cameraHistoryPoller);
  cameraHistoryPoller = setInterval(() => {
    loadCameraHistory();
  }, 3000);
}

const captureCooldowns = new Map();
async function captureCurrentScene(reason = "manual") {
  if (!CAMERA_API_BASE) return null;

  if (reason !== "manual") {
    const now = Date.now();
    const last = captureCooldowns.get(reason) || 0;
    if (now - last < 10000) { // 10 giây cooldown để không bị spam chụp ảnh
      return null;
    }
    captureCooldowns.set(reason, now);
  }

  try {
    const response = await fetch(`${CAMERA_API_BASE}/api/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "capture",
        reason,
        alert_id: reason === "manual" ? `manual-${Date.now()}` : `alert-${Date.now()}`,
        ptz: { x: 0.0, y: 0.0 }
      })
    });

    if (!response.ok) {
      throw new Error("Server trả về lỗi khi chụp ảnh");
    }

    const result = await response.json();
    if (!result || !result.data) {
      throw new Error("Không có dữ liệu ảnh trả về");
    }

    const { filename, saved_at } = result.data;
    const imageUrl = `${CAMERA_API_BASE}/api/images/${filename}`;
    latestCaptureImageEl.src = imageUrl;
    latestCaptureImageEl.style.display = "block";
    latestCaptureMetaEl.textContent = `${saved_at || "Ảnh đã lưu"} · ${reason}`;

    await loadCameraHistory();
    return result;
  } catch (error) {
    console.error("[Camera] Capture failed:", error);
    showAlert({
      type: "warning",
      title: "Chụp hiện trường thất bại",
      message: "Không thể lưu ảnh từ camera lúc này.",
      key: "camera-capture-fail"
    });
    return null;
  }
}

async function loadCameraHistory() {
  try {
    const response = await fetch(`${CAMERA_API_BASE}/api/images`, {
      method: "GET",
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const images = Array.isArray(data.images)
      ? data.images
      : Array.isArray(data.data?.images)
        ? data.data.images
        : Array.isArray(data)
          ? data
          : [];

    cameraHistoryListEl.innerHTML = "";

    const imageEntries = images
      .map((image) => {
        const itemData = typeof image === "string"
          ? { filename: image, saved_at: "Ảnh lưu", url: `${CAMERA_API_BASE}/api/images/${image}` }
          : image;

        const filename = itemData.filename || itemData.name || "image";
        if (!isImageFileName(filename)) return null;

        const imageUrl = itemData.url
          ? (String(itemData.url).startsWith("http") ? itemData.url : `${CAMERA_API_BASE}${itemData.url}`)
          : `${CAMERA_API_BASE}/api/images/${encodeURIComponent(filename)}`;

        return { filename, saved_at: itemData.saved_at || "Ảnh lưu", imageUrl };
      })
      .filter(Boolean)
      .sort((a, b) => {
        // Sắp xếp ảnh mới nhất lên trên
        const timeA = new Date(a.saved_at || 0).getTime();
        const timeB = new Date(b.saved_at || 0).getTime();
        // Nếu cả hai đều có thời gian hợp lệ, so sánh thời gian
        const validA = !isNaN(timeA) && timeA > 0;
        const validB = !isNaN(timeB) && timeB > 0;
        if (validA && validB) return timeB - timeA;
        if (validA && !validB) return -1;
        if (!validA && validB) return 1;
        // Nếu không có thời gian hợp lệ, sắp xếp theo tên file giảm dần (tên mới nhất lên trên)
        return b.filename.localeCompare(a.filename);
      });

    if (!imageEntries.length) {
      cameraHistoryListEl.innerHTML = '<div class="camera-history-item"><div class="meta"><strong>Chưa có ảnh nào</strong><span>Hình ảnh sẽ xuất hiện sau khi có cảnh báo hoặc chụp thủ công.</span></div></div>';
      return;
    }

    imageEntries.forEach((entry) => {
      const item = buildCameraHistoryItem(entry.filename, entry.saved_at, entry.imageUrl);
      item.dataset.filename = entry.filename;
      cameraHistoryListEl.appendChild(item);
    });
  } catch (error) {
    console.warn("[Camera] Không tải được lịch sử ảnh:", error);
    cameraHistoryListEl.innerHTML = '<div class="camera-history-item"><div class="meta"><strong>Không lấy được thư viện ảnh</strong><span>Vui lòng kiểm tra CORS hoặc backend camera.</span></div></div>';
  }
}

function stopBrowserGpsFallback() {
  if (browserGpsWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(browserGpsWatchId);
    browserGpsWatchId = null;
  }
}

function startBrowserGpsFallback() {
  if (!("geolocation" in navigator)) {
    gpsStatusEl.textContent = "Trình duyệt không hỗ trợ định vị vị trí.";
    return;
  }

  if (browserGpsWatchId !== null) return;

  const applyBrowserPosition = (position) => {
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    updateGpsMap(lat, lon);
    gpsStatusEl.textContent = `Định vị máy tính: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    gpsStatusEl.title = "Đang dùng vị trí hiện tại của máy tính để mô phỏng GPS";
  };

  navigator.geolocation.getCurrentPosition(
    applyBrowserPosition,
    (error) => {
      console.warn("Browser geolocation error:", error.message);
      gpsStatusEl.textContent = "Không lấy được vị trí máy tính. Cho phép quyền định vị và thử lại.";
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );

  browserGpsWatchId = navigator.geolocation.watchPosition(
    applyBrowserPosition,
    (error) => {
      console.warn("Browser geolocation watch error:", error.message);
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
  );
}

function initMap() {
  const mapEl = document.getElementById("map");
  if (!mapEl) {
    console.warn("Map container not found; skipping Leaflet init.");
    return;
  }

  gpsMap = L.map(mapEl, { zoomControl: true }).setView([10.762622, 106.660172], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(gpsMap);

  gpsMarker = L.marker([0, 0]).addTo(gpsMap);
  gpsMarker.bindPopup("Vị trí thiết bị");

  gpsCircle = L.circle([0, 0], {
    radius: 20,
    color: "#38bdf8",
    fillColor: "#38bdf8",
    fillOpacity: 0.2,
    weight: 2
  }).addTo(gpsMap);
}

function updateGpsMap(lat, lon) {
  if (!gpsMap) return;
  const position = [lat, lon];
  gpsMarker.setLatLng(position);
  gpsCircle.setLatLng(position);
  gpsMap.setView(position, Math.max(gpsMap.getZoom(), 15));
  gpsMarker.bindPopup(`Vị trí thiết bị<br>${lat.toFixed(5)}, ${lon.toFixed(5)}`);
  gpsStatusEl.textContent = `Tọa độ: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;

  maybeFetchWeather(lat, lon);
}

initMap();
startBrowserGpsFallback();
reloadCameraStream();
loadCameraHistory();
startCameraHistoryPolling();

// ================== TRẠNG THÁI ==================
let history = []; // { t: Date, movement: number, state: string }
let mqttClientRef = null;
let motionWarningState = false;
let soilWarningState = false;
let waterWarningState = false;
let lastSoilHumidity = null;
let lastWaterLevel = { valid: false, distanceCm: 0, levelChangeCm: 0, baselineDistanceCm: 0 };

function getSoilWarningThreshold() {
  return Number.isFinite(currentSoilThreshold) ? currentSoilThreshold : DEFAULT_SOIL_WARNING_THRESHOLD;
}

function getWaterWarningThreshold() {
  return Number.isFinite(currentWaterThreshold) ? currentWaterThreshold : DEFAULT_WATER_WARNING_THRESHOLD;
}

function getMotionWarningThreshold() {
  return Number.isFinite(currentMotionWarningThreshold) ? currentMotionWarningThreshold : DEFAULT_MOVEMENT_WARNING;
}

function getMotionDangerThreshold() {
  return Number.isFinite(currentMotionDangerThreshold) ? currentMotionDangerThreshold : DEFAULT_MOVEMENT_DANGER;
}

function getSoilDraftThreshold() {
  const value = Number.parseFloat(soilThresholdInput.value);
  if (!Number.isFinite(value)) return DEFAULT_SOIL_WARNING_THRESHOLD;
  return Math.min(100, Math.max(0, value));
}

function getWaterDraftThreshold() {
  const value = Number.parseFloat(waterThresholdInput.value);
  if (!Number.isFinite(value)) return DEFAULT_WATER_WARNING_THRESHOLD;
  return Math.max(0, value);
}

function getMotionDraftWarningThreshold() {
  const value = Number.parseFloat(motionWarningInput.value);
  if (!Number.isFinite(value)) return DEFAULT_MOVEMENT_WARNING;
  return Math.max(0, value);
}

function getMotionDraftDangerThreshold() {
  const value = Number.parseFloat(motionDangerInput.value);
  if (!Number.isFinite(value)) return DEFAULT_MOVEMENT_DANGER;
  return Math.max(0, value);
}

function updateWarningSummary() {
  warningFlagEl.textContent = motionWarningState || soilWarningState || waterWarningState ? "CÓ" : "Không";
}

function updateThresholdDisplays() {
  soilThresholdCurrentValueEl.value = `${currentSoilThreshold.toFixed(0)}%`;
  waterThresholdCurrentValueEl.value = `${currentWaterThreshold.toFixed(1)} cm`;
  soilThresholdCurrentEl.textContent = `Hiện tại trên ESP32: ${currentSoilThreshold.toFixed(0)}%`;
  waterThresholdCurrentEl.textContent = `Hiện tại trên ESP32: ${currentWaterThreshold.toFixed(1)} cm`;

  motionWarningThresholdDisplay.textContent = `${currentMotionWarningThreshold.toFixed(1)}`;
  motionDangerThresholdDisplay.textContent = `${currentMotionDangerThreshold.toFixed(1)}`;
  motionThresholdCurrentEl.textContent = `Hiện tại trên ESP32: cảnh báo ${currentMotionWarningThreshold.toFixed(2)} / nguy hiểm ${currentMotionDangerThreshold.toFixed(2)}`;
}

function publishThresholdValue(topic, value, label, unit) {
  if (!Number.isFinite(value)) {
    showAlert({ type: "warning", title: "Giá trị không hợp lệ", message: `${label} phải là số hợp lệ.`, key: `threshold-invalid-${label}` });
    return false;
  }

  if (!mqttClientRef || !mqttClientRef.connected) {
    showAlert({ type: "warning", title: "Chưa kết nối MQTT", message: `Không thể gửi ${label} vì thiết bị chưa kết nối.`, key: `threshold-offline-${label}` });
    return false;
  }

  mqttClientRef.publish(topic, value.toString(), { retain: true, qos: 0 }, (err) => {
    if (err) {
      showAlert({ type: "danger", title: "Gửi thất bại", message: `${label} chưa được cập nhật lên ESP32.`, key: `threshold-fail-${label}` });
      return;
    }

    showAlert({ type: "info", title: "Đã gửi ngưỡng", message: `${label}: ${value.toFixed(unit === "cm" ? 1 : 0)}${unit}`, key: `threshold-ok-${label}` });
  });

  return true;
}

function sendSoilThreshold() {
  const value = getSoilDraftThreshold();
  if (!publishThresholdValue(MQTT_SOIL_THRESHOLD_TOPIC, value, "Ngưỡng độ ẩm đất", "%")) return;
  currentSoilThreshold = value;
  soilThresholdCurrentEl.textContent = `Ngưỡng hiện tại: ${value.toFixed(0)}%`;
}

function sendWaterThreshold() {
  const value = getWaterDraftThreshold();
  if (!publishThresholdValue(MQTT_WATER_THRESHOLD_TOPIC, value, "Ngưỡng mực nước", " cm")) return;
  currentWaterThreshold = value;
  waterThresholdCurrentEl.textContent = `Ngưỡng hiện tại: ${value.toFixed(1)} cm`;
}

function sendMotionThresholds() {
  const warning = getMotionDraftWarningThreshold();
  const danger = getMotionDraftDangerThreshold();

  if (danger <= warning) {
    showAlert({ type: "warning", title: "Ngưỡng không hợp lệ", message: "Ngưỡng nguy hiểm phải lớn hơn ngưỡng cảnh báo.", key: "motion-threshold-invalid" });
    return false;
  }

  if (!mqttClientRef || !mqttClientRef.connected) {
    showAlert({ type: "warning", title: "Chưa kết nối MQTT", message: "Không thể gửi ngưỡng rung động vì thiết bị chưa kết nối.", key: "motion-threshold-offline" });
    return false;
  }

  mqttClientRef.publish(MQTT_MOTION_WARNING_THRESHOLD_TOPIC, warning.toString(), { retain: true, qos: 0 }, (err) => {
    if (err) {
      showAlert({ type: "danger", title: "Gửi thất bại", message: "Ngưỡng cảnh báo rung động chưa cập nhật.", key: "motion-warning-fail" });
      return;
    }
  });

  mqttClientRef.publish(MQTT_MOTION_DANGER_THRESHOLD_TOPIC, danger.toString(), { retain: true, qos: 0 }, (err) => {
    if (err) {
      showAlert({ type: "danger", title: "Gửi thất bại", message: "Ngưỡng nguy hiểm rung động chưa cập nhật.", key: "motion-danger-fail" });
      return;
    }

    currentMotionWarningThreshold = warning;
    currentMotionDangerThreshold = danger;
    showAlert({ type: "info", title: "Đã gửi ngưỡng rung động", message: `Cảnh báo ${warning.toFixed(2)} / nguy hiểm ${danger.toFixed(2)}`, key: "motion-threshold-ok" });
    motionThresholdCurrentEl.textContent = `Ngưỡng hiện tại: cảnh báo ${warning.toFixed(2)} / nguy hiểm ${danger.toFixed(2)}`;
    updateThresholdDisplays();
  });

  return true;
}

function triggerReloadEffect() {
  document.body.classList.remove("reloading");
  void document.body.offsetWidth;
  document.body.classList.add("reloading");
  clearTimeout(triggerReloadEffect.timer);
  triggerReloadEffect.timer = setTimeout(() => {
    document.body.classList.remove("reloading");
  }, 650);
}

// ================== KẾT NỐI MQTT ==================
function connectMQTT() {
  const url = `wss://${MQTT_HOST}:${MQTT_WS_PORT}/mqtt`;
  const clientId = "terraguard-web-" + Math.random().toString(16).slice(2, 10);

  setConnStatus("connecting", `Đang kết nối tới ${MQTT_HOST}...`);

  const client = mqtt.connect(url, {
    clientId,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 8000,
  });
  mqttClientRef = client;

  updateThresholdDisplays();

  client.on("connect", () => {
    console.log("[MQTT] Đã connect broker, clientId =", clientId);
    setConnStatus("connected", `Đang subscribe "${MQTT_TOPIC}"...`);

    client.subscribe(MQTT_TOPIC, { qos: 0 }, (err, granted) => {
      if (err) {
        console.error("[MQTT] Subscribe lỗi:", err);
        setConnStatus("error", "Lỗi khi subscribe topic");
      } else {
        console.log("[MQTT] Subscribe thành công:", granted);
      }
    });

    THRESHOLD_CONFIG_TOPICS.forEach((topic) => {
      client.subscribe(topic, { qos: 0 }, (err, granted) => {
        if (err) {
          console.error("[MQTT] Subscribe retained topic lỗi:", topic, err);
        } else {
          console.log("[MQTT] Subscribe retained threshold topic:", topic, granted);
        }
      });
    });

    setConnStatus("connected", `Đã kết nối · lắng nghe "${MQTT_TOPIC}"`);
  });

  client.on("reconnect", () => {
    setConnStatus("connecting", "Mất kết nối, đang thử lại...");
  });

  client.on("error", (err) => {
    console.error("MQTT error:", err);
    setConnStatus("error", "Lỗi kết nối MQTT");
  });

  client.on("close", () => {
    setConnStatus("error", "Kết nối MQTT đã đóng");
  });

  client.on("message", (topic, payload) => {
    const raw = payload.toString();
    console.log("[MQTT] Nhận message trên topic:", topic, "| raw:", raw);

    if (topic === MQTT_SOIL_THRESHOLD_TOPIC) {
      const value = Number(raw);
      if (Number.isFinite(value)) {
        currentSoilThreshold = value;
        if (document.activeElement !== soilThresholdInput) {
          soilThresholdInput.value = value.toFixed(0);
        }
        updateThresholdDisplays();
      }
      return;
    }

    if (topic === MQTT_WATER_THRESHOLD_TOPIC) {
      const value = Number(raw);
      if (Number.isFinite(value)) {
        currentWaterThreshold = value;
        if (document.activeElement !== waterThresholdInput) {
          waterThresholdInput.value = value.toFixed(1);
        }
        updateThresholdDisplays();
      }
      return;
    }

    if (topic === MQTT_MOTION_WARNING_THRESHOLD_TOPIC) {
      const value = Number(raw);
      if (Number.isFinite(value)) {
        currentMotionWarningThreshold = value;
        if (document.activeElement !== motionWarningInput) {
          motionWarningInput.value = value.toFixed(2);
        }
        updateThresholdDisplays();
      }
      return;
    }

    if (topic === MQTT_MOTION_DANGER_THRESHOLD_TOPIC) {
      const value = Number(raw);
      if (Number.isFinite(value)) {
        currentMotionDangerThreshold = value;
        if (document.activeElement !== motionDangerInput) {
          motionDangerInput.value = value.toFixed(2);
        }
        updateThresholdDisplays();
      }
      return;
    }

    try {
      const data = JSON.parse(raw);
      handleSensorData(data);
    } catch (e) {
      console.error("[MQTT] Không parse được payload JSON:", raw, e);
    }
  });
}

function setConnStatus(kind, text) {
  connDot.classList.remove("connected", "error");
  if (kind === "connected") connDot.classList.add("connected");
  if (kind === "error") connDot.classList.add("error");
  connText.textContent = text;
}

// ================== XỬ LÝ DỮ LIỆU ==================
function handleSensorData(data) {
  const a = data.adxl345 || {};
  const hasAxes = typeof a.x === "number";

  // Thiết bị & thời gian
  deviceIdEl.textContent = data.device || "--";
  lastUpdateEl.textContent = new Date().toLocaleTimeString("vi-VN");

  // Trục gia tốc
  if (hasAxes) {
    axX.textContent = a.x.toFixed(3);
    axY.textContent = a.y.toFixed(3);
    axZ.textContent = a.z.toFixed(3);
    magnitudeEl.textContent = (a.magnitude ?? Math.sqrt(a.x ** 2 + a.y ** 2 + a.z ** 2)).toFixed(3);

    // Thanh trực quan: quy đổi -2g..+2g -> 0..100%
    barX.style.width = axisToPercent(a.x) + "%";
    barY.style.width = axisToPercent(a.y) + "%";
    barZ.style.width = axisToPercent(a.z) + "%";

    if (a.baseline) {
      baseX.textContent = a.baseline.x.toFixed(3);
      baseY.textContent = a.baseline.y.toFixed(3);
      baseZ.textContent = a.baseline.z.toFixed(3);
    }
  }

  // Độ ẩm đất
  if (typeof data.soilHumidity === "number") {
    lastSoilHumidity = data.soilHumidity;
    soilHumidityEl.textContent = data.soilHumidity.toFixed(1) + " %";
    soilHumidityKpiEl.textContent = data.soilHumidity.toFixed(1) + " %";
    updateSoilStatus(data.soilHumidity);
  }

  if (Number.isFinite(data.soilThreshold)) {
    currentSoilThreshold = Number(data.soilThreshold);
  }

  if (Number.isFinite(data.motionWarningThreshold)) {
    currentMotionWarningThreshold = Number(data.motionWarningThreshold);
  }

  if (Number.isFinite(data.motionDangerThreshold)) {
    currentMotionDangerThreshold = Number(data.motionDangerThreshold);
  }

  // Mực nước (siêu âm AJ-SR04M)
  if (data.waterLevel) {
    lastWaterLevel = data.waterLevel;
    if (Number.isFinite(data.waterLevel.thresholdCm)) {
      currentWaterThreshold = Number(data.waterLevel.thresholdCm);
    }
    updateWaterLevel(data.waterLevel);
  }

  updateThresholdDisplays();

  if (data.gps && typeof data.gps.lat === "number" && typeof data.gps.lon === "number") {
    const gpsLat = Number(data.gps.lat);
    const gpsLon = Number(data.gps.lon);
    if (Number.isFinite(gpsLat) && Number.isFinite(gpsLon)) {
      stopBrowserGpsFallback();
      updateGpsMap(gpsLat, gpsLon);
      gpsStatusEl.textContent = `Tọa độ thiết bị: ${gpsLat.toFixed(5)}, ${gpsLon.toFixed(5)}`;
    }
  } else {
    startBrowserGpsFallback();
  }

  // Mức rung & trạng thái
  const movement = typeof data.movement === "number" ? data.movement : 0;
  const state = data.motionState || classifyMovement(movement);
  motionWarningState = data.warning ?? state !== "stable";

  if (state === "warning" || state === "danger") {
    captureCurrentScene(state === "danger" ? "motion-danger" : "motion-warning");
  }

  triggerReloadEffect();
  movementValue.textContent = movement.toFixed(2);
  movementKpiEl.textContent = movement.toFixed(2);
  updateWarningSummary();

  updateStateBanner(state, movement);
  pushHistory(movement, state);
  addLogLine(movement, state);
  drawChart();
}

function updateSoilStatus(humidity) {
  const threshold = getSoilWarningThreshold();
  soilStatus.classList.remove("dry", "good", "wet");
  if (humidity < SOIL_DRY_MAX) {
    soilStatus.classList.add("dry");
    soilStatusText.textContent = `Đất khô (${humidity.toFixed(1)}%) — nên tưới nước`;
    soilKpiNoteEl.textContent = "Khô - cần tưới";
    soilWarningState = false;
  } else if (humidity >= threshold) {
    soilStatus.classList.add("wet");
    soilStatusText.textContent = `CẢNH BÁO: độ ẩm vượt ngưỡng (${humidity.toFixed(1)}% > ${threshold.toFixed(0)}%)`;
    soilKpiNoteEl.textContent = "Cảnh báo vượt ngưỡng";
    soilWarningState = true;
    captureCurrentScene("soil-warning");
    showAlert({
      type: "danger",
      title: "Cảnh báo độ ẩm vượt ngưỡng",
      message: `Độ ẩm hiện tại ${humidity.toFixed(1)}% vượt ngưỡng ${threshold.toFixed(0)}%.`,
      key: "soil-warning"
    });
  } else if (humidity > SOIL_WET_MIN) {
    soilStatus.classList.add("wet");
    soilStatusText.textContent = `Đất quá ướt (${humidity.toFixed(1)}%) — có thể ngập úng`;
    soilKpiNoteEl.textContent = "Quá ướt";
    soilWarningState = false;
  } else {
    soilStatus.classList.add("good");
    soilStatusText.textContent = `Độ ẩm tốt (${humidity.toFixed(1)}%)`;
    soilKpiNoteEl.textContent = "Ổn định";
    soilWarningState = false;
  }
  updateWarningSummary();
}

function updateWaterLevel(wl) {
  const threshold = getWaterWarningThreshold();

  if (!wl.valid) {
    waterDistanceEl.textContent = "Lỗi đọc";
    waterLevelChangeEl.textContent = "--";
    waterLevelLabel.textContent = "Mực nước (cảm biến ngoài tầm/lỗi dây)";
    waterLevelChangeEl.style.color = "var(--text-dim)";
    waterWarningState = false;
    updateWarningSummary();
    return;
  }

  waterDistanceEl.textContent = wl.distanceCm.toFixed(1) + " cm";
  waterDistanceKpiEl.textContent = wl.distanceCm.toFixed(1) + " cm";

  const change = wl.levelChangeCm;
  const sign = change >= 0 ? "+" : "";
  const isWarning = change > 0 && change >= threshold;

  waterLevelChangeEl.textContent = `${sign}${change.toFixed(1)} cm`;
  waterLevelLabel.textContent = change >= 0 ? "Mực nước đã DÂNG" : "Mực nước đã HẠ";
  waterLevelChangeEl.style.color = isWarning ? "var(--danger)" : change >= 0 ? "var(--warning)" : "var(--accent)";
  if (isWarning) {
    waterLevelLabel.textContent = `Mực nước DÂNG quá ngưỡng (${change.toFixed(1)} cm > ${threshold.toFixed(1)} cm)`;
    waterKpiNoteEl.textContent = "Cảnh báo dâng nước";
    waterWarningState = true;
    captureCurrentScene("water-warning");
    showAlert({
      type: "danger",
      title: "Cảnh báo mực nước dâng",
      message: `Mực nước tăng ${change.toFixed(1)} cm, vượt ngưỡng ${threshold.toFixed(1)} cm.`,
      key: "water-warning"
    });
  } else {
    waterKpiNoteEl.textContent = change >= 0 ? "Đang dâng" : "Ổn định";
    waterWarningState = false;
  }

  // Chỉ cập nhật placeholder/ghi chú, không ghi đè ô input nếu người dùng đang gõ dở
  baselineCurrentNote.textContent = `Đang dùng trên thiết bị: ${wl.baselineDistanceCm.toFixed(1)} cm`;
  if (document.activeElement !== baselineInput && !baselineInput.value) {
    baselineInput.placeholder = wl.baselineDistanceCm.toFixed(1);
  }

  updateWarningSummary();
}

cameraRefreshBtn.addEventListener("click", () => {
  reloadCameraStream();
});

cameraCaptureBtn.addEventListener("click", () => {
  captureCurrentScene("manual");
});

soilThresholdInput.addEventListener("input", () => {
  updateThresholdDisplays();
  if (lastSoilHumidity !== null) {
    updateSoilStatus(lastSoilHumidity);
  }
});

soilThresholdConfirmBtn.addEventListener("click", () => {
  sendSoilThreshold();
});

waterThresholdInput.addEventListener("input", () => {
  updateThresholdDisplays();
  if (lastWaterLevel.valid) {
    updateWaterLevel(lastWaterLevel);
  }
});

waterThresholdConfirmBtn.addEventListener("click", () => {
  sendWaterThreshold();
});

motionWarningInput.addEventListener("input", () => {
  updateThresholdDisplays();
});

motionDangerInput.addEventListener("input", () => {
  updateThresholdDisplays();
});

motionThresholdConfirmBtn.addEventListener("click", () => {
  sendMotionThresholds();
});

baselineSetBtn.addEventListener("click", () => {
  const value = parseFloat(baselineInput.value);
  if (isNaN(value) || value <= 0) {
    alert("Vui lòng nhập một khoảng cách hợp lệ (cm), ví dụ: 50");
    return;
  }
  if (!mqttClientRef || !mqttClientRef.connected) {
    alert("Chưa kết nối MQTT, không thể gửi xuống ESP32 lúc này.");
    return;
  }

  // retain: true để nếu ESP32 đang mất kết nối / khởi động lại sau, vẫn nhận
  // được giá trị mới nhất ngay khi subscribe lại, không cần web phải mở sẵn.
  mqttClientRef.publish(MQTT_CONFIG_TOPIC, value.toString(), { retain: true, qos: 0 }, (err) => {
    if (err) {
      alert("Gửi thất bại: " + err.message);
    } else {
      baselineCurrentNote.textContent = `Đã gửi ${value} cm xuống ESP32 — chờ thiết bị xác nhận...`;
    }
  });
});

function classifyMovement(movement) {
  const warningThreshold = getMotionWarningThreshold();
  const dangerThreshold = Math.max(getMotionDangerThreshold(), warningThreshold + 0.1);

  if (movement < warningThreshold) return "stable";
  if (movement < dangerThreshold) return "warning";
  return "danger";
}

function axisToPercent(g) {
  // g trong khoảng [-2, 2] -> phần trăm chiều rộng thanh [0, 100]
  const clamped = Math.max(-2, Math.min(2, g));
  return ((clamped + 2) / 4) * 100;
}

const STATE_META = {
  stable: { icon: "✅", label: "Đất ổn định", desc: "Không phát hiện rung động bất thường." },
  warning: { icon: "⚠️", label: "Cảnh báo rung nhẹ", desc: "Phát hiện rung động — theo dõi thêm." },
  danger: { icon: "🚨", label: "NGUY HIỂM: rung mạnh", desc: "Rung động vượt ngưỡng an toàn! Kiểm tra ngay khu vực." },
};

function showAlert({ type = "danger", title, message, key }) {
  const now = Date.now();
  if (key && alertCooldowns.get(key) && now - alertCooldowns.get(key) < 6000) {
    return;
  }
  if (key) alertCooldowns.set(key, now);

  const toast = document.createElement("div");
  toast.className = `alert-toast ${type}`;
  toast.innerHTML = `
    <div class="alert-icon">${type === "warning" ? "⚠️" : type === "info" ? "ℹ️" : "🚨"}</div>
    <div class="alert-text">
      <p class="alert-title">${title}</p>
      <p class="alert-message">${message}</p>
    </div>
    <button class="alert-close" aria-label="Đóng cảnh báo">×</button>
  `;

  const closeBtn = toast.querySelector(".alert-close");
  closeBtn.addEventListener("click", () => {
    toast.remove();
  });

  alertStack.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 5000);
}

function updateStateBanner(state, movement) {
  const meta = STATE_META[state] || STATE_META.stable;
  stateBanner.classList.remove("stable", "warning", "danger");
  stateBanner.classList.add(state);
  stateBanner.dataset.state = state;
  document.body.classList.remove("danger-mode");
  if (state === "danger") {
    document.body.classList.add("danger-mode");
    showAlert({
      type: "danger",
      title: "Rung động mạnh",
      message: `Mức rung hiện tại ${movement.toFixed(2)} vượt ngưỡng nguy hiểm.`,
      key: "motion-danger"
    });
  } else if (state === "warning") {
    showAlert({
      type: "warning",
      title: "Cảnh báo rung nhẹ",
      message: `Mức rung đang ở ${movement.toFixed(2)}, cần theo dõi.`,
      key: "motion-warning"
    });
  }
  stateIcon.textContent = meta.icon;
  stateLabel.textContent = meta.label;
  stateDesc.textContent = meta.desc;
}

function pushHistory(movement, state) {
  history.push({ t: new Date(), movement, state });
  if (history.length > MAX_CHART_POINTS) history.shift();
}

function addLogLine(movement, state) {
  if (logList.querySelector(".log-empty")) logList.innerHTML = "";

  const line = document.createElement("div");
  line.className = `log-line ${state}`;
  const time = new Date().toLocaleTimeString("vi-VN");
  line.innerHTML = `<span class="tag">${state.toUpperCase()}</span><span>${time} — mức rung: ${movement.toFixed(2)}</span>`;
  logList.prepend(line);

  while (logList.children.length > MAX_LOG_ITEMS) {
    logList.removeChild(logList.lastChild);
  }
}

// ================== VẼ BIỂU ĐỒ (canvas thuần) ==================
const STATE_COLOR = { stable: "#34d399", warning: "#fbbf24", danger: "#f87171" };

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth;
  const cssHeight = canvas.height;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, cssWidth, cssHeight);

  if (history.length === 0) return;

  const maxVal = Math.max(getMotionDangerThreshold() * 1.2, ...history.map((h) => h.movement));
  const padding = 10;
  const w = cssWidth - padding * 2;
  const h = cssHeight - padding * 2;

  // Đường ngưỡng
  drawThresholdLine(getMotionWarningThreshold(), maxVal, padding, w, h, "#fbbf24");
  drawThresholdLine(getMotionDangerThreshold(), maxVal, padding, w, h, "#f87171");

  // Đường dữ liệu
  ctx.beginPath();
  history.forEach((point, i) => {
    const x = padding + (i / Math.max(1, MAX_CHART_POINTS - 1)) * w;
    const y = padding + h - (point.movement / maxVal) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#4fd1c5";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Chấm điểm theo màu trạng thái
  history.forEach((point, i) => {
    const x = padding + (i / Math.max(1, MAX_CHART_POINTS - 1)) * w;
    const y = padding + h - (point.movement / maxVal) * h;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = STATE_COLOR[point.state] || "#4fd1c5";
    ctx.fill();
  });
}

function drawThresholdLine(value, maxVal, padding, w, h, color) {
  const y = padding + h - (value / maxVal) * h;
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.moveTo(padding, y);
  ctx.lineTo(padding + w, y);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

window.addEventListener("resize", drawChart);

// ================== THỜI TIẾT (Open-Meteo, theo tọa độ GPS) ==================
// Open-Meteo: miễn phí, không cần API key, hỗ trợ CORS trực tiếp từ trình duyệt.
const WEATHER_REFRESH_MS = 15 * 60 * 1000; // 15 phút/lần, đủ dùng cho dự báo thời tiết
const WEATHER_MOVE_THRESHOLD_DEG = 0.01;   // ~1km, tránh gọi lại API khi vị trí gần như không đổi

const weatherStatusEl = document.getElementById("weatherStatus");
const weatherBodyEl = document.getElementById("weatherBody");

let lastWeatherFetchTime = 0;
let lastWeatherCoords = null;

// Bảng mã thời tiết WMO (rút gọn, đủ dùng cho hiển thị + phát hiện mưa)
const WMO_CODE_META = {
  0: { icon: "☀️", label: "Trời quang" },
  1: { icon: "🌤️", label: "Ít mây" },
  2: { icon: "⛅", label: "Mây rải rác" },
  3: { icon: "☁️", label: "Nhiều mây" },
  45: { icon: "🌫️", label: "Sương mù" },
  48: { icon: "🌫️", label: "Sương mù đóng băng" },
  51: { icon: "🌦️", label: "Mưa phùn nhẹ" },
  53: { icon: "🌦️", label: "Mưa phùn" },
  55: { icon: "🌦️", label: "Mưa phùn dày" },
  61: { icon: "🌧️", label: "Mưa nhỏ" },
  63: { icon: "🌧️", label: "Mưa vừa" },
  65: { icon: "🌧️", label: "Mưa to" },
  80: { icon: "🌧️", label: "Mưa rào nhẹ" },
  81: { icon: "🌧️", label: "Mưa rào" },
  82: { icon: "⛈️", label: "Mưa rào rất to" },
  95: { icon: "⛈️", label: "Dông" },
  96: { icon: "⛈️", label: "Dông kèm mưa đá" },
  99: { icon: "⛈️", label: "Dông mạnh kèm mưa đá" },
};

function weatherCodeMeta(code) {
  return WMO_CODE_META[code] || { icon: "🌡️", label: "Không rõ" };
}

// Chỉ gọi lại API nếu: chưa từng gọi, đã quá lâu, hoặc vị trí thay đổi đáng kể —
// tránh spam API khi GPS/định vị trình duyệt cập nhật liên tục mỗi vài giây.
function maybeFetchWeather(lat, lon) {
  const now = Date.now();
  const moved =
    !lastWeatherCoords ||
    Math.abs(lastWeatherCoords.lat - lat) > WEATHER_MOVE_THRESHOLD_DEG ||
    Math.abs(lastWeatherCoords.lon - lon) > WEATHER_MOVE_THRESHOLD_DEG;

  if (!moved && now - lastWeatherFetchTime < WEATHER_REFRESH_MS) return;

  lastWeatherFetchTime = now;
  lastWeatherCoords = { lat, lon };
  fetchWeather(lat, lon);
}

async function fetchWeather(lat, lon) {
  weatherStatusEl.textContent = "Đang tải dữ liệu thời tiết...";
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m` +
      `&hourly=precipitation_probability,precipitation` +
      `&forecast_days=1&timezone=auto`;

    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderWeather(data);
  } catch (err) {
    console.error("[Weather] Lỗi tải dữ liệu Open-Meteo:", err);
    weatherStatusEl.textContent = "Không tải được dữ liệu thời tiết (lỗi mạng hoặc API tạm gián đoạn).";
  }
}

function renderWeather(data) {
  const cur = data.current;
  if (!cur) {
    weatherStatusEl.textContent = "Dữ liệu thời tiết trả về không hợp lệ.";
    return;
  }

  const meta = weatherCodeMeta(cur.weather_code);

  // Tìm xác suất mưa cao nhất trong 6 giờ tới (rất liên quan tới cảnh báo lũ quét)
  let maxRainProb = null;
  let maxRainMm = 0;
  if (data.hourly && Array.isArray(data.hourly.precipitation_probability)) {
    const nowIdx = data.hourly.time
      ? data.hourly.time.findIndex((t) => new Date(t).getTime() >= Date.now())
      : 0;
    const start = Math.max(0, nowIdx);
    const probs = data.hourly.precipitation_probability.slice(start, start + 6);
    const rains = (data.hourly.precipitation || []).slice(start, start + 6);
    if (probs.length) maxRainProb = Math.max(...probs);
    if (rains.length) maxRainMm = Math.max(...rains);
  }

  weatherStatusEl.textContent = "";
  weatherBodyEl.innerHTML = `
    <div class="weather-now">
      <div class="weather-icon">${meta.icon}</div>
      <div>
        <div class="weather-temp">${cur.temperature_2m.toFixed(1)}°C</div>
        <div class="weather-desc">${meta.label}</div>
      </div>
    </div>
    <div class="weather-stats">
      <div class="weather-stat"><strong>${cur.relative_humidity_2m}%</strong><span>Độ ẩm không khí</span></div>
      <div class="weather-stat"><strong>${cur.wind_speed_10m.toFixed(1)} km/h</strong><span>Gió</span></div>
      <div class="weather-stat"><strong>${cur.precipitation.toFixed(1)} mm</strong><span>Mưa hiện tại</span></div>
      ${maxRainProb !== null ? `<div class="weather-stat"><strong>${maxRainProb}%</strong><span>Khả năng mưa (6h tới)</span></div>` : ""}
    </div>
    ${
      maxRainProb !== null && maxRainProb >= 60
        ? `<div class="weather-rain-alert">⚠️ Khả năng mưa lớn trong 6 giờ tới (${maxRainProb}%, tối đa ~${maxRainMm.toFixed(1)}mm/giờ) — theo dõi sát mực nước và độ ẩm đất.</div>`
        : ""
    }
  `;
}

// ================== CẢNH BÁO LŨ QUÉT / SẠT LỞ (NCHMF) ==================
// API nội bộ của luquetsatlo.nchmf.gov.vn (không chính thức công khai cho bên
// thứ ba) — thử gọi thẳng từ trình duyệt; nếu bị chặn CORS sẽ tự chuyển sang
// hiển thị thông báo + link mở trang gốc, không làm vỡ giao diện.
const FLOOD_API_URL = "https://luquetsatlo.nchmf.gov.vn/LayerMapBox/getDSCanhbaoSLLQ";
const FLOOD_REFRESH_MS = 10 * 60 * 1000; // NCHMF công bố cập nhật 1 giờ/lần, 10 phút là đủ
const SEVERITY_RANK = { "Rất cao": 3, "Cao": 2, "Trung bình": 1 };

const hazardStatusEl = document.getElementById("hazardStatus");
const hazardListEl = document.getElementById("hazardList");
const hazardSearchEl = document.getElementById("hazardSearch");
const hazardRefreshBtn = document.getElementById("hazardRefreshBtn");

let hazardRawItems = []; // đã dedup theo xã, giữ mức nguy cơ cao nhất

function getVnDateRoundedToHour() {
  // Giờ Việt Nam (GMT+7), làm tròn về đầu giờ — đúng định dạng API yêu cầu
  const nowVnStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
  const vnDate = new Date(nowVnStr);
  vnDate.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${vnDate.getFullYear()}-${pad(vnDate.getMonth() + 1)}-${pad(vnDate.getDate())} ${pad(vnDate.getHours())}:00:00`;
}

function severityOf(row) {
  const s1 = SEVERITY_RANK[row.nguycosatlo] || 0;
  const s2 = SEVERITY_RANK[row.nguycoluquet] || 0;
  return Math.max(s1, s2);
}

async function fetchFloodWarnings() {
  hazardStatusEl.textContent = "Đang tải dữ liệu cảnh báo từ NCHMF...";
  hazardStatusEl.classList.remove("error");

  try {
    const body = new URLSearchParams({ sogiodubao: "6", date: getVnDateRoundedToHour() });
    const res = await fetch(FLOOD_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) throw new Error("HTTP " + res.status);
    const rawList = await res.json();
    if (!Array.isArray(rawList)) throw new Error("Định dạng phản hồi không như mong đợi");

    // Dedup theo xã (commune_id_2cap), chỉ giữ bản ghi mức nguy cơ cao nhất
    const byCommune = new Map();
    rawList.forEach((row) => {
      const id = row.commune_id_2cap;
      if (!id) return;
      const sev = severityOf(row);
      if (sev === 0) return; // bỏ các xã không có cảnh báo
      const existing = byCommune.get(id);
      if (!existing || sev > existing._severity) {
        byCommune.set(id, { ...row, _severity: sev });
      }
    });

    hazardRawItems = Array.from(byCommune.values()).sort((a, b) => {
      if (b._severity !== a._severity) return b._severity - a._severity;
      return (a.provinceName_2cap || "").localeCompare(b.provinceName_2cap || "");
    });

    hazardStatusEl.textContent = hazardRawItems.length
      ? `Cập nhật lúc ${new Date().toLocaleTimeString("vi-VN")} · ${hazardRawItems.length} xã/phường đang có cảnh báo`
      : `Cập nhật lúc ${new Date().toLocaleTimeString("vi-VN")} · Hiện không có khu vực nào được cảnh báo`;

    renderHazardList();
  } catch (err) {
    console.error("[Hazard] Không gọi được API NCHMF trực tiếp:", err);
    hazardStatusEl.textContent =
      "Không thể tải trực tiếp từ trình duyệt (nhiều khả năng do máy chủ NCHMF chặn CORS cho truy cập từ web bên ngoài). Bấm \"Mở trang gốc\" để xem đầy đủ.";
    hazardStatusEl.classList.add("error");
    hazardListEl.innerHTML = "";
  }
}

function renderHazardList() {
  const keyword = hazardSearchEl.value.trim().toLowerCase();
  const filtered = keyword
    ? hazardRawItems.filter((row) =>
        `${row.provinceName_2cap || ""} ${row.commune_name_2cap || ""}`.toLowerCase().includes(keyword)
      )
    : hazardRawItems;

  if (filtered.length === 0) {
    hazardListEl.innerHTML = `<p class="hazard-empty">Không có khu vực nào khớp bộ lọc.</p>`;
    return;
  }

  const SEV_LABEL = { 3: "Rất cao", 2: "Cao", 1: "Trung bình" };

  hazardListEl.innerHTML = filtered
    .slice(0, 200) // giới hạn hiển thị để không quá tải DOM
    .map((row) => {
      const sev = row._severity;
      const commune = (row.commune_name_2cap || "").replace(/^P\.\s*/, "");
      return `
        <div class="hazard-item sev-${sev}">
          <span class="hazard-severity"></span>
          <div class="hazard-place">
            <div class="hazard-commune">${commune || "(không rõ xã/phường)"}</div>
            <div class="hazard-province">${row.provinceName_2cap || ""}</div>
          </div>
          <div class="hazard-tags">
            ${row.nguycosatlo ? `<span class="hazard-tag sev-${SEVERITY_RANK[row.nguycosatlo] || 0}">Sạt lở: ${row.nguycosatlo}</span>` : ""}
            ${row.nguycoluquet ? `<span class="hazard-tag sev-${SEVERITY_RANK[row.nguycoluquet] || 0}">Lũ quét: ${row.nguycoluquet}</span>` : ""}
          </div>
        </div>
      `;
    })
    .join("");
}

hazardSearchEl.addEventListener("input", renderHazardList);
hazardRefreshBtn.addEventListener("click", fetchFloodWarnings);

fetchFloodWarnings();
setInterval(fetchFloodWarnings, FLOOD_REFRESH_MS);

// ================== KHỞI CHẠY ==================
connectMQTT();