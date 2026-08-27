# D1 Wi-Fi Control Protocol — Simple Developer Guide

This is a short, practical guide for building a browser controller for the NavBot D1 robot dog.

For formal requirements, field validation, state machines, and verification cases, see [WIFI_CONTROL_PROTOCOL.md](WIFI_CONTROL_PROTOCOL.md).

## 1. Quick Start

1. Connect the computer, phone, or handheld device to the D1 Wi-Fi hotspot in the operating-system Wi-Fi settings.
2. Start a local web server in the demo directory:

   ```bash
   python -m http.server 8000
   ```

3. Open `http://localhost:8000`.
4. The demo automatically connects to `ws://192.168.50.1:8081/ws/robot`.

The browser cannot join the D1 Wi-Fi automatically. The user must select the hotspot first.

## 2. Default Addresses

| Function | Address |
| --- | --- |
| Robot WebSocket | `ws://192.168.50.1:8081/ws/robot` |
| HTTP API base | `http://192.168.50.1:8081` |
| MJPEG camera | `http://192.168.50.1:8080/stream?topic=/image_raw` |
| SSH tunnel | `ws://192.168.50.1:8081/ws/ssh` |

Use another control address without editing the demo:

```text
http://localhost:8000/?host=<robot-ip>&port=<control-port>
```

## 3. Demo File Map

| File | Purpose |
| --- | --- |
| `index.html` | Buttons and status elements |
| `styles.css` | Controller layout |
| `app.js` | WebSocket connection, reconnect, commands, and UI state |
| `protocol.js` | Binary command encoder and ACK decoder |
| `tests/protocol.test.js` | Known protocol fixtures |

The current page contains only:

- **Start Learning**
- **Stand Up**
- **Crouch Down**

## 4. Connect to the Robot

```js
const host = "192.168.50.1";
const port = 8081;
const socket = new WebSocket(`ws://${host}:${port}/ws/robot`);

socket.binaryType = "arraybuffer";

socket.addEventListener("open", () => {
  console.log("D1 connected");
});

socket.addEventListener("message", (event) => {
  if (!(event.data instanceof ArrayBuffer)) return;
  // Decode RobotMessage here.
});

socket.addEventListener("close", () => {
  console.log("D1 disconnected");
  // Disable controls, clear motion, and reconnect later.
});
```

Rules:

- `/ws/robot` uses binary protobuf frames.
- Do not send JSON strings through this WebSocket.
- Keep controls disabled until the socket is open.
- Do not replay old commands after reconnecting.

## 5. Action Commands

Action commands use `ClientRobotMessage` field `8`.

| Mode | JavaScript constant | Action |
| ---: | --- | --- |
| `1` | `STAND_UP` | Stand Up |
| `2` | `CROUCH_DOWN` | Crouch Down; protocol name is Lie Down |
| `3` | `START_LEARNING` | Enter reinforcement learning |
| `4` | `STOP_LEARNING` | Exit reinforcement learning |

The included `protocol.js` already encodes these values:

```js
const bytes = D1Protocol.encodeModeCommand(
  1,                         // seq
  D1Protocol.MODES.STAND_UP, // mode
  Date.now(),                // client_time_ms
);

socket.send(bytes);
```

Command structure:

```proto
message D1ModeCommand {
  uint32 seq = 1;
  D1Mode mode = 2;
  int64 client_time_ms = 3;
}
```

| Field | Meaning |
| --- | --- |
| `seq` | Non-zero command number used to match the reply |
| `mode` | Action value from the table above |
| `client_time_ms` | Current Unix time in milliseconds |

Known Stand frame for sequence `1` and timestamp `0`:

```text
42 06 08 01 10 01 18 00
```

## 6. Action Reply (ACK)

The robot returns `D1ModeAck` in `RobotMessage` field `20`:

```proto
message D1ModeAck {
  uint32 seq = 1;
  D1Mode mode = 2;
  D1ModeResult result = 3;
  string message = 4;
}
```

```js
const ack = D1Protocol.decodeModeAck(event.data);
if (!ack) return;

console.log(ack.seq, ack.mode, ack.result, ack.message);
```

| Result | Meaning |
| ---: | --- |
| `1` | Command accepted |
| `2` | Bridge not ready |
| `3` | Learning service offline |
| `4` | Robot busy |
| `5` | Rate limited |
| `6` | Duplicate sequence |

Wait no longer than three seconds for a matching `seq`. A timeout is an unknown result; do not automatically send the physical command again.

## 7. Display the Camera

```html
<img
  id="d1-video"
  src="http://192.168.50.1:8080/stream?topic=/image_raw"
  alt="D1 live camera"
/>
```

```css
#d1-video {
  display: block;
  width: 100%;
  height: auto;
  object-fit: contain;
  background: #000;
}
```

Retry after a stream error:

```js
const video = document.querySelector("#d1-video");
const videoUrl =
  "http://192.168.50.1:8080/stream?topic=/image_raw";

video.addEventListener("error", () => {
  window.setTimeout(() => {
    video.src = `${videoUrl}&retry=${Date.now()}`;
  }, 2000);
});
```

MJPEG does not require `/subImage`. Use `/subImage` only when decoding image protobuf frames from `/ws/robot`.

## 8. HTTP Helper

```js
const apiBase = "http://192.168.50.1:8081";

async function d1Request(path, { method = "GET", body } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: body
      ? { "Content-Type": "application/json; charset=utf-8" }
      : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status !== 200) {
    throw new Error(`${method} ${path}: HTTP ${response.status}`);
  }

  const type = response.headers.get("content-type") || "";
  return type.includes("application/json")
    ? response.json()
    : response.text();
}
```

### Navigation

```js
await d1Request("/robot/nav_goal", {
  method: "POST",
  body: { x: 1.0, y: 0.5, yaw: 0, roll: 0, pitch: 0 },
});
```

### Set Initial Pose

```js
await d1Request("/robot/initial_pose", {
  method: "POST",
  body: { x: 0, y: 0, yaw: 0, roll: 0, pitch: 0 },
});
```

### Cancel Navigation

```js
await d1Request("/robot/cancel_nav", { method: "POST" });
```

### Map APIs

| Request | Purpose |
| --- | --- |
| `GET /getAllMapList` | List maps |
| `GET /currentMap` | Get current map |
| `GET /setCurrentMap?name=<name>` | Switch map |
| `GET /deleteMap?map_name=<name>` | Delete map |
| `GET /getTopologyMap` | Load topology |

Always encode query values:

```js
const query = new URLSearchParams({ name: selectedMap });
await d1Request(`/setCurrentMap?${query}`);
```

## 9. Add Velocity or a Joystick

Velocity uses `ClientRobotMessage` field `2`:

```proto
message Twist {
  Vector3 linear = 1;
  Vector3 angular = 2;
}
```

| Value | Meaning |
| --- | --- |
| `linear.x` / `vx` | Forward/backward speed in m/s |
| `linear.y` / `vy` | Lateral speed in m/s |
| `angular.z` / `vw` | Rotation speed in rad/s |

Original joystick conversion:

```text
vx = MaxVx × left-stick Y
vy = MaxVy × -left-stick X
vw = MaxVw × -right-stick X
```

Send the newest velocity every `20 ms` while manual control is active. Send zero and clear motion when input is released, the page becomes hidden, focus is lost, the controller disconnects, or the WebSocket closes.

## 10. Incoming Robot Data

| Field | Data |
| ---: | --- |
| `1` | Image frame |
| `3` | Heartbeat |
| `4` | Laser scan |
| `5` | Robot pose |
| `6` | Local path |
| `7` | Global path |
| `8` | Trace path |
| `9` | Odometry |
| `10` | Battery |
| `11` | Footprint |
| `12` | Local costmap |
| `13` | Global costmap |
| `14` | Point cloud |
| `15` | Diagnostics |
| `17` | Navigation status |
| `18` | Transform response |
| `19` | GPS compatibility field |
| `20` | Mode ACK |

The demo decodes only field `20`. Full telemetry requires the official backend `.proto` files and generated JavaScript/TypeScript types.

## 11. Common Problems

| Problem | Check |
| --- | --- |
| Cannot reach `192.168.50.1` | Connect to D1 Wi-Fi and disable conflicting VPN/mobile routes. |
| WebSocket never opens | Check port `8081`, `/ws/robot`, and HTTP/HTTPS scheme. |
| Mixed-content error | Use HTTP on the isolated hotspot or provide HTTPS/WSS for every endpoint. |
| `fetch()` blocked | Configure backend CORS for the controller origin. |
| Video broken | Check port `8080` and `/image_raw`. |
| Video works but controls do not | Diagnose ports `8080` and `8081` independently. |
| No ACK | Verify binary protobuf, mode, sequence, and timeout. |
| Gamepad missing | Press a gamepad button before calling `navigator.getGamepads()`. |

## 12. Minimum Safety Rules

- Browser controls are not safety-rated.
- Keep access to the physical emergency stop.
- Validate and clamp every motion value.
- Send zero velocity when input becomes unavailable.
- Disable controls immediately after a connection failure.
- Never store disconnected physical commands for later replay.
- An accepted ACK does not prove that robot movement has completed.

## 13. Before Testing on a Robot

```text
[ ] Connected to the correct D1 Wi-Fi
[ ] Correct host and ports
[ ] Controls disabled until WebSocket OPEN
[ ] Stand/Crouch/Learning fixtures tested
[ ] Three-second ACK timeout implemented
[ ] Zero velocity tested before non-zero motion
[ ] Release, blur, hidden-page, and disconnect stops tested
[ ] MJPEG video tested independently
[ ] Physical emergency stop available
```
