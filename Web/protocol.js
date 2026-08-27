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

  function encodeVarint(input) {
    let value = BigInt(input);
    if (value < 0n) {
      throw new RangeError("D1 varints must be non-negative");
    }
    const bytes = [];
    do {
      let byte = Number(value & 0x7fn);
      value >>= 7n;
      if (value !== 0n) byte |= 0x80;
      bytes.push(byte);
    } while (value !== 0n);
    return bytes;
  }

  function encodeKey(field, wireType) {
    return encodeVarint((field << 3) | wireType);
  }

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
    if (cursor.offset > bytes.length) {
      throw new Error("Truncated protobuf field");
    }
  }

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

  const api = Object.freeze({ MODES, RESULTS, encodeModeCommand, decodeModeAck });
  global.D1Protocol = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
