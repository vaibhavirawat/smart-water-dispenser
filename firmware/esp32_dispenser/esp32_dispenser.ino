// ESP32 firmware for one smart water dispenser.
// Sensors: HC-SR04 ultrasonic (tank level), DS18B20 (water temp), YF-S201 flow sensor (dispensed volume).
// Libraries (Library Manager): OneWire, DallasTemperature. WiFi/HTTPClient/ArduinoJson-free (JSON built by hand).
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ---- configure these ----
const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASS = "YOUR_PASSWORD";
const char* SERVER    = "http://192.168.1.50:3000";  // LAN IP, or your deployed https://... address
const char* API_KEY   = "";                          // must match DEVICE_API_KEY in .env
const int   DISPENSER_ID = 1;                        // id from the dashboard
const float TANK_HEIGHT_CM = 40.0;                   // sensor-to-bottom distance when tank is empty
const float TANK_CAPACITY_L = 20.0;
// -------------------------

const int TRIG_PIN = 5, ECHO_PIN = 18, TEMP_PIN = 4, FLOW_PIN = 19;
const float PULSES_PER_ML = 0.45;  // YF-S201 ~450 pulses per litre
const unsigned long REPORT_MS = 10000;

OneWire oneWire(TEMP_PIN);
DallasTemperature temps(&oneWire);
volatile unsigned long flowPulses = 0;
void IRAM_ATTR onPulse() { flowPulses++; }
unsigned long lastReport = 0;

float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW); delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long us = pulseIn(ECHO_PIN, HIGH, 30000);
  return us ? us * 0.0343 / 2 : -1;
}

bool post(const String& path, const String& body) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  WiFiClientSecure tls;
  if (String(SERVER).startsWith("https")) {
    tls.setInsecure();  // skips certificate checking; for production pin the CA with tls.setCACert(...)
    http.begin(tls, String(SERVER) + path);
  } else {
    http.begin(String(SERVER) + path);
  }
  http.addHeader("Content-Type", "application/json");
  if (strlen(API_KEY)) http.addHeader("x-api-key", API_KEY);
  int code = http.POST(body);
  http.end();
  Serial.printf("POST %s -> %d\n", path.c_str(), code);
  return code >= 200 && code < 300;
}

void connectWifi() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("WiFi");
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " connected" : " failed");
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT); pinMode(ECHO_PIN, INPUT);
  pinMode(FLOW_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_PIN), onPulse, FALLING);
  temps.begin();
  connectWifi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();  // reconnect after drops

  // report water that flowed since the last check as a dispense event
  noInterrupts(); unsigned long p = flowPulses; flowPulses = 0; interrupts();
  int ml = (int)(p / PULSES_PER_ML);
  if (ml >= 20) post("/api/dispensers/" + String(DISPENSER_ID) + "/dispense", "{\"volume_ml\":" + String(ml) + "}");

  if (millis() - lastReport >= REPORT_MS) {
    lastReport = millis();
    float d = readDistanceCm();
    temps.requestTemperatures();
    float t = temps.getTempCByIndex(0);
    String body = "{";
    if (d >= 0) {
      float level = constrain((TANK_HEIGHT_CM - d) / TANK_HEIGHT_CM, 0.0, 1.0) * TANK_CAPACITY_L;
      body += "\"level_l\":" + String(level, 2);
    }
    if (t > -100) body += String(d >= 0 ? "," : "") + "\"temperature_c\":" + String(t, 1);
    body += "}";
    post("/api/dispensers/" + String(DISPENSER_ID) + "/readings", body);  // also acts as heartbeat
  }
  delay(2000);
}
