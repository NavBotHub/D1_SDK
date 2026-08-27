# NavBot D1 Wi-Fi Control Protocol

| Document attribute | Value |
| --- | --- |
| Document ID | `NBD1-WIFI-CP` |
| Protocol version | `1.0.0` |
| Document status | Engineering Release |
| Applicable hardware | NavBot D1 quadruped robot and D1 variants exposing the same frontend service contract |
| Default deployment | D1 Wi-Fi hotspot, robot host `192.168.50.1` |
| Intended audience | Web-controller developers, robot integration engineers, verification engineers, and maintainers |

## 1. Document Control

### 1.1 Applicability and Compatibility Statement

This specification applies to a NavBot D1 backend that implements the endpoints and protobuf field assignments stated below. No robot firmware version identifier is available in the frontend repository; therefore, compatibility **shall** be verified against the target robot build before deployment. Hardware variants **may** use this specification only when their backend contract is wire-compatible.

The hotspot SSID, hotspot password, maximum motion limits, TLS certificates, and backend firmware version are deployment properties and are not defined by this protocol.

### 1.2 Normative Language

The terms **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** express requirement strength. Safety statements take precedence over convenience or retry behaviour.

### 1.3 Terminology and Abbreviations

| Term | Definition |
| --- | --- |
| ACK | Acknowledgement returned for a D1 mode command. |
| API | Application Programming Interface. |
| CORS | Cross-Origin Resource Sharing. |
| D1 | NavBot D1 quadruped robot. |
| HTTP / HTTPS | Hypertext Transfer Protocol, plain / TLS protected. |
| MJPEG | Motion JPEG transported as a multipart HTTP response. |
| Protobuf | Protocol Buffers binary wire encoding. |
| RL | Reinforcement Learning operating mode. |
| SSID | Wi-Fi network name. |
| TLS | Transport Layer Security. |
| UI | User Interface. |
| WS / WSS | WebSocket, plain / TLS protected. |

### 1.4 Reference Documents

| Reference | Purpose |
| --- | --- |
| [Simple Demo Extension and Integration Guide](CONTROL_PROTOCOL.md) | Correct companion document for adding original-project controls and video to the demo. |
| [`ws_channel.dart`](../app/lib/provider/ws_channel.dart) | Authoritative frontend behaviour for WebSocket lifecycle, velocity, mode ACKs, and telemetry. |
| [`d1_mode_protocol.dart`](../app/lib/provider/d1_mode_protocol.dart) | Current mode-command and ACK wire codec. |
| [`http_channel.dart`](../app/lib/provider/http_channel.dart) | Current HTTP paths, methods, bodies, and query parameters. |
| [`gamepad_widget.dart`](../app/lib/page/gamepad_widget.dart) | Current input mapping and joystick conversion. |
| [`robot_message.pb.dart`](../app/lib/protobuf/robot_message.pb.dart) | Generated Dart protobuf types bundled with the frontend. |
| RFC 6455 | WebSocket protocol baseline. |
| RFC 8259 | JSON data-interchange baseline for HTTP bodies. |
| Protocol Buffers Encoding Guide | Binary field-key, varint, fixed64, and length-delimited encoding rules. |

This document defines the Wi-Fi network contract used by a browser-based NavBot D1 controller. It focuses on how a client reaches the D1 over its hotspot, which transport is used for each feature, and how control messages move between the browser and robot.

The companion integration link above intentionally targets `CONTROL_PROTOCOL.md`; it does not point back to this Wi-Fi specification.

## 2. Scope

This protocol covers:

- joining the D1 Wi-Fi network;
- locating the D1 service on the hotspot;
- opening and maintaining the robot WebSocket;
- sending D1 posture and learning commands;
- sending manual velocity commands;
- calling navigation and map HTTP APIs;
- displaying the MJPEG camera stream;
- handling disconnects, timeouts, browser security restrictions, and safe stops.

It does not define the hotspot SSID or password. Those values depend on the robot configuration and must be supplied with the robot.

## 3. Network Layer Specification

### 3.1 Wi-Fi Association

The browser cannot select or join a Wi-Fi network programmatically. The user must connect the phone, tablet, handheld, or computer to the D1 hotspot through the operating-system Wi-Fi settings.

```text
User opens system Wi-Fi settings
  → selects the D1 hotspot SSID
  → enters the hotspot password if required
  → device receives an address on the D1 network
  → browser opens the controller page
  → page connects to 192.168.50.1
```

The original Android application also opens the system Wi-Fi settings; it does not silently join a named SSID.

Textual association state machine:

```text
UNASSOCIATED
  → [user selects D1 SSID] ASSOCIATING
ASSOCIATING
  → [IP configuration succeeds] ASSOCIATED
  → [authentication/DHCP fails] UNASSOCIATED
ASSOCIATED
  → [192.168.50.1 reachable] SERVICE_DISCOVERY
  → [Wi-Fi route lost] UNASSOCIATED
SERVICE_DISCOVERY
  → [control endpoint reachable] NETWORK_READY
  → [route exists but service unavailable] DEGRADED
NETWORK_READY
  → [route or service lost] DEGRADED
DEGRADED
  → [service recovers] NETWORK_READY
  → [Wi-Fi route lost] UNASSOCIATED
```

The client **MUST NOT** enable motion-producing controls before `NETWORK_READY`. Wi-Fi association alone does not prove that the robot control service is operational.

### 3.2 Default Network Parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| D1 host | `192.168.50.1` | Robot gateway/service address on the hotspot |
| Control port | `8081` | HTTP API and robot WebSocket |
| Video port | `8080` | MJPEG camera service |
| Robot WebSocket path | `/ws/robot` | Binary control and telemetry channel |
| SSH WebSocket path | `/ws/ssh` | Optional SSH tunnel |
| Default image topic | `/image_raw` | Camera topic requested from the video service |

Default endpoints:

```text
Robot WebSocket: ws://192.168.50.1:8081/ws/robot
HTTP API base:   http://192.168.50.1:8081
MJPEG video:     http://192.168.50.1:8080/stream?topic=/image_raw
SSH tunnel:      ws://192.168.50.1:8081/ws/ssh
```

The Simple Demo accepts an alternative control host and port through its page URL:

```text
http://localhost:8000/?host=<D1-IP>&port=<control-port>
```

### 3.3 Port and Path Access Constraints

| Port | Path | Method / frame | Direction | Access requirement |
| ---: | --- | --- | --- | --- |
| `8081` | `/ws/robot` | WebSocket binary | Bidirectional | One active socket per controller instance; backend concurrency limits are deployment-defined; binary protobuf only. |
| `8081` | `/ws/ssh` | WebSocket | Bidirectional | Optional; credentials and tunnel semantics are backend-defined; do not expose publicly. |
| `8081` | `/robot/*` | HTTP POST | Client → robot | JSON where specified; current compatibility profile expects HTTP `200`. |
| `8081` | `/api/*` | HTTP GET/POST | Bidirectional request/response | CORS must permit the controller origin for browser use. |
| `8081` | map endpoints | HTTP GET | Bidirectional request/response | Query values must be URL-encoded. |
| `8080` | `/stream` | HTTP GET | Robot → client | Multipart MJPEG; `topic` query is required and must be URL-encoded. |

Unless an authenticated reverse proxy is deployed, these interfaces **MUST** be reachable only from a trusted, isolated robot-control network.

### 3.4 Encryption and Endpoint Mapping

| Controller origin | Control API | Robot socket | Video | Conformance condition |
| --- | --- | --- | --- | --- |
| `http://` on trusted D1 hotspot | `http://<host>:8081` | `ws://<host>:8081/ws/robot` | `http://<host>:8080/stream?...` | Supported default deployment. |
| `https://` with TLS-capable robot/proxy | `https://<host>` | `wss://<host>/ws/robot` | `https://<host>/stream?...` | Certificate must be trusted; proxy must preserve WebSocket upgrade and streaming. |
| `https://` with default plain D1 endpoints | Blocked | Blocked | Blocked | Non-conformant mixed-content deployment. |
| `file://` page | Browser-dependent | `ws://` may work | HTTP image may work | Not recommended; use a local HTTP server. |

The client **MUST NOT** silently downgrade from HTTPS/WSS to HTTP/WS. When TLS is required but unavailable, connection shall fail closed with a visible diagnostic.

## 4. Transport Layer and Encoding Specification

| Feature | Transport | Encoding |
| --- | --- | --- |
| D1 posture/learning commands | `/ws/robot` binary frame | Protobuf wire format |
| Manual velocity | `/ws/robot` binary frame | Protobuf wire format |
| Robot telemetry | `/ws/robot` binary frame | Protobuf wire format |
| Navigation and relocation | HTTP POST | JSON |
| Map and settings APIs | HTTP GET/POST | JSON/query parameters |
| Simple live video | HTTP port `8080` | Multipart MJPEG |
| WebSocket image subscription | HTTP `/subImage` plus `/ws/robot` | JSON request plus protobuf frames |
| SSH tunnel | `/ws/ssh` | Backend tunnel protocol |

Do not send JSON text through `/ws/robot`. Control messages on that socket are binary protobuf wire frames.

### 4.1 Mandatory Encoding Rules

1. A client **MUST** set `WebSocket.binaryType = "arraybuffer"` or perform an equivalent binary conversion.
2. A client **MUST NOT** send JSON strings, UTF-8 command names, base64 text, or ad-hoc byte layouts over `/ws/robot`.
3. Protobuf field numbers and wire types **MUST NOT** be renumbered or repurposed.
4. HTTP JSON bodies **MUST** use `Content-Type: application/json; charset=utf-8`.
5. Query parameters **MUST** be percent-encoded using `URLSearchParams` or an equivalent encoder.
6. Unknown protobuf fields **SHOULD** be skipped according to their wire type to preserve forward compatibility.
7. Malformed or truncated binary frames **MUST** be rejected without executing a control action.

### 4.2 Protobuf Prerequisites

The Simple Demo contains a narrowly scoped handwritten codec for D1 mode commands and field-20 ACKs. A production controller that uses velocity or full telemetry **SHOULD** use generated JavaScript/TypeScript protobuf types from the authoritative backend `.proto` sources.

Before generating a full codec, the development team **MUST** obtain and version-lock:

- the exact `.proto` files used by the deployed D1 backend;
- the protobuf compiler/runtime version;
- the field assignments for compatibility extensions `19` and `20`;
- a binary fixture set produced by the robot/backend;
- a compatibility matrix relating backend firmware to protocol version.

The frontend repository contains generated Dart files, not the authoritative `.proto` sources. Generated Dart declarations may be used for inspection, but **MUST NOT** be treated as a substitute for backend-controlled schemas in a new production implementation.

### 4.3 Payload Validation Boundary

All input is untrusted at the transport boundary. A conforming client shall validate frame type, buffer length, protobuf wire type, numeric finiteness, enum range, sequence correlation, HTTP status, and response content type before updating control state.

## 5. Robot WebSocket Lifecycle

### Connect

```js
const host = "192.168.50.1";
const controlPort = 8081;
const socket = new WebSocket(`ws://${host}:${controlPort}/ws/robot`);
socket.binaryType = "arraybuffer";
```

No application-level login or handshake is performed by the current frontend. A successful WebSocket `open` event means the transport is available; it does not prove that every robot subsystem is ready.

### 5.1 Normative State Machine

```text
DISCONNECTED
  → [connect requested] CONNECTING
CONNECTING
  → [WebSocket open within 15 s] CONNECTED
  → [error or 15 s timeout] RECONNECT_WAIT
CONNECTED
  → [valid robot frame received] CONNECTED; refresh last-message timestamp
  → [no robot frame for 10 s] STALE
  → [error/close] RECONNECT_WAIT
STALE
  → [close active socket; clear control state] RECONNECT_WAIT
RECONNECT_WAIT
  → [retry delay expires and network is eligible] CONNECTING
  → [controller disposed/page closed] DISCONNECTED
```

Only `CONNECTED` permits command transmission. Entry into `STALE`, `RECONNECT_WAIT`, or `DISCONNECTED` **MUST** disable controls, invalidate all pending ACK waits, and clear non-zero velocity state.

### Connection States

| Browser event/state | Client action |
| --- | --- |
| `CONNECTING` | Keep controls disabled. |
| `open` / `OPEN` | Enable controls and begin receiving binary frames. |
| `message` | Decode the binary `RobotMessage` envelope. |
| `error` | Close the failed socket and wait before reconnecting. |
| `close` / `CLOSED` | Disable controls, clear pending ACKs, clear motion state, then reconnect. |

### 5.2 Timing and Retry Requirements

| Parameter | Required/default value | Rule |
| --- | ---: | --- |
| WebSocket handshake timeout | `15 s` | Abort the attempt and enter `RECONNECT_WAIT`. |
| Robot-message stale threshold | `10 s` | Recreate the socket; do not continue transmitting blindly. |
| Simple Demo reconnect delay | `2 s` | Only one timer and one connection attempt may exist. |
| Original Flutter reconnect check | `5 s` | Reference behaviour; implementations may use bounded backoff. |
| Mode ACK timeout | `3 s` | Applies per mode command; timeout is an unknown outcome. |

Repeated reconnects **SHOULD** use bounded exponential backoff with jitter in production, for example `2 s`, `4 s`, `8 s`, up to `30 s`. A successful, healthy connection may reset the backoff. Commands queued before or during disconnect **MUST NOT** be replayed.

### Reconnect

Use one reconnect timer to prevent concurrent connection attempts:

```js
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}
```

On disconnect, reject every pending mode request and discard stale velocity values.

### 5.3 Connection Sequence

```text
Client                         D1 backend
  |--- HTTP/WS reachability ----->|
  |--- WebSocket Upgrade -------->|
  |<-- 101 Switching Protocols ---|
  |    CONNECTED; enable UI        |
  |<-- binary RobotMessage --------|
  |    refresh liveness timer      |
```

No physical command shall be transmitted as an automatic consequence of reconnecting.

## 6. D1 Mode Commands

The client sends `D1ModeCommand` as field `8` of `ClientRobotMessage`:

```proto
message D1ModeCommand {
  uint32 seq = 1;
  D1Mode mode = 2;
  int64 client_time_ms = 3;
}
```

### 6.1 Command Field Constraints

| Field | Presence | Type/range | Validation rule |
| --- | --- | --- | --- |
| `seq` | REQUIRED | `1..4294967295` | Must be non-zero and not reused while pending. Wrap from max to `1`. |
| `mode` | REQUIRED | `1..4` for commands | `0` is unspecified and must not be transmitted as an executable command. Unknown values must be rejected. |
| `client_time_ms` | REQUIRED | Non-negative signed 64-bit integer | Use current Unix milliseconds. JavaScript implementations must avoid loss beyond `Number.MAX_SAFE_INTEGER` or encode with `BigInt`. |

The nested command **MUST** be encoded as `ClientRobotMessage` field `8`, wire type `2`. Integer fields use wire type `0`.

| Mode code | Meaning |
| ---: | --- |
| `0` | Unspecified |
| `1` | Stand |
| `2` | Lie down / Crouch Down in the Simple Demo |
| `3` | Enter reinforcement learning / Start Learning |
| `4` | Exit reinforcement learning / Stop Learning |

Required client behaviour:

1. Allocate a unique, non-zero 32-bit `seq`.
2. Set `client_time_ms` to the current Unix timestamp in milliseconds.
3. Send one binary command frame.
4. Wait up to three seconds for `RobotMessage.d1_mode_ack`, field `20`.
5. Match the ACK by `seq`.
6. Report acceptance or the returned rejection reason.

### 6.2 Command State Machine and Sequence

```text
IDLE
  → [validated user action] ENCODING
ENCODING
  → [encode succeeds and socket CONNECTED] AWAITING_ACK
  → [validation/encoding fails] FAILED
AWAITING_ACK
  → [same seq, result 1] ACCEPTED
  → [same seq, result 0 or 2..6] REJECTED
  → [3 s expires] TIMED_OUT
  → [socket disconnects] ABORTED
ACCEPTED / REJECTED / TIMED_OUT / ABORTED / FAILED
  → [result displayed and pending entry cleared] IDLE
```

```text
Client                                      D1 backend
  |--- D1ModeCommand(seq=N, mode=M) ---------->|
  |                 wait ≤ 3 s                 |
  |<-- D1ModeAck(seq=N, mode=M, result=R) -----|
  |--- correlate N; display R; clear pending --|
```

A mismatched or unknown `seq` **MUST NOT** complete another pending command. The current client does not automatically retry a timed-out physical mode command because the robot may already have accepted it. Retrying requires a new sequence and an explicit user decision or application policy that accounts for duplicate physical actions.

Known stand fixture (`seq = 1`, timestamp `0`):

```text
42 06 08 01 10 01 18 00
```

## 7. Mode Acknowledgements

```proto
message D1ModeAck {
  uint32 seq = 1;
  D1Mode mode = 2;
  D1ModeResult result = 3;
  string message = 4;
}
```

| ACK field | Presence | Accepted value | Client rule |
| --- | --- | --- | --- |
| `seq` | REQUIRED for correlation | `1..4294967295` | Ignore as unsolicited if no matching request is pending. |
| `mode` | REQUIRED | `0..4` | For a matched ACK, verify it is compatible with the requested mode. |
| `result` | REQUIRED | `0..6` | Unknown values are protocol errors and shall not be treated as success. |
| `message` | OPTIONAL | Valid UTF-8 string | Display/log as diagnostic text; never execute or interpret as code. |

| Result | Meaning |
| ---: | --- |
| `0` | Unspecified result |
| `1` | Command accepted and sent to the bridge |
| `2` | Bridge not ready |
| `3` | Reinforcement-learning service offline |
| `4` | Robot busy |
| `5` | Rate limited |
| `6` | Duplicate sequence |

An accepted ACK does not confirm that physical movement has completed.

The client **MUST** remove the pending entry after acceptance, rejection, timeout, or disconnect. Duplicate ACKs may be logged but shall have no control effect.

## 8. Manual Velocity Control

Velocity is field `2` of `ClientRobotMessage`:

```proto
message Twist {
  Vector3 linear = 1;
  Vector3 angular = 2;
}
```

| Field | Meaning | Unit |
| --- | --- | --- |
| `linear.x` | Forward/backward velocity (`vx`) | m/s |
| `linear.y` | Lateral velocity (`vy`) | m/s |
| `linear.z` | Always zero | m/s |
| `angular.x` | Always zero | rad/s |
| `angular.y` | Always zero | rad/s |
| `angular.z` | Yaw velocity (`vw`) | rad/s |

### 8.1 Motion Field Constraints

| Value | Presence | Validation |
| --- | --- | --- |
| `vx` | Required semantic value | Finite IEEE-754 double; clamp to configured `[-MaxVx, +MaxVx]`. |
| `vy` | Required semantic value | Finite IEEE-754 double; clamp to configured `[-MaxVy, +MaxVy]`. |
| `vw` | Required semantic value | Finite IEEE-754 double; clamp to configured `[-MaxVw, +MaxVw]`. |
| `linear.z` | Required semantic value | Exactly `0.0`; protobuf may omit the scalar because zero is the default. |
| `angular.x`, `angular.y` | Required semantic values | Exactly `0.0`; protobuf may omit the scalars because zero is the default. |

`MaxVx`, `MaxVy`, and `MaxVw` are deployment settings. This document does not invent universal limits; the controller **MUST** obtain approved limits for the target D1 and shall fail closed if safe limits are unavailable. `NaN`, positive infinity, and negative infinity **MUST** be converted to zero or rejected before encoding.

### 8.2 Motion-Control State Machine

```text
INACTIVE
  → [manual control enabled; socket CONNECTED] ARMED_ZERO
ARMED_ZERO
  → [validated non-zero input] ACTIVE
  → [manual control disabled] INACTIVE
ACTIVE
  → [input update] ACTIVE; transmit latest snapshot at 50 Hz
  → [release/blur/hidden/controller loss] STOPPING
  → [socket loss] BLOCKED
STOPPING
  → [zero frame issued; local snapshot cleared] ARMED_ZERO or INACTIVE
BLOCKED
  → [local snapshot cleared; controls disabled] INACTIVE
```

The latest input snapshot replaces older input; velocity frames **MUST NOT** be queued for later replay. A reconnect starts in `INACTIVE` or `ARMED_ZERO`, never `ACTIVE`.

The original frontend sends fresh velocity frames every `20 ms` (`50 Hz`). A Wi-Fi controller must send a zero frame when:

- the joystick or key is released;
- manual control is disabled;
- the window loses focus;
- the document becomes hidden;
- the controller changes or disconnects;
- the WebSocket is closing;
- the client-side stop latch is active.

The browser's zero-velocity command is not a physical emergency stop.

### 8.3 Motion Timing and Reliability

| Item | Requirement |
| --- | --- |
| Nominal transmit period | `20 ms` (`50 Hz`) while manual control is active. |
| Input freshness | Only the latest validated snapshot may be sent. |
| Stop latency | Send zero immediately on a detected stop condition; do not wait for the next non-zero input. |
| Retry | Do not retransmit historical non-zero frames after socket recovery. |
| Browser backgrounding | Assume timers may be throttled; issue zero from `visibilitychange` before suspension where possible. |
| Delivery semantics | WebSocket write means bytes were handed to the transport, not that motion occurred. |

## 9. HTTP Control Endpoints

HTTP base:

```text
http://192.168.50.1:8081
```

| Request | Body/query | Meaning |
| --- | --- | --- |
| `POST /robot/nav_goal` | `{"x":n,"y":n,"yaw":n,"roll":n,"pitch":n}` | Send navigation destination |
| `POST /robot/initial_pose` | Same pose fields | Set estimated current pose |
| `POST /robot/cancel_nav` | No body | Cancel navigation |
| `POST /robot/action_cmd` | `{"data":"..."}` | Backend-defined compatibility action |
| `GET /api/settings` | — | Load settings |
| `POST /api/settings` | Settings JSON | Save settings |
| `GET /api/tf` | `target_frame`, `source_frame` | Query transform |
| `POST /subImage` | `{"topic":"/image_raw","subscribe":true}` | Start WebSocket image subscription |

Map endpoints:

| Request | Meaning |
| --- | --- |
| `GET /getAllMapList` | List map names |
| `GET /currentMap` | Get selected map |
| `GET /setCurrentMap?name=<name>` | Select map |
| `GET /deleteMap?map_name=<name>` | Delete map |
| `GET /getTopologyMap` | Get topology data |
| `GET /saveMapEdit?...` | Save topology and obstacle edits |

Send JSON with:

```text
Content-Type: application/json; charset=utf-8
```

Check the HTTP status before treating a request as successful. The current original client requires status `200` for the endpoints listed in this profile.

### 9.1 HTTP Request State Machine

```text
IDLE
  → [validated request created] REQUESTING
REQUESTING
  → [HTTP 200 and valid response] COMPLETED
  → [network error, timeout, status other than 200, invalid body] FAILED
COMPLETED / FAILED
  → [result consumed] IDLE
```

An HTTP request that times out has an unknown server-side outcome. Mutating operations **MUST NOT** be retried automatically unless the endpoint is known to be idempotent. The current frontend does not define an HTTP timeout; a production browser controller **SHOULD** apply an application timeout selected for the deployment and expose it as configuration.

### 9.2 HTTP Parameter Constraints

| Endpoint/field | Presence | Validation rule |
| --- | --- | --- |
| `/robot/nav_goal`: `x`, `y`, `yaw` | REQUIRED | Finite JSON numbers; validated against the active map and approved operating area. |
| `/robot/nav_goal`: `roll`, `pitch` | REQUIRED by current request body | Finite JSON numbers; normally `0` for 2D navigation. |
| `/robot/initial_pose`: pose fields | REQUIRED | Same numeric validation; values describe estimated current pose. |
| `/robot/action_cmd`: `data` | REQUIRED | Non-empty string supported by the deployed backend; no shell interpretation by the browser. |
| `/subImage`: `topic` | REQUIRED | Non-empty topic string; current default `/image_raw`; recommended to begin with `/`. |
| `/subImage`: `subscribe` | REQUIRED | JSON boolean only. |
| `/api/tf`: frame names | REQUIRED | Non-empty strings encoded as query parameters. |
| Map name | REQUIRED where used | Non-empty string; percent-encode; reject control characters. |
| Settings body | REQUIRED for POST | JSON object whose schema is compatible with the deployed backend. |

HTTP success means transport/API acceptance. Navigation and relocation completion **MUST** be determined from robot state/telemetry, not solely from HTTP `200`.

### 9.3 HTTP Sequence Definitions

Navigation:

```text
Client → validate pose → POST /robot/nav_goal
Robot  → HTTP status/body
Client → if 200, mark request accepted
Client → observe nav_status for execution outcome
```

Image subscription:

```text
Client → POST /subImage {topic, subscribe:true}
Robot  → HTTP 200
Robot  → RobotMessage.image frames on /ws/robot
Client → POST /subImage {topic, subscribe:false} before changing topic/closing when possible
```

## 10. Wi-Fi Video Stream

The simplest live-video path is:

```text
http://192.168.50.1:8080/stream?topic=/image_raw
```

Minimal integration:

```html
<img
  id="d1-video"
  src="http://192.168.50.1:8080/stream?topic=/image_raw"
  alt="D1 live camera"
/>
```

The response remains open as multipart MJPEG. The browser decodes each JPEG frame and updates the image automatically.

Configurable URL:

```js
const host = "192.168.50.1";
const videoPort = 8080;
const topic = "/image_raw";
const url =
  `http://${host}:${videoPort}/stream?topic=${encodeURIComponent(topic)}`;
document.querySelector("#d1-video").src = url;
```

MJPEG display does not require `/subImage`. Use `/subImage` only when the application intends to decode `RobotMessage.image` binary frames itself.

### 10.1 Video State Machine

```text
IDLE
  → [stream requested] CONNECTING
CONNECTING
  → [first decodable frame] STREAMING
  → [load error or application timeout] RETRY_WAIT
STREAMING
  → [image error/network loss] RETRY_WAIT
RETRY_WAIT
  → [bounded delay expires] CONNECTING with cache-busting URL
  → [retry limit/policy reached] FAILED
FAILED
  → [explicit user/application retry] CONNECTING
```

MJPEG has no application ACK. The first decoded image is the readiness signal. A client **SHOULD** show connection state separately from robot-control state because ports `8080` and `8081` may fail independently.

### 10.2 Video Timing, Retry, and Validation

| Item | Requirement |
| --- | --- |
| Host | Non-empty valid host; normally the same D1 host as control. |
| Port | Integer `1..65535`; default `8080`. |
| Topic | Non-empty and URL-encoded; default `/image_raw`. |
| Retry delay | `2 s` in the integration example; only one retry timer per image element. |
| Cache control | Add a changing query value on retry to avoid a cached failure. |
| Retry bound | Production clients should use bounded backoff and allow the user to stop retries. |
| Resource cleanup | Clear retry timers and remove/replace the image source when the view is disposed. |

Video failure **MUST NOT** disable an otherwise healthy control connection unless the application explicitly requires video for safe operation. Conversely, visible video **MUST NOT** be treated as proof that control port `8081` is healthy.

## 11. Incoming Robot Data Fields

| Field | Payload |
| ---: | --- |
| `1` | Image frame |
| `3` | Heartbeat |
| `4` | Laser scan |
| `5` | Robot pose in map |
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
| `20` | D1 mode ACK |

The Simple Demo decodes only field `20`. Full telemetry integration requires authoritative protobuf schemas and generated JavaScript/TypeScript types.

## 12. Safety, Reliability, and Browser Compliance

### 12.1 Non-Safety-Rated Control Declaration

All commands originating from this browser controller are **non-safety-rated**. The webpage, browser event loop, Wi-Fi link, WebSocket, HTTP APIs, and client-side stop latch are not certified safety functions. They may be delayed, throttled, disconnected, suspended, or terminated without deterministic execution.

### 12.2 Physical Emergency Stop Boundary

| Mechanism | Responsibility and limitation |
| --- | --- |
| Physical emergency stop | Primary safety mechanism. Must independently remove or inhibit hazardous motion according to the robot's safety design. |
| Robot-side safety controller | Enforces hardware limits, operating modes, watchdogs, and safe-state transitions. |
| Browser zero-velocity command | Operational stop request only; delivery and execution are not guaranteed. |
| Stand/Lie Down/RL commands | Mode/posture requests only; never emergency-stop substitutes. |
| Connection indicator | Communication status only; not proof of robot readiness or safe state. |

Loss of the webpage or Wi-Fi **MUST NOT** be the only mechanism relied upon to stop hazardous motion. Robot-side watchdog behaviour is outside this frontend contract and must be verified separately.

### 12.3 Browser and Network Restrictions

| Situation | Effect / solution |
| --- | --- |
| Page served through HTTP | Can use `ws://` and HTTP MJPEG on the trusted hotspot. |
| Page served through HTTPS | Browser expects `wss://` and HTTPS video; plain endpoints are mixed content. |
| D1 endpoint lacks CORS | JavaScript HTTP `fetch()` may be blocked even when `<img>` display works. |
| Device is not on D1 Wi-Fi | `192.168.50.1` is normally unreachable. |
| Client uses mobile data/VPN simultaneously | Routing may bypass the hotspot; disable conflicting routes if necessary. |
| Browser tab is backgrounded | Timers can be throttled; send zero before losing visibility. |

Recommended browser deployment solutions:

1. **Trusted hotspot profile:** serve the controller through local `http://` and use the default HTTP/WS endpoints only on the isolated D1 network.
2. **Same-origin TLS reverse proxy:** expose the controller, API, WebSocket, and MJPEG stream under one trusted HTTPS origin; forward WebSocket upgrades and disable proxy buffering for MJPEG.
3. **Explicit CORS profile:** configure the backend to allow only the approved controller origin, required methods, and `Content-Type` header. Avoid wildcard origins when credentials or privileged interfaces are present.
4. **No silent fallback:** if certificate, CORS, or mixed-content validation fails, show a diagnostic and keep controls disabled.

### 12.4 Mandatory Disconnect Behaviour

On error, close, stale timeout, page unload, controller loss, or manual-control shutdown, the client **MUST**:

1. disable all motion-producing UI;
2. clear the local velocity snapshot;
3. attempt one immediate zero-velocity frame only if the socket is still open;
4. reject/clear all pending ACK promises;
5. cancel command and video retry timers owned by the disposed view;
6. discard every unsent or queued physical command;
7. create a fresh socket for reconnection;
8. require fresh user input before any non-zero motion resumes.

The client **MUST NOT** cache physical commands offline, persist them in browser storage, or replay them after reconnection.

## 13. Standard Error and Failure Handling

### 13.1 Wire-Level ACK Results

The authoritative mode result values are defined in Section 7. Only result `1` is accepted. Values `0`, `2..6`, and unknown values are non-success outcomes.

### 13.2 Client Diagnostic Codes

The following identifiers are recommended client-side diagnostics. They are not additional robot wire-protocol result values.

| Code | Condition | Required client response |
| --- | --- | --- |
| `D1-NET-001` | D1 network/host unreachable | Disable controls; instruct user to verify hotspot and routing. |
| `D1-WS-001` | WebSocket handshake timeout | Close attempt; enter reconnect wait. |
| `D1-WS-002` | WebSocket closed/error | Clear pending state and motion; reconnect with backoff. |
| `D1-WS-003` | Robot message stream stale | Recreate socket; prohibit command replay. |
| `D1-PB-001` | Malformed protobuf frame | Drop frame; log bounded diagnostic; do not execute. |
| `D1-CMD-001` | Local command validation failure | Reject before transmission. |
| `D1-CMD-002` | Mode ACK timeout | Report unknown outcome; do not auto-retry. |
| `D1-CMD-003` | ACK sequence mismatch | Ignore for pending completion; record diagnostic. |
| `D1-HTTP-001` | Network/timeout failure | Report unknown outcome for mutations. |
| `D1-HTTP-002` | HTTP status other than `200` | Report path and status; do not mark successful. |
| `D1-HTTP-003` | Invalid response type/body | Reject response; preserve last known valid state. |
| `D1-VID-001` | MJPEG load/stream failure | Preserve control state; retry video independently. |
| `D1-SEC-001` | Mixed-content or certificate block | Fail closed; require a valid HTTP/WS or HTTPS/WSS deployment pair. |

| Failure | Required response |
| --- | --- |
| WebSocket handshake failure | Disable controls and retry with backoff. |
| WebSocket closes | Clear pending commands and velocity state. |
| Mode ACK timeout | Show an unknown/timeout result; do not assume success. |
| HTTP status other than `200` | Show the endpoint and status code. |
| MJPEG `error` event | Show a placeholder and retry with a cache-busting query. |
| No robot messages for an application-defined stale period | Close and recreate the socket. |

Do not queue physical commands while disconnected and replay them after reconnecting.

### 13.3 Logging Requirements

Logs **SHOULD** contain timestamp, endpoint, connection generation, sequence, mode, result, HTTP status, and diagnostic code where applicable. Logs **MUST NOT** contain Wi-Fi passwords, SSH credentials, session secrets, or unrestricted high-frequency velocity history. Repeated malformed frames and reconnect errors should be rate-limited to prevent resource exhaustion.

## 14. Compatibility Risks and Troubleshooting

### 14.1 Known Compatibility Risks

| Risk | Symptom | Resolution |
| --- | --- | --- |
| Device not joined to D1 hotspot | `192.168.50.1` unreachable | Join D1 SSID in OS settings; verify assigned route. |
| Mobile data or VPN preferred | Browser times out despite Wi-Fi connection | Disable conflicting VPN/mobile route or configure routing policy. |
| HTTPS page with plain robot endpoints | Mixed-content error; WS/video blocked | Serve demo over HTTP on isolated hotspot or deploy trusted TLS reverse proxy. |
| Untrusted/self-signed certificate | HTTPS/WSS rejected | Install an appropriate trusted certificate; do not bypass browser warnings in production. |
| Backend CORS not configured | `fetch()` blocked while `<img>` may work | Allow the exact controller origin, methods, and headers on port `8081`. |
| WebSocket proxy misconfiguration | Upgrade fails or closes immediately | Preserve `Upgrade`/`Connection` headers and binary frames. |
| Wrong protobuf schema/version | Decode errors or incorrect fields | Match generated types and fixtures to deployed backend firmware. |
| JSON sent to `/ws/robot` | No ACK or backend decode error | Send binary protobuf only. |
| Text/Blob delivered instead of ArrayBuffer | Decoder rejects message | Set `binaryType="arraybuffer"`; normalize Blob when necessary. |
| Background timer throttling | Irregular velocity cadence | Stop motion before hiding; rely on robot-side watchdog; never assume 50 Hz in background. |
| Gamepad not visible initially | `navigator.getGamepads()` returns empty | Require a user button press and handle connect/disconnect events. |
| MJPEG topic mismatch | Broken image/continuous retry | Verify `/image_raw` or use the configured robot topic. |
| Port `8080` healthy, `8081` failed | Video visible but controls disabled | Diagnose ports separately; video is not control health. |
| Port `8081` healthy, `8080` failed | Controls work without video | Diagnose video service/topic separately. |
| Stale service worker/cache | Old JavaScript or failed stream URL reused | Disable/update service worker and use cache-busting during diagnosis. |
| Duplicate sequence | Result code `6` | Correct sequence allocation; never reuse a pending value. |

### 14.2 Ordered Troubleshooting Procedure

1. Verify the device is associated with the intended D1 SSID.
2. Inspect the route to `192.168.50.1`; disable VPN/mobile route conflicts.
3. Confirm port `8081` and port `8080` independently.
4. Check the page scheme and browser console for mixed-content/CORS errors.
5. Verify the WebSocket reaches `OPEN` within 15 seconds.
6. Confirm outgoing `/ws/robot` frames are binary, not text.
7. Compare a Stand frame with fixture `42 06 08 01 10 01 18 00` using timestamp `0` in a unit test.
8. Check ACK `seq`, `mode`, and `result`; do not accept unmatched ACKs.
9. For motion, test a zero frame first and confirm configured limits.
10. For MJPEG, open the stream URL directly and verify the image topic.
11. Match protobuf code generation to the deployed backend before decoding telemetry.
12. Review bounded logs without exposing credentials.

## 15. Integration Verification

### 15.1 Baseline Checklist

1. Connect the test device to the D1 hotspot.
2. Confirm that `192.168.50.1` is reachable.
3. Open `/ws/robot` and verify the `open` event.
4. Send Stand with a new sequence and verify its matching ACK.
5. Send Crouch Down and Start Learning separately.
6. Verify that buttons are disabled during each pending command.
7. If velocity control is added, test `(0,0,0)` before any non-zero value.
8. Verify stop behaviour on release, blur, background, and disconnect.
9. Display the MJPEG stream from port `8080`.
10. Disconnect Wi-Fi and verify that controls disable immediately.
11. Reconnect Wi-Fi and verify a fresh socket is created without replaying old commands.

Perform motion tests in a clear area with direct access to the robot's physical safety controls.

### 15.2 Standardized Verification Cases

| Test ID | Preconditions | Procedure | Expected result |
| --- | --- | --- | --- |
| `NET-001` | Device disconnected from D1 Wi-Fi | Open controller | Controls remain disabled; network diagnostic shown. |
| `NET-002` | Device on D1 hotspot | Reach host and open socket | `/ws/robot` enters `CONNECTED` within configured handshake timeout. |
| `SEC-001` | HTTPS controller, plain D1 endpoints | Load page | Browser blocks mixed content; client reports failure without downgrade. |
| `WS-001` | Connected socket | Stop robot messages for more than 10 s | Client marks stale, clears control state, and recreates socket. |
| `WS-002` | Connected socket | Force disconnect during pending command | Pending request becomes aborted; command is not replayed. |
| `CMD-001` | Connected and robot ready | Send Stand with new `seq` | Binary field `8` sent; matching result `1` reported accepted. |
| `CMD-002` | Connected and robot ready | Send Crouch Down | Mode value `2`; matching ACK handled. |
| `CMD-003` | Connected and RL available | Send Start Learning | Mode value `3`; matching ACK handled. |
| `CMD-004` | ACK suppressed | Send mode and wait 3 s | Timeout reported as unknown; no automatic retry. |
| `CMD-005` | One command pending | Deliver different `seq` ACK | Pending command remains unresolved; mismatch logged. |
| `CMD-006` | Unit-test environment | Encode Stand, `seq=1`, time `0` | Exact bytes `42 06 08 01 10 01 18 00`. |
| `VEL-001` | Motion integration installed | Send `(0,0,0)` | Valid field-2 Twist frame; no requested motion. |
| `VEL-002` | Approved limits configured | Apply joystick extremes | Values remain finite and clamped to approved maxima. |
| `VEL-003` | Non-zero manual motion active | Release input | Zero transmitted immediately and subsequent snapshots remain zero. |
| `VEL-004` | Non-zero manual motion active | Hide page or remove controller | Local state cleared; zero attempted; no replay on return. |
| `HTTP-001` | Control HTTP reachable | POST valid navigation goal | HTTP `200` treated as accepted; execution tracked through `nav_status`. |
| `HTTP-002` | Control HTTP reachable | POST invalid/non-finite local input | Client rejects before network transmission. |
| `HTTP-003` | Request in flight | Force timeout | Unknown outcome reported; mutating request not automatically replayed. |
| `VID-001` | Video service and topic available | Load MJPEG URL | First frame renders and video state becomes `STREAMING`. |
| `VID-002` | Video streaming | Stop video service | Video enters retry state; robot controls retain independent status. |
| `VID-003` | `/subImage` path implemented | Subscribe then unsubscribe | HTTP bodies use exact topic/boolean; binary image frames stop after unsubscribe. |
| `REC-001` | Active connection | Disconnect and reconnect Wi-Fi | Fresh socket opens; all prior commands/velocity remain discarded. |
| `PB-001` | Connected socket | Deliver malformed binary frame | Frame dropped; no control action or crash. |
| `COMP-001` | Target firmware selected | Run backend fixture suite | All required fields/endpoints match the declared compatibility profile. |

Evidence for each test should include build/version identifiers, browser and OS, robot firmware/backend identifier where available, timestamped result, and relevant sanitized logs.

## 16. Conformance and Safety Requirements

An implementation conforms to this specification only when all applicable REQUIRED/MUST requirements and verification cases pass against the target backend compatibility profile.

- The D1 hotspot **MUST** be treated as a trusted, isolated control network.
- Plain HTTP/WS control endpoints **MUST NOT** be exposed to an untrusted network.
- HTTPS/WSS **MUST** be used when traffic crosses an untrusted network.
- Hotspot passwords, SSH credentials, and other secrets **MUST NOT** appear in browser logs.
- Every numeric control input **MUST** be finite, validated, and clamped.
- A physical emergency stop **MUST** remain available; webpage controls are non-safety-rated.
- ACK result `1` **MUST** be interpreted as software acceptance only, not completed robot motion.
- Disconnects **MUST** clear pending commands and motion snapshots.
- Offline physical command caching and post-reconnect replay **MUST NOT** be implemented.
- Any deviation in endpoint, field number, enum value, timing profile, or security mapping **MUST** be documented in a deployment-specific compatibility supplement.
