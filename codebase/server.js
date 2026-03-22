const express = require("express");
const mqtt = require("mqtt");
const path = require("path");
const { Client } = require("pg");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
//server port
const port = 3000;
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());

const mqttClient = mqtt.connect("mqtt://localhost:1883"); //may need to be adjusted to RPi's IP

//connection to the database
const con = new Client({
  host: "localhost",
  username: "bulsu",
  port: 5432,
  password: "1234567890...",
  database: "piddata",
});
con.connect().then(() => console.log("Connected to Database"));

// MQTT setup
mqttClient.on("connect", () => {
  console.log("Backend connected to MQTT server");
  //subscribes the server to "performanceData" topic
  mqttClient.subscribe("performanceData");
});

// Middleware to parse JSON from frontend
app.use(express.json());
app.use(express.static("public")); // Serves your HTML file

// Send commands from Frontend to ESP32
app.post("/api/command", (req, res) => {
  const { kp, ki, kd, set } = req.body;
  const payload = JSON.stringify({
    kp: kp || null,
    ki: ki || null,
    kd: kd || null,
    set,
  });

  // 1. Wipe the database table
  const clearQuery = "TRUNCATE TABLE performancedata"; // Use TRUNCATE for a fast, total wipe

  con.query(clearQuery, (err) => {
    if (err) {
      console.error("Error clearing database:", err.message);
      return res.status(500).json({ error: "Failed to clear old data" });
    }

    console.log("Database table performancedata wiped.");

    // 2. Tell the frontend to clear the graph
    io.emit("clearGraph");

    // 3. Publish the new PID values to the ESP32
    mqttClient.publish("commandData", payload, (mqttErr) => {
      if (mqttErr) return res.status(500).json({ error: "Failed to publish" });
      res.json({ status: "Database wiped and command sent!" });
    });
  });
});

// ZIEGLERS NICHOLS TUNING METHOD
let doZiegler = false;
let currentKp = 0;
const MOVEMENT_THRESHOLD = 5.0; // Arm must move 5° from start to count
const OSCILLATION_MIN_AMP = 2.0; // Swings must be > 2° to be a real oscillation
let lastValue = null;
let isRising = null;
let peaks = []; // Stores { value, time }
let troughs = []; // Stores { value, time }
let znClient = null;
let startValue = null;

async function sendKpToEsp32(kpValue, ki = 0, kd = 0, setpoint = 100) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ kp: kpValue, ki, kd, set: setpoint });
    mqttClient.publish("commandData", payload, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function detectPeak(samples) {
  if (samples.length < 3) return null;

  const a = samples[samples.length - 3].value;
  const b = samples[samples.length - 2].value;
  const c = samples[samples.length - 1].value;

  if (b > a && b > c) {
    return { peak: b, time: samples[samples.length - 2].time };
  } else if (b < a && b < c) {
    return { trough: b, time: samples[samples.length - 2].time };
  }

  return null;
}

function detectOscillation() {
  if (samples.length < 2) return null;

  const current = samples[samples.length - 1];
  const prev = samples[samples.length - 2];

  const threshold = 0.05; // ignore small noise
  if (Math.abs(current.value - prev.value) < threshold) return null;

  if (current.value > prev.value) rising = true;
  else if (current.value < prev.value && rising) {
    // Peak detected
    if (lastPeak) {
      const P_P = Math.abs(lastPeak.value - current.value);
      peakToPeaks.push(P_P);
      if (peakToPeaks.length > 5) peakToPeaks.shift();
      cycleCount++;

      // Check sustained oscillation: variation < 10%
      const maxPP = Math.max(...peakToPeaks);
      const minPP = Math.min(...peakToPeaks);
      const avgPP = peakToPeaks.reduce((a, b) => a + b, 0) / peakToPeaks.length;
      const sustained = (maxPP - minPP) / avgPP < 0.1;

      // Compute Tu (average period)
      let Tu = null;
      if (peakTimes.length >= 2) {
        const periods = [];
        for (let i = 1; i < peakTimes.length; i++) {
          periods.push(peakTimes[i] - peakTimes[i - 1]);
        }
        Tu = periods.reduce((a, b) => a + b, 0) / periods.length;
      }

      return { cycle: cycleCount, P_P, sustained, Tu };
    }

    lastPeak = { value: current.value, time: current.time };
    peakTimes.push(current.time);
    rising = false;
  }
  return null;
}

function processZiegler(actualValue, timestamp) {
  if (startValue === null) startValue = actualValue;

  // 1. Check if the arm has actually lifted yet
  const traveled = Math.abs(actualValue - startValue);
  if (traveled < MOVEMENT_THRESHOLD) {
    return; // Propeller hasn't overcome gravity yet
  }

  if (lastValue !== null) {
    if (actualValue > lastValue) {
      if (isRising === false) {
        // We just hit a TROUGH (bottom of the swing)
        troughs.push({ value: lastValue, time: timestamp });
        if (troughs.length > 5) troughs.shift();
      }
      isRising = true;
    } else if (actualValue < lastValue) {
      if (isRising === true) {
        // We just hit a PEAK (top of the swing)
        peaks.push({ value: lastValue, time: timestamp });
        if (peaks.length > 5) peaks.shift();

        console.log(`Peak detected: ${lastValue} at Kp: ${currentKp}`);
        checkForSustainedOscillation();
      }
      isRising = false;
    }
  }
  lastValue = actualValue;
}

function checkForSustainedOscillation() {
  if (peaks.length < 3 || troughs.length < 3) return;

  const lastPeak = peaks[peaks.length - 1].value;
  const prevPeak = peaks[peaks.length - 2].value;
  const lastTrough = troughs[troughs.length - 1].value;

  const amplitude = Math.abs(lastPeak - lastTrough);
  const peakVariation = Math.abs(lastPeak - prevPeak);

  // If amplitude is healthy and peaks are staying at a similar height (within 10%)
  if (amplitude > OSCILLATION_MIN_AMP && peakVariation / amplitude < 0.1) {
    const Tu =
      (peaks[peaks.length - 1].time - peaks[peaks.length - 2].time) / 1000;
    const Ku = currentKp;

    // Classic Ziegler-Nichols Formulas
    // const finalKp = 0.6 * Ku;
    // const finalKi = 1.2 * (finalKp / Tu);
    // const finalKd = (finalKp * Tu) / 8;

    /**
     * ZIEGLER-NICHOLS GAIN CALCULATIONS (Table 2)
     * Note: These formulas convert Time Constants (Ti, Td) into Controller Gains (Ki, Kd).
     * We use the Parallel Form of the PID equation as required by the ESP32 firmware.
     */
    // Kp = 0.60 * Ku
    const finalKp = parseFloat((0.6 * Ku).toFixed(3));
    // Ki = (Kp / Ti) -> (0.60 * Ku) / (0.5 * Tu) = 1.2 * Ku / Tu
    const finalKi = parseFloat(((1.2 * Ku) / Tu).toFixed(3));
    // Kd = (Kp * Td) -> (0.60 * Ku) * (0.125 * Tu) = 0.075 * Ku * Tu = 3/40 * Ku * Tu
    const finalKd = parseFloat(((3 * Ku * Tu) / 40).toFixed(3));
    console.log(`!!! SUSTAINED OSCILLATION FOUND !!!`);
    console.log(`Ku: ${Ku}, Tu: ${Tu}s`);
    console.log(`Calculated -> Kp: ${finalKp}, Ki: ${finalKi}, Kd: ${finalKd}`);

    doZiegler = false; // Stop the loop
    if (znClient) {
      znClient.emit("zn-finished", {
        kp: finalKp,
        ki: finalKi,
        kd: finalKd,
        Ku: parseFloat(Ku.toFixed(3)),
        Tu: parseFloat(Tu.toFixed(3)),
      });
    }
  }
}

// For receiving MQTT data
mqttClient.on("message", (topic, message) => {
  try {
    const data = JSON.parse(message.toString());

    if (topic === "performanceData") {
      const insertQuery = `
        INSERT INTO performanceData (riseTime, settlingTime, steadyStateError, overshoot, setpoint, actualValue) 
        VALUES ($1, $2, $3, $4, $5, $6)
      `;
      const values = [
        data.riseTime,
        data.settlingTime,
        data.steadyStateError,
        data.overshoot,
        data.setpoint,
        data.actualValue,
      ];

      con.query(insertQuery, values, (err, result) => {
        if (err) {
          console.error("Database Error:", err.message);
        } else {
          console.log("Performance data saved to DB");
        }
      });
      io.emit("realtimeData", data);

      if (doZiegler) {
        processZiegler(data.actualValue, data.timestamp);
      }
    }
  } catch (error) {
    console.error("Received message was not valid JSON", error);
  }
});

io.on("connection", (socket) => {
  console.log("Frontend connected:", socket.id);
  znClient = socket;

  socket.on("start-zn", async (data) => {
    console.log("Starting ZN sequence...");
    console.log(`Setpoint: ${data.setpoint}`);
    doZiegler = true;
    currentKp = 0.1; // Start low
    startValue = null;
    peaks = [];
    troughs = [];
    const setpoint = data.setpoint || 90;
    // Increment Kp until oscillation is found or max reached
    while (doZiegler && currentKp <= 20) {
      await sendKpToEsp32(currentKp, 0, 0, setpoint);
      io.emit("kp-climb", { currentKp: currentKp.toFixed(2) });
      console.log(`Testing Kp: ${currentKp.toFixed(2)}`);

      // WAIT: 2 seconds gives the propeller time to spin up and move
      await new Promise((r) => setTimeout(r, 5000));

      if (doZiegler) {
        currentKp += 0.05; // kp step size
      } else {
        console.log("Loop terminated: Oscillation detected.");
      }
    }
  });

  socket.on("disconnect", () => {
    console.log("Frontend disconnected:", socket.id);
    znClient = null;
  });
});

//serve static files
app.use(express.static(path.join(__dirname, "frontend")));

server.listen(port, () => {
  console.log(`Server and WebSockets listening on port ${port}`);
});
