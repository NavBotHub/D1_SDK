(function startD1SimpleController() {
  "use strict";

  const DEFAULT_HOST = "192.168.50.1";
  const DEFAULT_PORT = 8081;
  const ACK_TIMEOUT_MS = 3000;
  const RECONNECT_DELAY_MS = 2000;

  const protocol = globalThis.D1Protocol;
  const statusDot = document.querySelector("#status-dot");
  const connectionStatus = document.querySelector("#connection-status");
  const connectionAddress = document.querySelector("#connection-address");
  const commandStatus = document.querySelector("#command-status");
  const actionButtons = [...document.querySelectorAll("button[data-mode]")];

  const query = new URLSearchParams(window.location.search);
  const host = query.get("host")?.trim() || DEFAULT_HOST;
  const requestedPort = Number(query.get("port"));
  const port =
    Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535
      ? requestedPort
      : DEFAULT_PORT;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const socketUrl = `${scheme}://${authority}:${port}/ws/robot`;

  let socket = null;
  let reconnectTimer = null;
  let nextSeq = 1;
  let commandPending = false;
  const pendingAcks = new Map();

  connectionAddress.textContent = `${host}:${port}`;

  function setConnectionState(state, message) {
    statusDot.className = `status-dot ${state}`;
    connectionStatus.textContent = message;
    const connected = state === "connected";
    for (const button of actionButtons) button.disabled = !connected || commandPending;
  }

  function showCommand(message, type = "") {
    commandStatus.className = `command-status ${type}`.trim();
    commandStatus.textContent = message;
  }

  function rejectPending(reason) {
    for (const pending of pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    pendingAcks.clear();
    commandPending = false;
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  function connect() {
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    setConnectionState("", "Connecting to D1...");
    showCommand("Waiting for the D1 connection.");
    const currentSocket = new WebSocket(socketUrl);
    currentSocket.binaryType = "arraybuffer";
    socket = currentSocket;

    currentSocket.addEventListener("open", () => {
      if (socket !== currentSocket) return;
      setConnectionState("connected", "D1 connected");
      showCommand("Choose an action.");
    });

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

    currentSocket.addEventListener("close", () => {
      if (socket !== currentSocket) return;
      socket = null;
      rejectPending(new Error("D1 connection closed"));
      setConnectionState("disconnected", "D1 disconnected — retrying...");
      showCommand("Reconnect to the D1 Wi-Fi network if needed.", "error");
      scheduleReconnect();
    });

    currentSocket.addEventListener("error", () => {
      if (socket === currentSocket) currentSocket.close();
    });
  }

  function allocateSeq() {
    const seq = nextSeq;
    nextSeq = (nextSeq + 1) >>> 0;
    if (nextSeq === 0) nextSeq = 1;
    return seq;
  }

  function sendMode(mode) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("D1 is not connected"));
    }
    const seq = allocateSeq();
    socket.send(protocol.encodeModeCommand(seq, mode));
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingAcks.delete(seq);
        reject(new Error("No acknowledgement received within 3 seconds"));
      }, ACK_TIMEOUT_MS);
      pendingAcks.set(seq, { resolve, reject, timer });
    });
  }

  for (const button of actionButtons) {
    button.addEventListener("click", async () => {
      if (commandPending) return;
      const mode = Number(button.dataset.mode);
      const label = button.querySelector("strong").textContent;
      commandPending = true;
      setConnectionState("connected", "D1 connected");
      showCommand(`Sending ${label}...`);
      try {
        const ack = await sendMode(mode);
        const result = protocol.RESULTS[ack.result] || `unknown result ${ack.result}`;
        if (ack.result === 1) {
          showCommand(`${label} accepted${ack.message ? `: ${ack.message}` : "."}`, "success");
        } else {
          showCommand(`${label} rejected: ${result}${ack.message ? ` — ${ack.message}` : ""}`, "error");
        }
      } catch (error) {
        showCommand(`${label} failed: ${error.message}`, "error");
      } finally {
        commandPending = false;
        setConnectionState(socket?.readyState === WebSocket.OPEN ? "connected" : "disconnected",
          socket?.readyState === WebSocket.OPEN ? "D1 connected" : "D1 disconnected — retrying...");
      }
    });
  }

  window.addEventListener("beforeunload", () => {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    socket?.close();
  });

  connect();
})();
