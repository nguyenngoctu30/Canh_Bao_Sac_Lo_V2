/*
 * ESP32 - Đọc ADXL345 (gia tốc XYZ) và gửi liên tục lên MQTT
 *
 * Đấu dây:
 *   VCC -> 3V3
 *   GND -> GND
 *   SDA -> GPIO21
 *   SCL -> GPIO22
 *
 * Địa chỉ I2C ADXL345 : 0x53 (SDO nối GND) hoặc 0x1D (SDO nối 3V3)
 *
 * SỬA LỖI QUAN TRỌNG so với bản trước:
 *   1. PubSubClient mặc định chỉ cho phép gói tin MQTT tối đa 256 byte.
 *      Payload JSON + topic của dự án này vượt quá 256 byte nên publish()
 *      luôn trả về false (thất bại) dù Serial vẫn in "Published..." vì code
 *      cũ không kiểm tra giá trị trả về. -> Đã setBufferSize(512) và kiểm
 *      tra return value của publish().
 *   2. Nếu mất kết nối MQTT giữa chừng, code cũ không có logic tự kết nối
 *      lại trong loop() -> đã thêm hàm reconnectMQTT() không chặn (non-blocking).
 *   3. Gửi liên tục với chu kỳ ngắn (mặc định 500ms) thay vì 2000ms.
 */

#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <Preferences.h>

#define GPS_SERIAL Serial2
#define GPS_RX_PIN 16
#define GPS_TX_PIN 17
const uint32_t GPS_BAUD_RATE = 9600;

struct GpsData {
  bool valid;
  double latitude;
  double longitude;
};

GpsData currentGps = {false, 0.0, 0.0};

// Chuyển tọa độ dạng DMM (ddmm.mmmm) sang decimal degrees
// Ví dụ: lat = "1053.1234" => 10 độ + 53.1234 phút => 10 + 53.1234/60 = 10.88539
//        lon = "10640.1234" => 106 độ + 40.1234 phút => 106 + 40.1234/60 = 106.668723

double convertDmmToDecimal(String dmm, char hemi) {
  if (dmm.length() == 0) return 0.0;

  int dotPos = dmm.indexOf('.');
  if (dotPos < 0) return 0.0;

  String degreePart = dmm.substring(0, dotPos);
  String minutePart = dmm.substring(dotPos + 1);

  int degrees = 0;
  double minutes = 0.0;

  if (hemi == 'N' || hemi == 'S') {
    degrees = degreePart.substring(0, 2).toInt();
    minutes = (degreePart.substring(2) + "." + minutePart).toFloat();
  } else {
    degrees = degreePart.substring(0, 3).toInt();
    minutes = (degreePart.substring(3) + "." + minutePart).toFloat();
  }

  double decimal = degrees + (minutes / 60.0);

  if (hemi == 'S' || hemi == 'W') decimal *= -1.0;
  return decimal;
}

bool parseNmeaLine(const String &line, GpsData &gpsOut) {
  if (line.startsWith("$GPRMC") || line.startsWith("$GPGGA")) {
    String trimmed = line;
    trimmed.trim();
    if (trimmed.length() < 10) return false;

    int firstComma = trimmed.indexOf(',');
    if (firstComma < 0) return false;

    int count = 0;
    String parts[20];
    int start = 0;
    for (int i = 0; i <= trimmed.length(); i++) {
      if (i == trimmed.length() || trimmed.charAt(i) == ',') {
        parts[count++] = trimmed.substring(start, i);
        start = i + 1;
      }
    }

    if (line.startsWith("$GPRMC") && count >= 12) {
      String status = parts[2];
      if (status != "A") return false;

      String latStr = parts[3];
      String latHem = parts[4];
      String lonStr = parts[5];
      String lonHem = parts[6];

      if (latStr.length() > 0 && lonStr.length() > 0) {
        gpsOut.latitude = convertDmmToDecimal(latStr, latHem.charAt(0));
        gpsOut.longitude = convertDmmToDecimal(lonStr, lonHem.charAt(0));
        gpsOut.valid = true;
        return true;
      }
    }

    if (line.startsWith("$GPGGA") && count >= 11) {
      String fixQuality = parts[6];
      if (fixQuality.toInt() < 1) return false;

      String latStr = parts[2];
      String latHem = parts[3];
      String lonStr = parts[4];
      String lonHem = parts[5];

      if (latStr.length() > 0 && lonStr.length() > 0) {
        gpsOut.latitude = convertDmmToDecimal(latStr, latHem.charAt(0));
        gpsOut.longitude = convertDmmToDecimal(lonStr, lonHem.charAt(0));
        gpsOut.valid = true;
        return true;
      }
    }
  }

  return false;
}

void readGpsData() {
  static String gpsBuffer = "";

  while (GPS_SERIAL.available() > 0) {
    char c = (char)GPS_SERIAL.read();
    if (c == '\r' || c == '\n') {
      if (gpsBuffer.length() > 0) {
        GpsData parsed = {false, 0.0, 0.0};
        if (parseNmeaLine(gpsBuffer, parsed)) {
          currentGps = parsed;
        }
        gpsBuffer = "";
      }
    } else {
      gpsBuffer += c;
      if (gpsBuffer.length() > 200) gpsBuffer = "";
    }
  }
}

// ---------- WiFi & MQTT ----------
const char* WIFI_SSID = "677 5G";
const char* WIFI_PASSWORD = "10101010";
const char* MQTT_BROKER = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
const char* MQTT_TOPIC = "terraguard/sensors/esp32";
const char* MQTT_CONFIG_TOPIC = "terraguard/config/esp32/baseline_distance";                      // web gửi khoảng cách cố định (cm) xuống đây
const char* MQTT_SOIL_THRESHOLD_TOPIC = "terraguard/config/esp32/soil_threshold";                // web gửi ngưỡng độ ẩm cảnh báo (%)
const char* MQTT_WATER_THRESHOLD_TOPIC = "terraguard/config/esp32/water_threshold";              // web gửi ngưỡng nước dâng cảnh báo (cm)
const char* MQTT_CLIENT_ID = "ESP32-TG042";

// Chu kỳ gửi dữ liệu lên MQTT (ms). Giảm số này để gửi nhanh hơn,
// nhưng đừng đặt quá thấp (<100ms) vì I2C + WiFi cần thời gian xử lý.
const unsigned long PUBLISH_INTERVAL_MS = 500;

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// ---------- Cấu hình I2C ----------
#define SDA_PIN 21
#define SCL_PIN 22
#define I2C_FREQ 400000  // 400 kHz

// ---------- Cảm biến độ ẩm đất (analog) ----------
// CHỈ dùng chân ADC1 (32,33,34,35,36,39) vì ADC2 xung đột với WiFi trên ESP32.
// GPIO34 là chân input-only, rất phù hợp cho cảm biến analog.
#define SOIL_PIN 34
const int SOIL_SAMPLES = 20;   // số lần đọc lấy trung bình để giảm nhiễu ADC

// GIÁ TRỊ HIỆU CHUẨN - BẮT BUỘC chỉnh lại theo cảm biến thật của bạn:
//   1. Nạp code, mở Serial Monitor, để cảm biến HOÀN TOÀN KHÔ TRONG KHÔNG KHÍ
//      -> ghi lại giá trị "Soil RAW" in ra, gán vào SOIL_ADC_DRY.
//   2. Nhúng đầu đo cảm biến vào NƯỚC hoặc đất thật rất ẩm/sũng nước
//      -> ghi lại giá trị "Soil RAW", gán vào SOIL_ADC_WET.
// Cảm biến điện trở (loại rẻ, 2 chân lộ đồng): khô = giá trị ADC CAO, ướt = giá trị ADC THẤP.
// Cảm biến điện dung (capacitive, có chip): thường ngược lại (khô = THẤP, ướt = CAO)
// -> nếu thấy % ẩm bị đảo ngược so với thực tế, chỉ cần đổi chỗ 2 giá trị dưới đây.
int SOIL_ADC_DRY = 3000;  // giá trị ADC đo được khi đất/cảm biến khô hoàn toàn
int SOIL_ADC_WET = 1200;  // giá trị ADC đo được khi đất/cảm biến ướt sũng nước

// ---------- Cảm biến siêu âm AJ-SR04M (đo mực nước) ----------
// Chế độ Trig/Echo (giống HC-SR04). Tầm đo AJ-SR04M ~ 20cm - 450cm.
#define TRIG_PIN 27
#define ECHO_PIN 26
const int ULTRASONIC_SAMPLES = 5;          // số lần đo lấy trung bình mỗi chu kỳ
const unsigned long ECHO_TIMEOUT_US = 60000UL;  // timeout ~30ms (~5m), tránh treo code nếu không có echo

// Khoảng cách cố định từ cảm biến xuống MẶT NƯỚC lúc mực nước bình thường (cm).
// Giá trị này có thể được web gửi xuống qua topic MQTT_CONFIG_TOPIC và sẽ được
// LƯU LẠI (Preferences/NVS) để không bị mất khi ESP32 mất điện / khởi động lại.
float baselineDistanceCm = 50.0f;
float soilHumidityWarningThreshold = 80.0f;  // cảnh báo khi độ ẩm đất >= ngưỡng
float waterLevelWarningThreshold = 10.0f;    // cảnh báo khi mực nước dâng >= ngưỡng (cm)
Preferences preferences;

// ---------- ADXL345 ----------
#define ADXL_ADDR_DEFAULT  0x53
#define ADXL_ADDR_ALT      0x1D
#define ADXL_DEVID         0x00   // phải đọc ra 0xE5
#define ADXL_BW_RATE       0x2C
#define ADXL_POWER_CTL     0x2D
#define ADXL_DATA_FMT      0x31
#define ADXL_DATAX0        0x32   // 6 byte: X Y Z (little-endian)

const float ADXL_SCALE = 0.0039;             // g/LSB (full resolution)
const float ADXL_MOVEMENT_WARNING = 2.1f;    // mức rung cảnh báo nhẹ
const float ADXL_MOVEMENT_DANGER = 3.1f;     // mức rung cảnh báo nặng

struct AdxlData {
  float x, y, z;  // g
};

uint8_t adxlAddr = ADXL_ADDR_DEFAULT;
bool adxlOk = false;

float adxlBaseX = 0.0f, adxlBaseY = 0.0f, adxlBaseZ = 0.0f;
bool adxlBaselineReady = false;

unsigned long lastPublish = 0;
unsigned long lastMqttRetry = 0;

// ---------- Lọc & chống nhiễu ----------
const int CALIBRATION_SAMPLES = 100;   // số mẫu lấy để hiệu chuẩn baseline
const int MOVEMENT_FILTER_WINDOW = 8;  // số mẫu trung bình trượt cho "movement"
const int STATE_CONFIRM_COUNT = 3;     // số mẫu liên tiếp cùng mức mới đổi trạng thái

float movementBuffer[MOVEMENT_FILTER_WINDOW];
int movementBufferIndex = 0;
int movementBufferFilled = 0;

const char* confirmedState = "stable";
const char* pendingState = "stable";
int pendingStateCount = 0;

// ================== Cảm biến siêu âm (mực nước) ==================
// Trả về khoảng cách đo được (cm), hoặc -1 nếu không nhận được echo (ngoài tầm/lỗi)
float readUltrasonicOnce() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long duration = pulseIn(ECHO_PIN, HIGH, ECHO_TIMEOUT_US);
  if (duration == 0) return -1;  // timeout, không đọc được
  return duration * 0.0343f / 2.0f;  // tốc độ âm thanh ~343 m/s
}

// Đo nhiều lần, bỏ qua các lần lỗi, lấy trung bình để giảm nhiễu/đọc nhầm
float readUltrasonicDistanceCm() {
  float sum = 0;
  int validCount = 0;
  for (int i = 0; i < ULTRASONIC_SAMPLES; i++) {
    float d = readUltrasonicOnce();
    if (d > 0) { sum += d; validCount++; }
    delay(10);
  }
  if (validCount == 0) return -1;
  return sum / validCount;
}

// ================== Cảm biến độ ẩm đất (analog) ==================
int readSoilRaw() {
  long sum = 0;
  for (int i = 0; i < SOIL_SAMPLES; i++) {
    sum += analogRead(SOIL_PIN);
    delay(2);
  }
  return sum / SOIL_SAMPLES;
}

// Quy đổi giá trị ADC thô sang % độ ẩm (0-100%), có giới hạn (constrain) để
// không bị âm hoặc vượt 100% khi cảm biến chưa hiệu chuẩn khớp hoàn toàn.
float soilRawToPercent(int raw) {
  float percent = (float)(SOIL_ADC_DRY - raw) * 100.0f / (float)(SOIL_ADC_DRY - SOIL_ADC_WET);
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  return percent;
}

// ================== I2C ==================
bool writeReg(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

uint8_t readReg(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom(addr, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0;
}

bool readBytes(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t len) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(addr, len) != len) return false;
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

uint8_t detectADXL345Address() {
  uint8_t candidates[] = {ADXL_ADDR_DEFAULT, ADXL_ADDR_ALT};
  for (uint8_t i = 0; i < 2; i++) {
    uint8_t id = readReg(candidates[i], ADXL_DEVID);
    Serial.printf("ADXL345 candidate 0x%02X DEVID = 0x%02X\n", candidates[i], id);
    if (id == 0xE5) return candidates[i];
  }
  return 0;
}

bool initADXL345() {
  adxlAddr = detectADXL345Address();
  if (adxlAddr == 0) {
    Serial.println("ADXL345: KHONG TIM THAY TAI 0x53/0x1D");
    return false;
  }
  Serial.printf("ADXL345: dung dia chi 0x%02X\n", adxlAddr);
  writeReg(adxlAddr, ADXL_BW_RATE, 0x0A);    // 100 Hz
  writeReg(adxlAddr, ADXL_DATA_FMT, 0x08);   // full resolution, ±2g
  writeReg(adxlAddr, ADXL_POWER_CTL, 0x08);  // bật chế độ đo
  return true;
}

bool readADXL345(AdxlData &d) {
  uint8_t b[6];
  if (!readBytes(adxlAddr, ADXL_DATAX0, b, 6)) return false;
  int16_t x = (int16_t)((b[1] << 8) | b[0]);
  int16_t y = (int16_t)((b[3] << 8) | b[2]);
  int16_t z = (int16_t)((b[5] << 8) | b[4]);
  d.x = x * ADXL_SCALE;
  d.y = y * ADXL_SCALE;
  d.z = z * ADXL_SCALE;
  return true;
}

// ================== WiFi / MQTT ==================
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Dang ket noi WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();
  Serial.println("WiFi connected");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

// Nhận message MQTT từ topic đã subscribe (dùng cho MQTT_CONFIG_TOPIC)
void mqttCallback(char* topic, byte* payloadBytes, unsigned int length) {
  String topicStr = String(topic);
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)payloadBytes[i];
  msg.trim();

  if (topicStr == MQTT_CONFIG_TOPIC) {
    float newBaseline = msg.toFloat();
    if (newBaseline > 0 && newBaseline < 500) {  // giới hạn hợp lý theo tầm đo AJ-SR04M
      baselineDistanceCm = newBaseline;
      preferences.putFloat("baseline", baselineDistanceCm);
      Serial.printf("[MQTT] Da nhan khoang cach co dinh moi tu web: %.1f cm (da luu vao bo nho)\n",
                    baselineDistanceCm);
    } else {
      Serial.printf("[MQTT] Gia tri baseline khong hop le: \"%s\"\n", msg.c_str());
    }
    return;
  }

  if (topicStr == MQTT_SOIL_THRESHOLD_TOPIC) {
    float threshold = msg.toFloat();
    if (threshold >= 0 && threshold <= 100) {
      soilHumidityWarningThreshold = threshold;
      preferences.putFloat("soil_thresh", soilHumidityWarningThreshold);
      Serial.printf("[MQTT] Da nhan ngưỡng độ ẩm cảnh báo: %.1f%% (đã lưu)\n",
                    soilHumidityWarningThreshold);
    } else {
      Serial.printf("[MQTT] Gia tri ngưỡng độ ẩm khong hop le: \"%s\"\n", msg.c_str());
    }
    return;
  }

  if (topicStr == MQTT_WATER_THRESHOLD_TOPIC) {
    float threshold = msg.toFloat();
    if (threshold >= 0 && threshold <= 200) {
      waterLevelWarningThreshold = threshold;
      preferences.putFloat("water_thresh", waterLevelWarningThreshold);
      Serial.printf("[MQTT] Da nhan ngưỡng mực nước cảnh báo: %.1f cm (đã lưu)\n",
                    waterLevelWarningThreshold);
    } else {
      Serial.printf("[MQTT] Gia tri ngưỡng mực nước khong hop le: \"%s\"\n", msg.c_str());
    }
  }
}

// Kết nối MQTT lần đầu (chặn/blocking, chỉ gọi trong setup)
void connectMQTT() {
  while (!mqttClient.connected()) {
    Serial.printf("Dang ket noi MQTT broker %s...\n", MQTT_BROKER);
    if (mqttClient.connect(MQTT_CLIENT_ID)) {
      Serial.println("MQTT connected");
      mqttClient.subscribe(MQTT_CONFIG_TOPIC);
      mqttClient.subscribe(MQTT_SOIL_THRESHOLD_TOPIC);
      mqttClient.subscribe(MQTT_WATER_THRESHOLD_TOPIC);
      Serial.printf("Da subscribe topic config: %s\n", MQTT_CONFIG_TOPIC);
      Serial.printf("Da subscribe topic ngưỡng độ ẩm: %s\n", MQTT_SOIL_THRESHOLD_TOPIC);
      Serial.printf("Da subscribe topic ngưỡng nước: %s\n", MQTT_WATER_THRESHOLD_TOPIC);
    } else {
      Serial.printf("MQTT connect fail, rc=%d. Thu lai sau 2s\n", mqttClient.state());
      delay(2000);
    }
  }
}

// Tự kết nối lại MQTT trong loop() mà KHÔNG chặn chương trình (non-blocking)
void reconnectMQTTIfNeeded() {
  if (mqttClient.connected()) return;
  unsigned long now = millis();
  if (now - lastMqttRetry < 2000UL) return;  // thử lại mỗi 2s, không delay()
  lastMqttRetry = now;

  Serial.printf("MQTT mat ket noi, dang thu ket noi lai toi %s...\n", MQTT_BROKER);
  if (mqttClient.connect(MQTT_CLIENT_ID)) {
    Serial.println("MQTT ket noi lai thanh cong");
    mqttClient.subscribe(MQTT_CONFIG_TOPIC);
    mqttClient.subscribe(MQTT_SOIL_THRESHOLD_TOPIC);
    mqttClient.subscribe(MQTT_WATER_THRESHOLD_TOPIC);
  } else {
    Serial.printf("MQTT ket noi lai that bai, rc=%d\n", mqttClient.state());
  }
}

// ================== Xử lý dữ liệu ==================

// Hiệu chuẩn baseline bằng TRUNG BÌNH nhiều mẫu (chặn/blocking, chỉ chạy 1 lần
// lúc setup). Yêu cầu ĐỂ CẢM BIẾN ĐỨNG YÊN trong lúc hiệu chuẩn, vì đây chính
// là mốc "0" để so sánh độ rung về sau. Lấy trung bình nhiều mẫu giúp loại bỏ
// nhiễu ngẫu nhiên của một lần đọc đơn lẻ (nguyên nhân gây báo động giả trước đây).
void calibrateBaseline() {
  Serial.printf("Dang hieu chuan baseline (%d mau, giu yen cam bien)...\n", CALIBRATION_SAMPLES);
  double sumX = 0, sumY = 0, sumZ = 0;
  int count = 0;
  AdxlData a;

  for (int i = 0; i < CALIBRATION_SAMPLES; i++) {
    if (readADXL345(a)) {
      sumX += a.x; sumY += a.y; sumZ += a.z;
      count++;
    }
    delay(10);
  }

  if (count > 0) {
    adxlBaseX = sumX / count;
    adxlBaseY = sumY / count;
    adxlBaseZ = sumZ / count;
  }
  adxlBaselineReady = true;
  Serial.printf("Baseline sau hieu chuan: X:%.3f Y:%.3f Z:%.3f (tu %d mau)\n",
                adxlBaseX, adxlBaseY, adxlBaseZ, count);
}

// Trung bình trượt (moving average) để làm mượt giá trị movement, giảm nhiễu
// tức thời khiến trạng thái nhảy loạn giữa warning/danger dù không rung thật.
float filterMovement(float rawMovement) {
  movementBuffer[movementBufferIndex] = rawMovement;
  movementBufferIndex = (movementBufferIndex + 1) % MOVEMENT_FILTER_WINDOW;
  if (movementBufferFilled < MOVEMENT_FILTER_WINDOW) movementBufferFilled++;

  float sum = 0;
  for (int i = 0; i < movementBufferFilled; i++) sum += movementBuffer[i];
  return sum / movementBufferFilled;
}

float calculateMovement(const AdxlData &a) {
  float dx = a.x - adxlBaseX;
  float dy = a.y - adxlBaseY;
  float dz = a.z - adxlBaseZ;
  return sqrtf(dx * dx + dy * dy + dz * dz) * 100.0f;
}

const char* motionStateFromMovement(float movement) {
  if (movement < ADXL_MOVEMENT_WARNING) return "stable";
  if (movement < ADXL_MOVEMENT_DANGER) return "warning";
  return "danger";
}

// Hysteresis: chỉ CHỐT trạng thái mới khi nó lặp lại liên tiếp STATE_CONFIRM_COUNT
// lần, để tránh 1 mẫu nhiễu đơn lẻ làm nhảy trạng thái tức thời.
const char* confirmState(const char* newState) {
  if (strcmp(newState, pendingState) == 0) {
    pendingStateCount++;
  } else {
    pendingState = newState;
    pendingStateCount = 1;
  }
  if (pendingStateCount >= STATE_CONFIRM_COUNT) {
    confirmedState = pendingState;
  }
  return confirmedState;
}

String buildSensorPayload(const AdxlData &a, float movement, const char* state, float soilHumidity,
                           float distanceCm, float waterLevelCm, bool waterLevelValid,
                           bool soilWarning, bool waterWarning) {
  char payload[620];
  bool warning = (strcmp(state, "stable") != 0) || soilWarning || waterWarning;

  snprintf(payload, sizeof(payload),
           "{\"device\":\"%s\",\"timestamp\":%lu,"
           "\"soilHumidity\":%.1f,\"soilThreshold\":%.1f,\"soilWarning\":%s,"
           "\"adxl345\":{\"x\":%.3f,\"y\":%.3f,\"z\":%.3f,\"magnitude\":%.3f,"
           "\"baseline\":{\"x\":%.3f,\"y\":%.3f,\"z\":%.3f}},"
           "\"movement\":%.3f,\"motionState\":\"%s\",\"warning\":%s,"
           "\"waterLevel\":{\"distanceCm\":%.1f,\"levelChangeCm\":%.1f,"
           "\"baselineDistanceCm\":%.1f,\"valid\":%s,\"thresholdCm\":%.1f,\"waterWarning\":%s},"
           "\"rainMm\":3.6}",
           MQTT_CLIENT_ID, millis() / 1000UL,
           soilHumidity, soilHumidityWarningThreshold, soilWarning ? "true" : "false",
           a.x, a.y, a.z,
           sqrtf(a.x * a.x + a.y * a.y + a.z * a.z),
           adxlBaseX, adxlBaseY, adxlBaseZ,
           movement, state, warning ? "true" : "false",
           distanceCm, waterLevelCm, baselineDistanceCm, waterLevelValid ? "true" : "false",
           waterLevelWarningThreshold, waterWarning ? "true" : "false");
  return String(payload);
}

// ================== Arduino ==================
void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin(SDA_PIN, SCL_PIN, I2C_FREQ);

  analogReadResolution(12);            // ESP32: 0-4095
  analogSetPinAttenuation(SOIL_PIN, ADC_11db);  // đọc được đủ dải 0-3.3V
  pinMode(SOIL_PIN, INPUT);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  GPS_SERIAL.begin(GPS_BAUD_RATE, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.println("GPS NEO-6M da khoi dong tren UART2");

  preferences.begin("terraguard", false);
  baselineDistanceCm = preferences.getFloat("baseline", 50.0f);
  soilHumidityWarningThreshold = preferences.getFloat("soil_thresh", 80.0f);
  waterLevelWarningThreshold = preferences.getFloat("water_thresh", 10.0f);
  Serial.printf("Khoang cach co dinh (baseline) hien tai: %.1f cm\n", baselineDistanceCm);
  Serial.printf("Ngưỡng cảnh báo độ ẩm: %.1f%%\n", soilHumidityWarningThreshold);
  Serial.printf("Ngưỡng cảnh báo mực nước: %.1f cm\n", waterLevelWarningThreshold);

  connectWiFi();

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  // QUAN TRỌNG: tăng buffer vì payload JSON của ta > 256 byte mặc định.
  // Với thêm các ngưỡng cảnh báo, payload có thể vượt 512 byte nên dùng 1024.
  mqttClient.setBufferSize(1024);

  connectMQTT();

  adxlOk = initADXL345();
  Serial.println(adxlOk ? "ADXL345: OK" : "ADXL345: KHONG TIM THAY (kiem tra day/dia chi)");

  if (adxlOk) {
    calibrateBaseline();  // BẮT BUỘC: giữ yên cảm biến trong lúc này
  }
  Serial.println();
}

void loop() {
  readGpsData();

  // Giữ WiFi/MQTT sống, tự reconnect nếu rớt
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }
  reconnectMQTTIfNeeded();
  mqttClient.loop();

  AdxlData a;
  unsigned long now = millis();

  if (adxlOk && (now - lastPublish >= PUBLISH_INTERVAL_MS)) {
    lastPublish = now;

    if (readADXL345(a)) {
      float rawMovement = calculateMovement(a);
      float movement = filterMovement(rawMovement);          // đã làm mượt
      const char* rawState = motionStateFromMovement(movement);
      const char* state = confirmState(rawState);             // đã chống dội

      Serial.printf("ADXL345 | Acc[g] X:%7.3f Y:%7.3f Z:%7.3f | Raw:%.3f Filtered:%.3f | State: %s\n",
                    a.x, a.y, a.z, rawMovement, movement, state);

      int soilRaw = readSoilRaw();
      float soilHumidity = soilRawToPercent(soilRaw);
      Serial.printf("Soil moisture | RAW: %d | Humidity: %.1f%%\n", soilRaw, soilHumidity);

      float distanceCm = readUltrasonicDistanceCm();
      float waterLevelCm = 0;
      bool waterLevelValid = (distanceCm > 0);
      bool soilWarning = soilHumidity >= soilHumidityWarningThreshold;
      bool waterWarning = false;

      if (waterLevelValid) {
        // Khoảng cách GIẢM so với baseline => nước dâng lên => levelChange DƯƠNG
        waterLevelCm = baselineDistanceCm - distanceCm;
        waterWarning = (waterLevelCm >= waterLevelWarningThreshold);
        Serial.printf("Muc nuoc | Khoang cach: %.1f cm | Baseline: %.1f cm | Thay doi: %.1f cm (%s)\n",
                      distanceCm, baselineDistanceCm, waterLevelCm,
                      waterLevelCm >= 0 ? "dang" : "ha");
      } else {
        Serial.println("Muc nuoc | Khong doc duoc cam bien sieu am (ngoai tam do / loi day)");
      }

      if (soilWarning) {
        Serial.printf("CAM BIEN | CẢNH BÁO ĐỘ ẨM: %.1f%% >= %.1f%%\n", soilHumidity, soilHumidityWarningThreshold);
      }
      if (waterWarning) {
        Serial.printf("CAM BIEN | CẢNH BÁO MỰC NƯỚC: %.1f cm >= %.1f cm\n", waterLevelCm, waterLevelWarningThreshold);
      }

      String payload = buildSensorPayload(a, movement, state, soilHumidity,
                                           distanceCm, waterLevelCm, waterLevelValid,
                                           soilWarning, waterWarning);

      if (mqttClient.connected()) {
        bool ok = mqttClient.publish(MQTT_TOPIC, payload.c_str());
        if (ok) {
          Serial.println("-> Da gui MQTT THANH CONG");
        } else {
          // In rõ lý do có thể xảy ra để dễ debug thay vì im lặng "giả vờ" thành công
          Serial.printf("-> GUI MQTT THAT BAI! (payload dai %d byte, buffer hien tai %d byte)\n",
                        payload.length(), mqttClient.getBufferSize());
        }
        Serial.println(payload);
      } else {
        Serial.println("-> Bo qua publish: MQTT dang mat ket noi");
      }
      Serial.println();
    }
  }
}
