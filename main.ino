/*
 * ESP32 - ADXL345 (gia tốc XYZ), cảm biến độ ẩm đất, siêu âm AJ-SR04M (mực nước),
 * GPS NEO-6M, gửi MQTT và GỌI ĐIỆN CẢNH BÁO qua module SIM A7680C (KHÔNG dùng SMS).
 *
 * Đấu dây:
 *   ADXL345 : SDA -> GPIO21, SCL -> GPIO22, VCC -> 3V3, GND -> GND
 *   Độ ẩm đất (analog): AOUT -> GPIO34, VCC -> 3V3, GND -> GND
 *   AJ-SR04M: TRIG -> GPIO27, ECHO -> GPIO26 (qua cầu chia áp vì ECHO ra 5V),
 *             VCC -> 5V, GND -> GND
 *   GPS NEO-6M (UART2): TX -> GPIO16 (RX2), RX -> GPIO17 (TX2)
 *   A7680C (UART1):     TX module -> GPIO32 (ESP32 RX)
 *                       RX module -> GPIO33 (ESP32 TX)
 *                       GND chung với ESP32.
 *                       Cấp nguồn RIÊNG cho module (thường 5V, >= 2A).
 *                       Kiểm tra mức logic UART của board module (1.8V/3.3V/5V).
 *
 * LƯU Ý: Struct phải khai báo ngay sau #include (tránh lỗi prototype của Arduino IDE).
 */

#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <HardwareSerial.h>

// ================== STRUCT (BẮT BUỘC ĐỂ Ở ĐẦU FILE) ==================
struct AdxlData {
  float x, y, z;  // g
};

struct GpsData {
  bool valid;
  double latitude;
  double longitude;
};

// ================== GPS NEO-6M ==================
#define GPS_SERIAL Serial2
#define GPS_RX_PIN 16
#define GPS_TX_PIN 17
const uint32_t GPS_BAUD_RATE = 9600;

GpsData currentGps = {false, 0.0, 0.0};

// Chuyển tọa độ DMM (ddmm.mmmm) sang decimal degrees
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
    for (int i = 0; i <= (int)trimmed.length(); i++) {
      if (i == (int)trimmed.length() || trimmed.charAt(i) == ',') {
        if (count < 20) parts[count++] = trimmed.substring(start, i);
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

      if (latStr.length() > 0 && lonStr.length() > 0 && latHem.length() > 0 && lonHem.length() > 0) {
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

      if (latStr.length() > 0 && lonStr.length() > 0 && latHem.length() > 0 && lonHem.length() > 0) {
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
const char* MQTT_CONFIG_TOPIC = "terraguard/config/esp32/baseline_distance";
const char* MQTT_SOIL_THRESHOLD_TOPIC = "terraguard/config/esp32/soil_threshold";
const char* MQTT_WATER_THRESHOLD_TOPIC = "terraguard/config/esp32/water_threshold";
const char* MQTT_MOTION_WARNING_THRESHOLD_TOPIC = "terraguard/config/esp32/motion_warning_threshold";
const char* MQTT_MOTION_DANGER_THRESHOLD_TOPIC = "terraguard/config/esp32/motion_danger_threshold";
const char* MQTT_ALERT_PHONE_TOPIC = "terraguard/config/esp32/alert_phone";  // web gửi số điện thoại nhận cuộc gọi
const char* MQTT_CALL_TEST_TOPIC = "terraguard/config/esp32/call_test";     // publish bat ky noi dung de goi thu
const char* MQTT_CLIENT_ID = "ESP32-TG042";

// Chu kỳ gửi dữ liệu lên MQTT (ms).
const unsigned long PUBLISH_INTERVAL_MS = 500;

WiFiClient espClient;
PubSubClient mqttClient(espClient);

unsigned long lastWifiRetry = 0;

// ---------- Cấu hình I2C ----------
#define SDA_PIN 21
#define SCL_PIN 22
#define I2C_FREQ 400000  // 400 kHz

// ---------- Cảm biến độ ẩm đất (analog) ----------
#define SOIL_PIN 34
const int SOIL_SAMPLES = 20;

// GIÁ TRỊ HIỆU CHUẨN - chỉnh lại theo cảm biến thật của bạn
int SOIL_ADC_DRY = 3000;
int SOIL_ADC_WET = 1200;

// ---------- Cảm biến siêu âm AJ-SR04M ----------
#define TRIG_PIN 27
#define ECHO_PIN 26
const int ULTRASONIC_SAMPLES = 3;
const unsigned long ECHO_TIMEOUT_US = 65000UL;
const unsigned long ULTRASONIC_SAMPLE_GAP_MS = 65;

float baselineDistanceCm = 50.0f;
float soilHumidityWarningThreshold = 80.0f;
float waterLevelWarningThreshold = 10.0f;
float motionWarningThreshold = 0.5f;
float motionDangerThreshold = 2.0f;
Preferences preferences;

// ---------- ADXL345 ----------
#define ADXL_ADDR_DEFAULT  0x53
#define ADXL_ADDR_ALT      0x1D
#define ADXL_DEVID         0x00
#define ADXL_BW_RATE       0x2C
#define ADXL_POWER_CTL     0x2D
#define ADXL_DATA_FMT      0x31
#define ADXL_DATAX0        0x32

const float ADXL_SCALE = 0.0039;

uint8_t adxlAddr = ADXL_ADDR_DEFAULT;
bool adxlOk = false;

float adxlBaseX = 0.0f, adxlBaseY = 0.0f, adxlBaseZ = 0.0f;
bool adxlBaselineReady = false;

unsigned long lastPublish = 0;
unsigned long lastMqttRetry = 0;

// ---------- Lọc & chống nhiễu ----------
const int CALIBRATION_SAMPLES = 100;
const int MOVEMENT_FILTER_WINDOW = 8;
const int STATE_CONFIRM_COUNT = 1;

float movementBuffer[MOVEMENT_FILTER_WINDOW];
int movementBufferIndex = 0;
int movementBufferFilled = 0;

const char* confirmedState = "stable";
const char* pendingState = "stable";
int pendingStateCount = 0;

// ================== A7680C (GỌI ĐIỆN CẢNH BÁO) ==================
#define SIM_RX_PIN 32      // nối vào TX của A7680C
#define SIM_TX_PIN 33      // nối vào RX của A7680C
#define SIM_BAUDRATE 115200
HardwareSerial simSerial(1);   // UART1 (UART2 đang dùng cho GPS)

String alertPhone = "+84327740142";                  // số mặc định, SỬA LẠI (dạng +84901234567)

const unsigned long CALL_DURATION_MS = 25000UL;      // đổ chuông tối đa 25s rồi tự cúp
const unsigned long CALL_COOLDOWN_MS = 30000UL;     // 5 phút mới gọi lại nếu cảnh báo còn kéo dài

// true: gọi cả khi rung ở mức "warning"; false: chỉ gọi khi rung "danger"
const bool CALL_ON_MOTION_WARNING = true;

enum CallState { CALL_IDLE, CALL_ACTIVE };
CallState callState = CALL_IDLE;
unsigned long callStartMs = 0;
unsigned long lastCallMs = 0;
bool callEverMade = false;
bool simReady = false;
String simRx = "";

bool callTestRequested = false;
unsigned long lastSimInitTry = 0;

bool isValidPhoneNumber(const String &phone) {
  if (!phone.startsWith("+")) return false;
  for (unsigned int i = 1; i < phone.length(); i++) {
    if (!isDigit(phone[i])) return false;
  }
  return phone.length() >= 10 && phone.length() <= 15;
}

void savePhone(const String &phone) {
  preferences.putString("alert_phone", phone);
}

// Gửi lệnh AT và chờ phản hồi (blocking ngắn)
String simCommand(const char* cmd, unsigned long timeoutMs = 1000) {
  while (simSerial.available()) simSerial.read();
  simSerial.println(cmd);
  String resp;
  unsigned long t = millis();
  while (millis() - t < timeoutMs) {
    while (simSerial.available()) resp += (char)simSerial.read();
    if (resp.indexOf("OK") >= 0 || resp.indexOf("ERROR") >= 0) break;
    delay(5);
  }
  resp.trim();
  return resp;
}

bool initSim(int attemptsPerBaud) {
  const uint32_t bauds[] = {SIM_BAUDRATE, 9600};   // thu 115200 roi 9600
  bool ok = false;
  for (int b = 0; b < 2 && !ok; b++) {
    simSerial.end();
    simSerial.begin(bauds[b], SERIAL_8N1, SIM_RX_PIN, SIM_TX_PIN);
    delay(300);
    for (int i = 0; i < attemptsPerBaud && !ok; i++) {
      ok = simCommand("AT").indexOf("OK") >= 0;
      if (!ok) delay(300);
    }
    if (ok) Serial.printf("A7680C: phan hoi AT o baud %lu\n", (unsigned long)bauds[b]);
  }
  if (!ok) {
    Serial.println("A7680C: KHONG PHAN HOI AT (kiem tra day TX/RX, nguon, GND chung, baudrate)");
    return false;
  }
  simCommand("ATE0");                 // tắt echo
  simCommand("AT+CMEE=2");            // báo lỗi chi tiết
  Serial.printf("A7680C SIM: %s\n", simCommand("AT+CPIN?").c_str());
  Serial.printf("A7680C mang: %s\n", simCommand("AT+CEREG?").c_str());
  Serial.printf("A7680C song: %s\n", simCommand("AT+CSQ").c_str());
  Serial.printf("A7680C VoLTE: %s\n", simCommand("AT+CVOLTE=1").c_str());
  return true;
}

// Kiểm tra đã đăng ký mạng (LTE / 2G-3G) - ",1" = home, ",5" = roaming
bool simNetworkRegistered() {
  const char* cmds[] = {"AT+CEREG?", "AT+CREG?", "AT+CGREG?"};
  for (int i = 0; i < 3; i++) {
    String r = simCommand(cmds[i]);
    if (r.indexOf(",1") >= 0 || r.indexOf(",5") >= 0) return true;
  }
  return false;
}

// Bắt đầu cuộc gọi thoại (không chặn). Dấu ';' ở cuối là BẮT BUỘC cho cuộc gọi thoại.
void startAlertCall() {
  if (!simReady) {
    Serial.println("[CALL] Module SIM chua san sang, thu khoi tao lai...");
    simReady = initSim(2);
    if (!simReady) {
      Serial.println("[CALL] Van khong ket noi duoc module SIM, bo qua");
      return;
    }
  }
  if (!isValidPhoneNumber(alertPhone)) {
    Serial.println("[CALL] So dien thoai khong hop le, bo qua");
    return;
  }
  if (!simNetworkRegistered()) {
    Serial.println("[CALL] CANH BAO: chua dang ky mang (kiem tra SIM/anten/VoLTE), van thu goi");
  }
  simRx = "";
  while (simSerial.available()) simSerial.read();
  simSerial.print("ATD");
  simSerial.print(alertPhone);
  simSerial.println(";");
  callState = CALL_ACTIVE;
  callStartMs = millis();
  lastCallMs = callStartMs;
  callEverMade = true;
  Serial.printf("[CALL] Dang goi %s ...\n", alertPhone.c_str());
}

// Gọi liên tục trong loop(): đọc phản hồi & tự cúp máy
void serviceSim() {
  String chunk;
  while (simSerial.available()) {
    char c = (char)simSerial.read();
    chunk += c;
    simRx += c;
    if (simRx.length() > 200) simRx.remove(0, 100);
  }
  chunk.trim();
  if (chunk.length() > 0) Serial.printf("[SIM] %s\n", chunk.c_str());
  if (callState != CALL_ACTIVE) return;

  bool ended = simRx.indexOf("NO CARRIER") >= 0 || simRx.indexOf("BUSY") >= 0 ||
               simRx.indexOf("NO ANSWER") >= 0 || simRx.indexOf("NO DIALTONE") >= 0 ||
               simRx.indexOf("VOICE CALL: END") >= 0 ||
               simRx.indexOf("ERROR") >= 0;
  bool timeout = (millis() - callStartMs >= CALL_DURATION_MS);

  if (ended || timeout) {
    simSerial.println("ATH");
    Serial.printf("[CALL] Ket thuc (%s)\n", ended ? "module bao" : "het gio");
    callState = CALL_IDLE;
    simRx = "";
  }
}

// Gõ ký tự 'c' trong Serial Monitor để gọi thử ngay
void handleSerialCommands() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == 'c' || c == 'C') {
      Serial.println("[TEST] Yeu cau goi thu");
      callTestRequested = true;
    }
  }
}

// Gọi khi cảnh báo đang bật, không đang gọi, và đã qua thời gian chờ
void maybeTriggerCall(bool alert) {
  if (!alert || callState != CALL_IDLE) return;
  if (callEverMade && millis() - lastCallMs < CALL_COOLDOWN_MS) return;
  Serial.println("[CALL] Co canh bao -> tien hanh goi dien");
  startAlertCall();
}

// ================== Cảm biến siêu âm (mực nước) ==================
float readUltrasonicOnce() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long duration = pulseIn(ECHO_PIN, HIGH, ECHO_TIMEOUT_US);
  if (duration == 0) return -1;
  return duration * 0.0343f / 2.0f;
}

float readUltrasonicDistanceCm() {
  float sum = 0;
  int validCount = 0;
  for (int i = 0; i < ULTRASONIC_SAMPLES; i++) {
    float d = readUltrasonicOnce();
    if (d > 0) { sum += d; validCount++; }
    delay(ULTRASONIC_SAMPLE_GAP_MS);
  }
  if (validCount == 0) return -1;
  return sum / validCount;
}

// ================== Cảm biến độ ẩm đất ==================
int readSoilRaw() {
  long sum = 0;
  for (int i = 0; i < SOIL_SAMPLES; i++) {
    sum += analogRead(SOIL_PIN);
    delay(2);
  }
  return sum / SOIL_SAMPLES;
}

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
// Kết nối WiFi có timeout (không chặn vô hạn -> cảnh báo gọi điện vẫn hoạt động khi mất WiFi)
bool connectWiFi(unsigned long timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Dang ket noi WiFi");
  unsigned long t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < timeoutMs) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi connected");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }
  Serial.println("WiFi CHUA ket noi duoc (se thu lai ngam, canh bao goi dien van hoat dong)");
  return false;
}

// Tự kết nối lại WiFi trong loop() mà KHÔNG chặn chương trình
void reconnectWiFiIfNeeded() {
  if (WiFi.status() == WL_CONNECTED) return;
  unsigned long now = millis();
  if (now - lastWifiRetry < 10000UL) return;
  lastWifiRetry = now;
  Serial.println("WiFi mat ket noi, thu ket noi lai...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void subscribeAllTopics() {
  mqttClient.subscribe(MQTT_CONFIG_TOPIC);
  mqttClient.subscribe(MQTT_SOIL_THRESHOLD_TOPIC);
  mqttClient.subscribe(MQTT_WATER_THRESHOLD_TOPIC);
  mqttClient.subscribe(MQTT_MOTION_WARNING_THRESHOLD_TOPIC);
  mqttClient.subscribe(MQTT_MOTION_DANGER_THRESHOLD_TOPIC);
  mqttClient.subscribe(MQTT_ALERT_PHONE_TOPIC);
  mqttClient.subscribe(MQTT_CALL_TEST_TOPIC);
}

// Nhận message MQTT từ các topic config đã subscribe
void mqttCallback(char* topic, byte* payloadBytes, unsigned int length) {
  String topicStr = String(topic);
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)payloadBytes[i];
  msg.trim();

  if (topicStr == MQTT_CONFIG_TOPIC) {
    float newBaseline = msg.toFloat();
    if (newBaseline > 0 && newBaseline < 500) {
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
      Serial.printf("[MQTT] Da nhan nguong do am canh bao: %.1f%% (da luu)\n",
                    soilHumidityWarningThreshold);
    } else {
      Serial.printf("[MQTT] Gia tri nguong do am khong hop le: \"%s\"\n", msg.c_str());
    }
    return;
  }

  if (topicStr == MQTT_WATER_THRESHOLD_TOPIC) {
    float threshold = msg.toFloat();
    if (threshold >= 0 && threshold <= 200) {
      waterLevelWarningThreshold = threshold;
      preferences.putFloat("water_thresh", waterLevelWarningThreshold);
      Serial.printf("[MQTT] Da nhan nguong muc nuoc canh bao: %.1f cm (da luu)\n",
                    waterLevelWarningThreshold);
    } else {
      Serial.printf("[MQTT] Gia tri nguong muc nuoc khong hop le: \"%s\"\n", msg.c_str());
    }
    return;
  }

  if (topicStr == MQTT_MOTION_WARNING_THRESHOLD_TOPIC) {
    float threshold = msg.toFloat();
    if (threshold >= 0 && threshold <= 20) {
      motionWarningThreshold = threshold;
      preferences.putFloat("motion_warn_thresh", motionWarningThreshold);
      Serial.printf("[MQTT] Da nhan nguong rung canh bao: %.2f g (da luu)\n", motionWarningThreshold);
    } else {
      Serial.printf("[MQTT] Gia tri nguong rung canh bao khong hop le: \"%s\"\n", msg.c_str());
    }
    return;
  }

  if (topicStr == MQTT_CALL_TEST_TOPIC) {
    Serial.println("[MQTT] Nhan yeu cau goi thu");
    callTestRequested = true;
    return;
  }

  if (topicStr == MQTT_ALERT_PHONE_TOPIC) {
    if (isValidPhoneNumber(msg)) {
      alertPhone = msg;
      savePhone(alertPhone);
      Serial.printf("[MQTT] Da nhan so dien thoai canh bao: %s (da luu)\n", alertPhone.c_str());
    } else {
      Serial.printf("[MQTT] So dien thoai khong hop le: \"%s\"\n", msg.c_str());
    }
    return;
  }

  if (topicStr == MQTT_MOTION_DANGER_THRESHOLD_TOPIC) {
    float threshold = msg.toFloat();
    if (threshold >= 0 && threshold <= 20) {
      motionDangerThreshold = threshold;
      preferences.putFloat("motion_danger_thresh", motionDangerThreshold);
      Serial.printf("[MQTT] Da nhan nguong rung nguy hiem: %.2f g (da luu)\n", motionDangerThreshold);
    } else {
      Serial.printf("[MQTT] Gia tri nguong rung nguy hiem khong hop le: \"%s\"\n", msg.c_str());
    }
  }
}

// Tự kết nối lại MQTT trong loop() mà KHÔNG chặn chương trình
void reconnectMQTTIfNeeded() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (mqttClient.connected()) return;
  unsigned long now = millis();
  if (now - lastMqttRetry < 3000UL) return;
  lastMqttRetry = now;

  Serial.printf("MQTT chua ket noi, dang thu ket noi toi %s...\n", MQTT_BROKER);
  if (mqttClient.connect(MQTT_CLIENT_ID)) {
    Serial.println("MQTT ket noi thanh cong");
    subscribeAllTopics();
  } else {
    Serial.printf("MQTT ket noi that bai, rc=%d\n", mqttClient.state());
  }
}

// ================== Xử lý dữ liệu ==================

// Hiệu chuẩn baseline bằng trung bình nhiều mẫu. GIỮ CẢM BIẾN ĐỨNG YÊN.
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
  if (movement < motionWarningThreshold) return "stable";
  if (movement < motionDangerThreshold) return "warning";
  return "danger";
}

// Hysteresis: chỉ CHỐT trạng thái mới khi lặp lại liên tiếp STATE_CONFIRM_COUNT lần
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
           "\"movement\":%.3f,\"motionState\":\"%s\",\"motionWarningThreshold\":%.2f,\"motionDangerThreshold\":%.2f,\"warning\":%s,"
           "\"waterLevel\":{\"distanceCm\":%.1f,\"levelChangeCm\":%.1f,"
           "\"baselineDistanceCm\":%.1f,\"valid\":%s,\"thresholdCm\":%.1f,\"waterWarning\":%s},"
           "\"rainMm\":3.6}",
           MQTT_CLIENT_ID, millis() / 1000UL,
           soilHumidity, soilHumidityWarningThreshold, soilWarning ? "true" : "false",
           a.x, a.y, a.z,
           sqrtf(a.x * a.x + a.y * a.y + a.z * a.z),
           adxlBaseX, adxlBaseY, adxlBaseZ,
           movement, state, motionWarningThreshold, motionDangerThreshold, warning ? "true" : "false",
           distanceCm, waterLevelCm, baselineDistanceCm, waterLevelValid ? "true" : "false",
           waterLevelWarningThreshold, waterWarning ? "true" : "false");
  return String(payload);
}

// ================== Arduino ==================
void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin(SDA_PIN, SCL_PIN, I2C_FREQ);

  analogReadResolution(12);
  analogSetPinAttenuation(SOIL_PIN, ADC_11db);
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
  motionWarningThreshold = preferences.getFloat("motion_warn_thresh", 0.5f);
  motionDangerThreshold = preferences.getFloat("motion_danger_thresh", 2.0f);
  alertPhone = preferences.getString("alert_phone", alertPhone);
  Serial.printf("Khoang cach co dinh (baseline) hien tai: %.1f cm\n", baselineDistanceCm);
  Serial.printf("Nguong canh bao do am: %.1f%%\n", soilHumidityWarningThreshold);
  Serial.printf("Nguong canh bao muc nuoc: %.1f cm\n", waterLevelWarningThreshold);
  Serial.printf("Nguong rung canh bao: %.2f g\n", motionWarningThreshold);
  Serial.printf("Nguong rung nguy hiem: %.2f g\n", motionDangerThreshold);
  Serial.printf("So dien thoai canh bao: %s\n", alertPhone.c_str());

  // Khởi tạo module SIM A7680C (UART1)
  simReady = initSim(3);

  connectWiFi(20000UL);   // tối đa 20s, không chặn vô hạn

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024);
  mqttClient.setSocketTimeout(3);

  if (WiFi.status() == WL_CONNECTED) {
    if (mqttClient.connect(MQTT_CLIENT_ID)) {
      Serial.println("MQTT connected");
      subscribeAllTopics();
    } else {
      Serial.printf("MQTT connect fail, rc=%d (se thu lai trong loop)\n", mqttClient.state());
    }
  }

  adxlOk = initADXL345();
  Serial.println(adxlOk ? "ADXL345: OK" : "ADXL345: KHONG TIM THAY (kiem tra day/dia chi) - do am/muc nuoc van canh bao binh thuong");

  if (adxlOk) {
    calibrateBaseline();
  }
  Serial.println();
}

void loop() {
  readGpsData();
  serviceSim();
  handleSerialCommands();

  // Module SIM chưa sẵn sàng (boot chậm...) -> thử khởi tạo lại mỗi 15s
  if (!simReady && callState == CALL_IDLE && millis() - lastSimInitTry > 15000UL) {
    lastSimInitTry = millis();
    simReady = initSim(1);
  }

  if (callTestRequested) {
    callTestRequested = false;
    if (callState == CALL_IDLE) startAlertCall();
  }

  reconnectWiFiIfNeeded();
  reconnectMQTTIfNeeded();
  mqttClient.loop();

  unsigned long now = millis();

  if (now - lastPublish >= PUBLISH_INTERVAL_MS) {
    lastPublish = now;

    // ---- Rung (ADXL345). Nếu ADXL lỗi thì coi như "stable", các cảnh báo khác vẫn chạy ----
    AdxlData a = {0, 0, 0};
    float movement = 0;
    const char* state = "stable";

    if (adxlOk && readADXL345(a)) {
      float rawMovement = calculateMovement(a);
      movement = filterMovement(rawMovement);
      const char* rawState = motionStateFromMovement(movement);
      state = confirmState(rawState);

      Serial.printf("ADXL345 | Acc[g] X:%7.3f Y:%7.3f Z:%7.3f | Raw:%.3f Filtered:%.3f | State: %s\n",
                    a.x, a.y, a.z, rawMovement, movement, state);
    }

    // ---- Độ ẩm đất ----
    int soilRaw = readSoilRaw();
    float soilHumidity = soilRawToPercent(soilRaw);
    Serial.printf("Soil moisture | RAW: %d | Humidity: %.1f%%\n", soilRaw, soilHumidity);

    // ---- Mực nước ----
    float distanceCm = readUltrasonicDistanceCm();
    float waterLevelCm = 0;
    bool waterLevelValid = (distanceCm > 0);
    bool soilWarning = soilHumidity >= soilHumidityWarningThreshold;
    bool waterWarning = false;

    if (waterLevelValid) {
      waterLevelCm = baselineDistanceCm - distanceCm;
      waterWarning = (waterLevelCm >= waterLevelWarningThreshold);
      Serial.printf("Muc nuoc | Khoang cach: %.1f cm | Baseline: %.1f cm | Thay doi: %.1f cm (%s)\n",
                    distanceCm, baselineDistanceCm, waterLevelCm,
                    waterLevelCm >= 0 ? "dang" : "ha");
    } else {
      Serial.println("Muc nuoc | Khong doc duoc cam bien sieu am (ngoai tam do / loi day)");
    }

    if (soilWarning) {
      Serial.printf("CAM BIEN | CANH BAO DO AM: %.1f%% >= %.1f%%\n", soilHumidity, soilHumidityWarningThreshold);
    }
    if (waterWarning) {
      Serial.printf("CAM BIEN | CANH BAO MUC NUOC: %.1f cm >= %.1f cm\n", waterLevelCm, waterLevelWarningThreshold);
    }

    // ---- Kích hoạt cuộc gọi cảnh báo (chỉ gọi điện, không SMS) ----
    bool motionAlert = CALL_ON_MOTION_WARNING ? (strcmp(state, "stable") != 0)
                                              : (strcmp(state, "danger") == 0);
    bool anyAlert = motionAlert || soilWarning || waterWarning;
    maybeTriggerCall(anyAlert);

    // ---- Gửi MQTT ----
    String payload = buildSensorPayload(a, movement, state, soilHumidity,
                                         distanceCm, waterLevelCm, waterLevelValid,
                                         soilWarning, waterWarning);

    if (mqttClient.connected()) {
      bool ok = mqttClient.publish(MQTT_TOPIC, payload.c_str());
      if (ok) {
        Serial.println("-> Da gui MQTT THANH CONG");
      } else {
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