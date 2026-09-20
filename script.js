// ================== CẤU HÌNH ==================
// Cho phép đổi topic bằng query string: index.html?topic=terraguard/sensors/esp32
const params = new URLSearchParams(window.location.search);

const MQTT_HOST = "broker.hivemq.com";
const MQTT_WS_PORT = 8884;          // cổng WebSocket-SSL công khai của HiveMQ
const MQTT_TOPIC = params.get("topic") || "terraguard/sensors/esp32";
const MQTT_CONFIG_TOPIC = params.get("configTopic") || "terraguard/config/esp32/baseline_distance";

// Ngưỡng phân loại độ rung (phải khớp với mã ESP32)
const MOVEMENT_WARNING = 0.5;
const MOVEMENT_DANGER = 2.0;

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

const deviceIdEl = document.getElementById("deviceId");
const topicNameEl = document.getElementById("topicName");
const lastUpdateEl = document.getElementById("lastUpdate");
const warningFlagEl = document.getElementById("warningFlag");

const logList = document.getElementById("logList");
const canvas = document.getElementById("movementChart");
const ctx = canvas.getContext("2d");
const alertStack = document.getElementById("alertStack");
const gpsStatusEl = document.getElementById("gpsStatus");

const alertCooldowns = new Map();
let gpsMap = null;
let gpsMarker = null;
let gpsCircle = null;

topicNameEl.textContent = MQTT_TOPIC;

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
}

initMap();

// ================== TRẠNG THÁI ==================
let history = []; // { t: Date, movement: number, state: string }
let mqttClientRef = null;
let motionWarningState = false;
let soilWarningState = false;
let waterWarningState = false;
let lastSoilHumidity = null;
let lastWaterLevel = { valid: false, distanceCm: 0, levelChangeCm: 0, baselineDistanceCm: 0 };

function getSoilWarningThreshold() {
  const value = Number.parseFloat(soilThresholdInput.value);
  if (!Number.isFinite(value)) return DEFAULT_SOIL_WARNING_THRESHOLD;
  return Math.min(100, Math.max(0, value));
}

function getWaterWarningThreshold() {
  const value = Number.parseFloat(waterThresholdInput.value);
  if (!Number.isFinite(value)) return DEFAULT_WATER_WARNING_THRESHOLD;
  return Math.max(0, value);
}

function updateWarningSummary() {
  warningFlagEl.textContent = motionWarningState || soilWarningState || waterWarningState ? "CÓ" : "Không";
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

  client.on("connect", () => {
    console.log("[MQTT] Đã connect broker, clientId =", clientId);
    setConnStatus("connected", `Đang subscribe "${MQTT_TOPIC}"...`);
    client.subscribe(MQTT_TOPIC, { qos: 0 }, (err, granted) => {
      if (err) {
        console.error("[MQTT] Subscribe lỗi:", err);
        setConnStatus("error", "Lỗi khi subscribe topic");
      } else {
        console.log("[MQTT] Subscribe thành công:", granted);
        setConnStatus("connected", `Đã kết nối · lắng nghe "${MQTT_TOPIC}"`);
      }
    });
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
    console.log("[MQTT] Nhận message trên topic:", topic, "| raw:", payload.toString());
    try {
      const data = JSON.parse(payload.toString());
      handleSensorData(data);
    } catch (e) {
      console.error("[MQTT] Không parse được payload JSON:", payload.toString(), e);
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

  // Mực nước (siêu âm AJ-SR04M)
  if (data.waterLevel) {
    lastWaterLevel = data.waterLevel;
    updateWaterLevel(data.waterLevel);
  }

  if (data.gps && typeof data.gps.lat === "number" && typeof data.gps.lon === "number") {
    const gpsLat = Number(data.gps.lat);
    const gpsLon = Number(data.gps.lon);
    if (Number.isFinite(gpsLat) && Number.isFinite(gpsLon)) {
      updateGpsMap(gpsLat, gpsLon);
    }
  }

  // Mức rung & trạng thái
  const movement = typeof data.movement === "number" ? data.movement : 0;
  const state = data.motionState || classifyMovement(movement);
  motionWarningState = data.warning ?? state !== "stable";

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

soilThresholdInput.addEventListener("input", () => {
  if (lastSoilHumidity !== null) {
    updateSoilStatus(lastSoilHumidity);
  }
});

waterThresholdInput.addEventListener("input", () => {
  if (lastWaterLevel.valid) {
    updateWaterLevel(lastWaterLevel);
  }
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
  if (movement < MOVEMENT_WARNING) return "stable";
  if (movement < MOVEMENT_DANGER) return "warning";
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

  const maxVal = Math.max(MOVEMENT_DANGER * 1.2, ...history.map((h) => h.movement));
  const padding = 10;
  const w = cssWidth - padding * 2;
  const h = cssHeight - padding * 2;

  // Đường ngưỡng
  drawThresholdLine(MOVEMENT_WARNING, maxVal, padding, w, h, "#fbbf24");
  drawThresholdLine(MOVEMENT_DANGER, maxVal, padding, w, h, "#f87171");

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

// ================== KHỞI CHẠY ==================
connectMQTT();