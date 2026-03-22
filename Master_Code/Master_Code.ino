#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <math.h>

// --- SETTINGS ---
const char* ssid     = "ohmspi";
const char* password = "1234567890...";
const char* mqtt_server = "192.168.4.1";
const int mqtt_port    = 1883;

#define MPU_ADDR 0x68
#define IN1 26
#define IN2 27

// Topics
const char* TOPIC_SUB = "commandData";
const char* TOPIC_PUB = "performanceData";

// --- MAP HELPERS ---
// MPU roll: +90 .. 0 .. -90  <->  UI/MQTT angle: 0 .. 90 .. 180
static inline float rollToMqttAngle(float r) {
  return constrain(90.0f - r, 0.0f, 180.0f);
}
static inline float mqttAngleToRoll(float a) {
  return constrain(90.0f - a, -90.0f, 90.0f);
}

// --- GLOBAL PID VARIABLES ---
float Kp = 15.0f;
float Ki = 0.5f;
float Kd = 3.5f;

// PID setpoint in roll units (+90..-90)
float setpointRoll = 0.0f;

// UI setpoint in MQTT units (0..180)
float setpointMqtt = 90.0f;

// --- PID STATE ---
float roll = 0.0f;
float integral = 0.0f;
float previous_error = 0.0f;
unsigned long timer;

// --- ANALYTICS (UI SPACE 0..180) ---
unsigned long cmdTime = 0;
float startValueMqtt = 90.0f;
float targetValueMqtt = 90.0f;

bool stepActive = false;
bool riseTimeCaptured = false;
bool settlingTimeCaptured = false;

float riseTime = 0.0f;
float settlingTime = 0.0f;
float overshoot = 0.0f;
float steadyStateError = 0.0f;

unsigned long settleStart = 0;
float peakValueMqtt = 90.0f;
bool peakInit = false;

WiFiClient espClient;
PubSubClient client(espClient);

void reconnect();
void callback(char* topic, byte* payload, unsigned int length);

// --- 1. MQTT CALLBACK (Receiving from Frontend) ---
void callback(char* topic, byte* payload, unsigned int length) {
  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) return;

  if (doc.containsKey("kp")) Kp = (float)doc["kp"];
  if (doc.containsKey("ki")) Ki = (float)doc["ki"];
  if (doc.containsKey("kd")) Kd = (float)doc["kd"];

  bool gotSet = false;
  float newSet = setpointMqtt;

  if (doc.containsKey("set")) {
    newSet = constrain((float)doc["set"], 0.0f, 180.0f);
    gotSet = true;
  }

  if (gotSet) {
    // update setpoints
    setpointMqtt = newSet;
    setpointRoll = mqttAngleToRoll(setpointMqtt);

    // START ANALYTICS IMMEDIATELY ON NEW COMMAND
    float actualNowMqtt = rollToMqttAngle(roll);
    startValueMqtt  = actualNowMqtt;
    targetValueMqtt = setpointMqtt;
    cmdTime = millis();

    stepActive = true;
    riseTimeCaptured = false;
    settlingTimeCaptured = false;
    riseTime = 0.0f;
    settlingTime = 0.0f;
    overshoot = 0.0f;
    settleStart = 0;

    peakValueMqtt = actualNowMqtt;
    peakInit = true;

    // clear PID memory (optional but usually helpful on new setpoint)
    integral = 0.0f;
    previous_error = 0.0f;

    Serial.println("New Setpoint + PID Params Applied (if provided) & Analytics Reset");
  } else {
    Serial.println("New PID Params Applied (no setpoint change)");
  }
}

void setup() {
  Serial.begin(115200);

  // Motor PWM setup
  ledcAttach(IN1, 5000, 8);
  ledcAttach(IN2, 5000, 8);

  // MPU6050 init
  Wire.begin(21, 22);
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B);
  Wire.write(0);
  Wire.endTransmission(true);

  // default mapping (UI 90 => roll 0)
  setpointRoll = mqttAngleToRoll(setpointMqtt);
  targetValueMqtt = setpointMqtt;
  startValueMqtt = setpointMqtt;

  // WiFi
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\nWiFi connected");

  // MQTT
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);

  timer = millis();
}

void loop() {
  if (!client.connected()) reconnect();
  client.loop();

  // --- SENSOR READING ---
  int16_t ax, ay, az, gx;
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  Wire.endTransmission(false);
  Wire.requestFrom(MPU_ADDR, 14, true);
  ax = Wire.read() << 8 | Wire.read();
  ay = Wire.read() << 8 | Wire.read();
  az = Wire.read() << 8 | Wire.read();
  Wire.read(); Wire.read(); // skip temp
  gx = Wire.read() << 8 | Wire.read();

  float dt = (millis() - timer) / 1000.0f;
  if (dt <= 0.0f) dt = 0.01f;
  timer = millis();

  float roll_acc = atan2(ay / 16384.0f, az / 16384.0f) * 180.0f / PI;
  roll = 0.99f * (roll + (gx / 131.0f) * dt) + 0.01f * roll_acc;
  roll = constrain(roll, -90.0f, 90.0f);

  // --- PID CALCULATION (ROLL SPACE) ---
  float error = setpointRoll - roll;
  integral += error * dt;
  integral = constrain(integral, -50.0f, 50.0f);
  float derivative = (error - previous_error) / dt;
  float output = -(Kp * error + Ki * integral + Kd * derivative);
  previous_error = error;

  // --- MOTOR CONTROL ---
  int duty = constrain((int)fabs(output), 0, 255);
  if (duty > 0 && duty < 90) duty = 90;

  if (output > 0) { ledcWrite(IN1, duty); ledcWrite(IN2, 0); }
  else            { ledcWrite(IN1, 0);    ledcWrite(IN2, duty); }

  // --- ANALYTICS (UI SPACE 0..180) ---
  float actualMqtt = rollToMqttAngle(roll);

  if (stepActive) {
    float step = targetValueMqtt - startValueMqtt;
    float stepAbs = fabs(step);

    // always update steady-state error in UI space (even if step is tiny)
    steadyStateError = fabs(actualMqtt - targetValueMqtt);

    if (stepAbs < 1.0f) {
      // too small to compute rise/settling/overshoot meaningfully
      riseTime = 0.0f;
      settlingTime = 0.0f;
      overshoot = 0.0f;
      riseTimeCaptured = true;
      settlingTimeCaptured = true;
    } else {
      float y90 = startValueMqtt + 0.90f * step;

      bool reached90 = (step > 0.0f) ? (actualMqtt >= y90) : (actualMqtt <= y90);
      if (!riseTimeCaptured && reached90) {
        riseTime = (millis() - cmdTime) / 1000.0f;
        riseTimeCaptured = true;
      }

      // peak tracking for overshoot
      if (!peakInit) { peakValueMqtt = actualMqtt; peakInit = true; }
      if (step > 0.0f) peakValueMqtt = max(peakValueMqtt, actualMqtt);
      else             peakValueMqtt = min(peakValueMqtt, actualMqtt);

      float beyond = (step > 0.0f) ? (peakValueMqtt - targetValueMqtt) : (targetValueMqtt - peakValueMqtt);
      overshoot = (beyond > 0.0f) ? (beyond / stepAbs) * 100.0f : 0.0f;

      // settling time: within ±5% of step for 500ms
      float band = 0.05f * stepAbs;
      if (fabs(actualMqtt - targetValueMqtt) <= band) {
        if (settleStart == 0) settleStart = millis();
        if (!settlingTimeCaptured && (millis() - settleStart >= 500)) {
          settlingTime = (settleStart - cmdTime) / 1000.0f;
          settlingTimeCaptured = true;
        }
      } else {
        settleStart = 0;
      }
    }
  } else {
    // if no step has been commanded yet, still show steady state error vs current setpoint
    steadyStateError = fabs(actualMqtt - setpointMqtt);
  }

  // --- PUBLISH DATA EVERY 100ms ---
  static unsigned long lastMsg = 0;
  if (millis() - lastMsg > 100) {
    lastMsg = millis();

    StaticJsonDocument<512> outDoc;
    outDoc["kp"] = Kp;
    outDoc["ki"] = Ki;
    outDoc["kd"] = Kd;

    outDoc["riseTime"] = riseTime;
    outDoc["settlingTime"] = settlingTime;
    outDoc["steadyStateError"] = steadyStateError;
    outDoc["overshoot"] = overshoot;
    outDoc["timestamp"] = millis();

    // UI-friendly values (0..180)
    outDoc["setpoint"] = setpointMqtt;
    outDoc["actualValue"] = actualMqtt;

    // debug values
    outDoc["setpointRoll"] = setpointRoll;
    outDoc["rollRaw"] = roll;
    outDoc["startValue"] = startValueMqtt;
    outDoc["targetValue"] = targetValueMqtt;

    char buffer[256];
    serializeJson(outDoc, buffer);
    client.publish(TOPIC_PUB, buffer);
  }
}

void reconnect() {
  while (!client.connected()) {
    String clientId = "ESP32_PID_" + String(random(0xffff), HEX);
    if (client.connect(clientId.c_str())) {
      client.subscribe(TOPIC_SUB);
    } else {
      delay(5000);
    }
  }
}