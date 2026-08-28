(function exposeD1Protocol(global) {
  "use strict";

  const MODES = Object.freeze({
    STAND_UP: 1,
    CROUCH_DOWN: 2,
    START_LEARNING: 3,
    STOP_LEARNING: 4,
  });

  const RESULTS = Object.freeze({
    1: "sent",
    2: "bridge not ready",
    3: "learning service offline",
    4: "busy",
    5: "rate limited",
    6: "duplicate",
  });

  /** Encodes a non-negative integer using the protobuf varint wire format. */
  function encodeVarint(input) {
    let value = BigInt(input);
    if (value < 0n) throw new RangeError("D1 varints must be non-negative");

    const bytes = [];
    do {
      let byte = Number(value & 0x7fn);
      value >>= 7n;
      if (value !== 0n) byte |= 0x80;
      bytes.push(byte);
    } while (value !== 0n);
    return bytes;
  }

  /** Builds a protobuf field key from its field number and wire type. */
  function encodeKey(field, wireType) {
    return encodeVarint((field << 3) | wireType);
  }

  /**
   * Encodes Stand, Crouch, Start Learning, or Stop Learning as
   * ClientRobotMessage field 8.
   */
  function encodeModeCommand(seq, mode, clientTimeMs = Date.now()) {
    if (!Number.isInteger(seq) || seq < 1 || seq > 0xffffffff) {
      throw new RangeError("seq must be an unsigned, non-zero 32-bit integer");
    }
    if (![1, 2, 3, 4].includes(mode)) {
      throw new RangeError("mode must be one of the documented D1 mode values");
    }

    const command = [
      ...encodeKey(1, 0),
      ...encodeVarint(seq),
      ...encodeKey(2, 0),
      ...encodeVarint(mode),
      ...encodeKey(3, 0),
      ...encodeVarint(clientTimeMs),
    ];

    return new Uint8Array([
      ...encodeKey(8, 2),
      ...encodeVarint(command.length),
      ...command,
    ]);
  }

  /** Encodes one finite number as a protobuf fixed64/double field. */
  function encodeDoubleField(field, input) {
    const value = Number(input);
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, Number.isFinite(value) ? value : 0, true);
    return [...encodeKey(field, 1), ...new Uint8Array(buffer)];
  }

  /** Wraps an already encoded payload in a length-delimited message field. */
  function encodeMessageField(field, payload) {
    return [...encodeKey(field, 2), ...encodeVarint(payload.length), ...payload];
  }

  /** Encodes the x, y, and z doubles of a geometry Vector3 message. */
  function encodeVector3(x, y, z) {
    return [
      ...encodeDoubleField(1, x),
      ...encodeDoubleField(2, y),
      ...encodeDoubleField(3, z),
    ];
  }

  /**
   * Encodes planar velocity as ClientRobotMessage field 2 (Twist).
   * vx maps to linear.x, vy to linear.y, and vw to angular.z.
   */
  function encodeVelocityCommand(vx, vy, vw) {
    const linear = encodeVector3(vx, vy, 0);
    const angular = encodeVector3(0, 0, vw);
    const twist = [
      ...encodeMessageField(1, linear),
      ...encodeMessageField(2, angular),
    ];
    return new Uint8Array(encodeMessageField(2, twist));
  }

  /** Reads one protobuf varint and advances the shared byte cursor. */
  function readVarint(bytes, cursor) {
    let value = 0n;
    let shift = 0n;
    while (cursor.offset < bytes.length && shift <= 63n) {
      const byte = bytes[cursor.offset++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
    throw new Error("Invalid or truncated protobuf varint");
  }

  /** Reads one protobuf length-delimited field and advances the cursor. */
  function readLengthDelimited(bytes, cursor) {
    const length = Number(readVarint(bytes, cursor));
    const end = cursor.offset + length;
    if (!Number.isSafeInteger(length) || length < 0 || end > bytes.length) {
      throw new Error("Invalid protobuf length-delimited field");
    }
    const value = bytes.subarray(cursor.offset, end);
    cursor.offset = end;
    return value;
  }

  /** Skips an unknown protobuf field without breaking forward compatibility. */
  function skipField(bytes, cursor, wireType) {
    if (wireType === 0) {
      readVarint(bytes, cursor);
      return;
    }
    if (wireType === 1) {
      cursor.offset += 8;
    } else if (wireType === 2) {
      readLengthDelimited(bytes, cursor);
      return;
    } else if (wireType === 5) {
      cursor.offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
    if (cursor.offset > bytes.length) throw new Error("Truncated protobuf field");
  }

  /** Decodes the nested D1ModeAck fields from a field-20 payload. */
  function decodeAckPayload(bytes) {
    const cursor = { offset: 0 };
    const ack = { seq: 0, mode: 0, result: 0, message: "" };
    while (cursor.offset < bytes.length) {
      const key = Number(readVarint(bytes, cursor));
      const field = key >> 3;
      const wireType = key & 7;
      if (field === 1 && wireType === 0) {
        ack.seq = Number(readVarint(bytes, cursor));
      } else if (field === 2 && wireType === 0) {
        ack.mode = Number(readVarint(bytes, cursor));
      } else if (field === 3 && wireType === 0) {
        ack.result = Number(readVarint(bytes, cursor));
      } else if (field === 4 && wireType === 2) {
        ack.message = new TextDecoder().decode(readLengthDelimited(bytes, cursor));
      } else {
        skipField(bytes, cursor, wireType);
      }
    }
    return ack;
  }

  /**
   * Finds and decodes RobotMessage field 20.
   * Returns null when the incoming robot envelope does not contain a mode ACK.
   */
  function decodeModeAck(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const cursor = { offset: 0 };
    while (cursor.offset < bytes.length) {
      const key = Number(readVarint(bytes, cursor));
      const field = key >> 3;
      const wireType = key & 7;
      if (field === 20 && wireType === 2) {
        return decodeAckPayload(readLengthDelimited(bytes, cursor));
      }
      skipField(bytes, cursor, wireType);
    }
    return null;
  }

  global.D1Protocol = Object.freeze({
    MODES,
    RESULTS,
    encodeModeCommand,
    encodeVelocityCommand,
    decodeModeAck,
  });
  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.D1Protocol;
  }
})(globalThis);

if (typeof document !== "undefined") {
  (function startD1ControllerDemo() {
    "use strict";

  const DEFAULT_HOST = "192.168.50.1";
  const DEFAULT_PORT = 8081;
  const ACK_TIMEOUT_MS = 3000;
  const VELOCITY_INTERVAL_MS = 20;
  const MAX_VX = 0.9;
  const MAX_VY = 0.5;
  const MAX_VW = 0.4;

  const protocol = globalThis.D1Protocol;
  const connectionForm = document.querySelector("#connection-form");
  const hostInput = document.querySelector("#host-input");
  const portInput = document.querySelector("#port-input");
  const connectButton = document.querySelector("#connect-button");
  const statusDot = document.querySelector("#status-dot");
  const connectionStatus = document.querySelector("#connection-status");
  const connectionAddress = document.querySelector("#connection-address");
  const commandStatus = document.querySelector("#command-status");
  const velocityStatus = document.querySelector("#velocity-status");
  const actionButtons = [...document.querySelectorAll("button[data-mode]")];
  const motionButtons = [...document.querySelectorAll("button[data-motion]")];

  const query = new URLSearchParams(window.location.search);
  hostInput.value = query.get("host")?.trim() || DEFAULT_HOST;
  const queryPort = Number(query.get("port"));
  portInput.value =
    Number.isInteger(queryPort) && queryPort > 0 && queryPort <= 65535
      ? String(queryPort)
      : String(DEFAULT_PORT);

  let socket = null;
  let connectionPhase = "disconnected";
  let controlReady = false;
  let commandPending = false;
  let nextSeq = 1;
  let velocityTimer = null;
  let velocity = { vx: 0, vy: 0, vw: 0 };
  const pendingAcks = new Map();
  const activeMotions = new Set();

  /** Displays command progress, success, or error feedback below the controls. */
  function showCommand(message, type = "") {
    commandStatus.className = `command-status ${type}`.trim();
    commandStatus.textContent = message;
  }

  /** Adds brackets around an IPv6 host so it can be used in a WebSocket URL. */
  function formatHostForUrl(host) {
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  }

  /** Validates the IP/host and port inputs and returns the complete socket URL. */
  function readEndpoint() {
    let host = hostInput.value.trim();
    const port = Number(portInput.value);

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
      const parsed = new URL(host);
      host = parsed.hostname;
    }
    host = host.replace(/^\[|\]$/g, "");

    if (!host || /[\s/?#\\]/.test(host)) {
      throw new Error("Enter a valid robot IP address or host name");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Port must be an integer from 1 to 65535");
    }

    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const authority = formatHostForUrl(host);
    return {
      host,
      port,
      url: `${scheme}://${authority}:${port}/ws/robot`,
    };
  }

  /** Updates the target address shown while the controller is disconnected. */
  function updateEndpointPreview() {
    if (connectionPhase !== "disconnected") return;
    try {
      const endpoint = readEndpoint();
      connectionAddress.textContent = `Target: ${endpoint.host}:${endpoint.port}`;
    } catch (_) {
      connectionAddress.textContent = "Enter a valid robot address.";
    }
  }

  /** Enables robot controls only when initialization succeeded and no mode is pending. */
  function refreshControlAvailability() {
    const enabled = controlReady && !commandPending;
    for (const button of actionButtons) button.disabled = !enabled;
    for (const button of motionButtons) button.disabled = !enabled;
  }

  /** Updates connection text, input locking, and the Connect/Disconnect button. */
  function setConnectionState(phase, message, detail = "") {
    connectionPhase = phase;
    statusDot.className = `status-dot ${phase}`;
    connectionStatus.textContent = message;
    connectionAddress.textContent = detail;

    const active = phase === "connecting" || phase === "connected";
    hostInput.disabled = active;
    portInput.disabled = active;
    connectButton.textContent = active ? "Disconnect" : "Connect";
    connectButton.classList.toggle("disconnect", active);
    refreshControlAvailability();
  }

  /** Rejects and removes every mode command still waiting for an ACK. */
  function rejectPending(reason) {
    for (const pending of pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    pendingAcks.clear();
    commandPending = false;
  }

  /** Allocates a non-zero 32-bit sequence number for ACK correlation. */
  function allocateSeq() {
    const seq = nextSeq;
    nextSeq = (nextSeq + 1) >>> 0;
    if (nextSeq === 0) nextSeq = 1;
    return seq;
  }

  /**
   * Encodes and sends one D1 mode command, then resolves with its matching ACK.
   * The promise rejects on send failure, disconnect, or the three-second timeout.
   */
  function sendMode(mode) {
    const activeSocket = socket;
    if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("D1 is not connected"));
    }

    const seq = allocateSeq();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingAcks.delete(seq);
        reject(new Error("No acknowledgement received within 3 seconds"));
      }, ACK_TIMEOUT_MS);
      pendingAcks.set(seq, { resolve, reject, timer });

      try {
        activeSocket.send(protocol.encodeModeCommand(seq, mode));
      } catch (error) {
        clearTimeout(timer);
        pendingAcks.delete(seq);
        reject(error);
      }
    });
  }

  /** Sends Start Learning after socket open and unlocks controls on result 1. */
  async function startLearning(activeSocket) {
    commandPending = true;
    controlReady = false;
    refreshControlAvailability();
    showCommand("Connected. Starting learning mode...");

    try {
      const ack = await sendMode(protocol.MODES.START_LEARNING);
      if (socket !== activeSocket) return;
      if (ack.result !== 1) {
        const result = protocol.RESULTS[ack.result] || `unknown result ${ack.result}`;
        throw new Error(`${result}${ack.message ? ` — ${ack.message}` : ""}`);
      }
      controlReady = true;
      showCommand(
        `Learning mode ready${ack.message ? `: ${ack.message}` : "."}`,
        "success",
      );
    } catch (error) {
      if (socket !== activeSocket) return;
      controlReady = false;
      showCommand(`Start Learning failed: ${error.message}`, "error");
    } finally {
      if (socket === activeSocket) {
        commandPending = false;
        refreshControlAvailability();
      }
    }
  }

  /** Opens the user-selected robot WebSocket and installs its lifecycle handlers. */
  function connect() {
    let endpoint;
    try {
      endpoint = readEndpoint();
    } catch (error) {
      setConnectionState("error", "Invalid connection settings", error.message);
      showCommand(error.message, "error");
      return;
    }

    controlReady = false;
    commandPending = false;
    setConnectionState("connecting", "Connecting to D1...", endpoint.url);
    showCommand("Opening the robot WebSocket...");

    const currentSocket = new WebSocket(endpoint.url);
    currentSocket.binaryType = "arraybuffer";
    socket = currentSocket;

    // Initialize Learning mode before allowing posture or movement commands.
    currentSocket.addEventListener("open", () => {
      if (socket !== currentSocket) return;
      setConnectionState(
        "connected",
        "D1 connected",
        `${endpoint.host}:${endpoint.port}`,
      );
      void startLearning(currentSocket);
    });

    // Decode field-20 mode ACKs and resolve the promise with the same sequence.
    currentSocket.addEventListener("message", async (event) => {
      if (socket !== currentSocket) return;
      try {
        const raw = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
        if (!(raw instanceof ArrayBuffer)) return;
        const ack = protocol.decodeModeAck(raw);
        if (!ack) return;
        const pending = pendingAcks.get(ack.seq);
        if (!pending) return;
        pendingAcks.delete(ack.seq);
        clearTimeout(pending.timer);
        pending.resolve(ack);
      } catch (error) {
        console.warn("Ignored malformed D1 WebSocket frame", error);
      }
    });

    // A failed connection is closed and remains disconnected until another click.
    currentSocket.addEventListener("error", () => {
      if (socket !== currentSocket) return;
      showCommand("Unable to open the robot WebSocket.", "error");
      try {
        currentSocket.close();
      } catch (_) {}
    });

    // Clear motion and pending commands whenever the active socket closes.
    currentSocket.addEventListener("close", () => {
      if (socket !== currentSocket) return;
      stopMotion(false);
      socket = null;
      controlReady = false;
      rejectPending(new Error("D1 connection closed"));
      setConnectionState(
        "disconnected",
        "Not connected",
        `Target: ${endpoint.host}:${endpoint.port}`,
      );
      showCommand("Connection closed. Select Connect to try again.", "error");
    });
  }

  /** Stops motion, rejects pending work, and closes the socket at the user's request. */
  function disconnect() {
    const activeSocket = socket;
    stopMotion(true);
    socket = null;
    controlReady = false;
    rejectPending(new Error("Disconnected by user"));
    try {
      activeSocket?.close(1000, "User disconnected");
    } catch (_) {}
    setConnectionState("disconnected", "Not connected", "Select Connect to reconnect.");
    showCommand("Disconnected.");
  }

  /** Converts the currently held direction buttons into vx, vy, and vw. */
  function updateVelocityFromButtons() {
    const forward = activeMotions.has("forward") ? 1 : 0;
    const back = activeMotions.has("back") ? 1 : 0;
    const left = activeMotions.has("left") ? 1 : 0;
    const right = activeMotions.has("right") ? 1 : 0;
    const turnLeft = activeMotions.has("turn-left") ? 1 : 0;
    const turnRight = activeMotions.has("turn-right") ? 1 : 0;
    velocity = {
      vx: MAX_VX * (forward - back),
      vy: MAX_VY * (left - right),
      vw: MAX_VW * (turnLeft - turnRight),
    };
    velocityStatus.textContent =
      `vx ${velocity.vx.toFixed(3)} · ` +
      `vy ${velocity.vy.toFixed(3)} · ` +
      `vw ${velocity.vw.toFixed(3)}`;
  }

  /** Encodes and sends the latest combined velocity when robot control is ready. */
  function sendVelocitySnapshot() {
    if (!controlReady || !socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(
        protocol.encodeVelocityCommand(velocity.vx, velocity.vy, velocity.vw),
      );
    } catch (error) {
      showCommand(`Velocity send failed: ${error.message}`, "error");
    }
  }

  /** Sends immediately, then starts the 20 ms velocity transmission loop. */
  function startVelocityLoop() {
    if (velocityTimer !== null) return;
    sendVelocitySnapshot();
    velocityTimer = window.setInterval(sendVelocitySnapshot, VELOCITY_INTERVAL_MS);
  }

  /** Stops periodic velocity transmission without changing the current axes. */
  function stopVelocityLoop() {
    if (velocityTimer !== null) {
      clearInterval(velocityTimer);
      velocityTimer = null;
    }
  }

  /** Clears every held direction and optionally sends one zero-velocity frame. */
  function stopMotion(sendZero) {
    stopVelocityLoop();
    activeMotions.clear();
    for (const button of motionButtons) button.classList.remove("active");
    updateVelocityFromButtons();
    if (sendZero && socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(protocol.encodeVelocityCommand(0, 0, 0));
      } catch (_) {}
    }
  }

  /** Activates one direction and starts continuous velocity transmission. */
  function pressMotionButton(button) {
    if (!controlReady || commandPending || button.disabled) return;
    activeMotions.add(button.dataset.motion);
    button.classList.add("active");
    updateVelocityFromButtons();
    startVelocityLoop();
  }

  /** Releases one direction and immediately sends the remaining or zero velocity. */
  function releaseMotionButton(button) {
    activeMotions.delete(button.dataset.motion);
    button.classList.remove("active");
    updateVelocityFromButtons();
    if (activeMotions.size === 0) stopVelocityLoop();
    sendVelocitySnapshot();
  }

  /** Binds press-and-hold pointer and keyboard behavior to one direction button. */
  function bindMotionButton(button) {
    let pointerId = null;
    let keyboardActive = false;

    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || button.disabled) return;
      event.preventDefault();
      pointerId = event.pointerId;
      button.setPointerCapture(event.pointerId);
      pressMotionButton(button);
    });

    const releasePointer = (event) => {
      if (pointerId !== event.pointerId) return;
      pointerId = null;
      releaseMotionButton(button);
    };

    button.addEventListener("pointerup", releasePointer);
    button.addEventListener("pointercancel", releasePointer);
    button.addEventListener("lostpointercapture", releasePointer);

    button.addEventListener("keydown", (event) => {
      if (![" ", "Enter"].includes(event.key) || event.repeat || keyboardActive) return;
      event.preventDefault();
      keyboardActive = true;
      pressMotionButton(button);
    });

    button.addEventListener("keyup", (event) => {
      if (![" ", "Enter"].includes(event.key) || !keyboardActive) return;
      event.preventDefault();
      keyboardActive = false;
      releaseMotionButton(button);
    });

    button.addEventListener("blur", () => {
      if (!keyboardActive) return;
      keyboardActive = false;
      releaseMotionButton(button);
    });
  }

  /** Handles the shared Connect/Disconnect form button. */
  function handleConnectionSubmit(event) {
    event.preventDefault();
    if (connectionPhase === "connecting" || connectionPhase === "connected") {
      disconnect();
    } else {
      connect();
    }
  }

  /** Sends the Stand or Crouch mode stored in a button's data-mode attribute. */
  async function handleActionButtonClick(button) {
    if (!controlReady || commandPending) return;
    stopMotion(true);
    const mode = Number(button.dataset.mode);
    const label = button.querySelector("strong").textContent;
    commandPending = true;
    refreshControlAvailability();
    showCommand(`Sending ${label}...`);
    try {
      const ack = await sendMode(mode);
      const result = protocol.RESULTS[ack.result] || `unknown result ${ack.result}`;
      if (ack.result === 1) {
        showCommand(`${label} accepted${ack.message ? `: ${ack.message}` : "."}`, "success");
      } else {
        showCommand(
          `${label} rejected: ${result}${ack.message ? ` — ${ack.message}` : ""}`,
          "error",
        );
      }
    } catch (error) {
      showCommand(`${label} failed: ${error.message}`, "error");
    } finally {
      commandPending = false;
      refreshControlAvailability();
    }
  }

  connectionForm.addEventListener("submit", handleConnectionSubmit);

  hostInput.addEventListener("input", updateEndpointPreview);
  portInput.addEventListener("input", updateEndpointPreview);

  for (const button of actionButtons) {
    button.addEventListener("click", () => void handleActionButtonClick(button));
  }

  for (const button of motionButtons) bindMotionButton(button);

  // Losing page control must clear motion even when pointerup is not delivered.
  window.addEventListener("blur", () => stopMotion(true));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopMotion(true);
  });
  window.addEventListener("beforeunload", () => {
    stopMotion(true);
    socket?.close();
  });

  updateEndpointPreview();
  refreshControlAvailability();
  })();
}
