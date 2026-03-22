//SCRIPT FOR MANUAL PAGE
const socket = io();

//For device name
const deviceName = document.getElementById("deviceName");

//For Values of Kp, Ki, Kd, Set Angle, and Button
const sendDataButton = document.getElementById("sendDataButton");

// Graph Properties
const ctx = document.getElementById("pidChart").getContext("2d");
const maxDataPoints = 50; // How many points to show on the screen at once

const pidChart = new Chart(ctx, {
  type: "line",
  data: {
    labels: [], // Time or index
    datasets: [
      {
        label: "Actual Value",
        data: [],
        borderColor: "rgba(75, 192, 192, 1)",
        backgroundColor: "rgba(75, 192, 192, 0.2)",
        borderWidth: 2,
        tension: 0.3, // Smooth curves
      },
      {
        label: "Setpoint",
        data: [],
        borderColor: "rgba(255, 99, 132, 1)",
        borderDash: [5, 5], // Dotted line for setpoint
        borderWidth: 2,
        fill: false,
      },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      y: {
        beginAtZero: true,
        suggestedMax: 180, // Force the scale to stay consistent
        suggestedMin: 0,
      },
      x: { display: false }, // Hide x-axis labels for a cleaner look
    },
  },
});

// Listen for the "realtimeData" event we created in the server
socket.on("realtimeData", (data) => {
  if (isNaN(data.actualValue) || isNaN(data.setpoint)) {
    console.warn("Invalid data received, skipping update.");
    return;
  }

  console.log("New data received:", data);

  // Update your HTML elements dynamically
  if (data.riseTime !== undefined)
    riseTimeValue.innerText = Number(data.riseTime).toFixed(2);
  if (data.settlingTime !== undefined)
    settlingTimeValue.innerText = Number(data.settlingTime).toFixed(2);
  if (data.steadyStateError !== undefined)
    steadyStateErrorValue.innerText = Number(data.steadyStateError).toFixed(2);
  if (data.overshoot !== undefined)
    overshootValue.innerText = Number(data.overshoot).toFixed(2);

  // If you have a device name or status, update it here too
  deviceName.innerText = "ESP32 - Connected";

  const now = new Date().toLocaleTimeString();

  // Add new data
  pidChart.data.labels.push(now);
  pidChart.data.datasets[0].data.push(data.actualValue);
  pidChart.data.datasets[1].data.push(data.setpoint);

  // Remove old data to keep the chart moving (scrolling effect)
  if (pidChart.data.labels.length > maxDataPoints) {
    pidChart.data.labels.shift();
    pidChart.data.datasets[0].data.shift();
    pidChart.data.datasets[1].data.shift();
  }

  pidChart.update("none");
});

// Sends data to ESP32 after clicking button
async function sendData() {
  const proportionalGainValue = document.getElementById(
    "proportionalGainValue",
  ).value;
  const integralGainValue = document.getElementById("integralGainValue").value;
  const derivativeGainValue = document.getElementById(
    "derivativeGainValue",
  ).value;
  const setAngleValue = document.getElementById("setAngleValue").value;
  console.log(proportionalGainValue);
  console.log(integralGainValue);
  console.log(derivativeGainValue);
  console.log(setAngleValue);
  try {
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kp: proportionalGainValue,
        ki: integralGainValue,
        kd: derivativeGainValue,
        set: setAngleValue,
      }),
    });
    const result = await response.json();
    console.log(result.status);
  } catch (error) {
    console.error("Error sending command:", error);
  }
}

// Listener for clearGraph function
socket.on("clearGraph", () => {
  console.log("Clearing graph for new session...");

  // Reset labels and datasets
  pidChart.data.labels = [];
  pidChart.data.datasets.forEach((dataset) => {
    dataset.data = [];
  });

  // Reset the text displays to zero or dashes
  riseTimeValue.innerText = "0";
  settlingTimeValue.innerText = "0";
  steadyStateErrorValue.innerText = "0";
  overshootValue.innerText = "0";

  // Update the visual chart
  pidChart.update();
});

//initiates the sending of data from website to ESP32
sendDataButton.addEventListener("click", sendData);
