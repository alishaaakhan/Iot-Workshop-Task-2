#include <DHT.h>
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>

#define DHT_PIN D4          // GPIO2 for DHT11
#define MOISTURE_PIN A0     // Analog for soil moisture
#define MOTION_PIN D0       // GPIO16 for IR sensor

#define DHTTYPE DHT11
DHT dht(DHT_PIN, DHTTYPE);

// --- Change these ---
const char* ssid = "YOUR_SSID";
const char* password = "YOUR_PASSWORD";

// Render host only (IMPORTANT: no https:// and no trailing slash)
// Example: "multi-sensor-dashboard-2026.onrender.com"
const char* server = "your-app.onrender.com";
const int httpsPort = 443;

float temperature = 0;
float humidity = 0;
float soil_moisture = 0;
boolean motion_detected = false;

unsigned long lastSendTime = 0;
const unsigned long SEND_INTERVAL = 30000; // 30 seconds

void connectToWiFi() {
  Serial.print("Connecting to WiFi: ");
  Serial.println(ssid);

  WiFi.begin(ssid, password);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi Connected!");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi Failed!");
  }
}

void readSensors() {
  // DHT11
  temperature = dht.readTemperature();
  humidity = dht.readHumidity();

  if (isnan(temperature) || isnan(humidity)) {
    Serial.println("DHT11 read failed!");
    temperature = 0;
    humidity = 0;
  }

  // Soil Moisture (0-1023 -> 0-100)
  int raw_moisture = analogRead(MOISTURE_PIN);
  soil_moisture = map(raw_moisture, 0, 1023, 0, 100);

  // IR Motion Sensor
  motion_detected = digitalRead(MOTION_PIN) == HIGH;

  Serial.print("Temp: ");
  Serial.print(temperature);
  Serial.print("°C, Humidity: ");
  Serial.print(humidity);
  Serial.print("%, Moisture: ");
  Serial.print(soil_moisture);
  Serial.print("%, Motion: ");
  Serial.println(motion_detected ? "Yes" : "No");
}

void sendDataToServer() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected, reconnecting...");
    connectToWiFi();
    return;
  }

  WiFiClientSecure client;
  client.setInsecure(); // For development (no certificate check)
  client.setTimeout(15000);

  Serial.print("Connecting to server: ");
  Serial.println(server);

  if (!client.connect(server, httpsPort)) {
    Serial.println("Server connection failed!");
    return;
  }

  String url = "/api/sensors/save?temperature=" + String(temperature, 2)
    + "&humidity=" + String(humidity, 2)
    + "&soil_moisture=" + String(soil_moisture, 2)
    + "&motion=" + (motion_detected ? "1" : "0");

  // Cloudflare/Render-friendly request (avoid malformed headers)
  client.print(String("GET ") + url + " HTTP/1.1\r\n");
  client.print(String("Host: ") + server + "\r\n");
  client.print("User-Agent: ESP8266\r\n");
  client.print("Accept: */*\r\n");
  client.print("Connection: close\r\n\r\n");

  // Read response
  String response = "";
  unsigned long start = millis();
  while ((client.connected() || client.available()) && millis() - start < 15000) {
    while (client.available()) {
      char c = client.read();
      response += c;
    }
    delay(10);
  }
  client.stop();

  if (response.indexOf("HTTP/1.1 200") != -1 && (response.indexOf("\"success\":true") != -1 || response.indexOf("success") != -1)) {
    Serial.println("Data sent successfully!");
  } else {
    Serial.println("Send failed!");
    Serial.println(response);
  }
}

void setup() {
  Serial.begin(115200);
  delay(100);

  pinMode(MOTION_PIN, INPUT);
  dht.begin();

  connectToWiFi();

  // IST timezone (UTC+5:30) for NTP time
  configTime(5 * 3600 + 30 * 60, 0, "pool.ntp.org", "time.nist.gov");
}

void loop() {
  readSensors();

  if (millis() - lastSendTime >= SEND_INTERVAL) {
    sendDataToServer();
    lastSendTime = millis();
  }

  delay(1000);
}

