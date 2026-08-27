"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const protocol = require("../protocol.js");

test("encodes the known stand command wire fixture", () => {
  const actual = protocol.encodeModeCommand(1, protocol.MODES.STAND_UP, 0);
  assert.deepEqual(
    [...actual],
    [0x42, 0x06, 0x08, 0x01, 0x10, 0x01, 0x18, 0x00],
  );
});

test("encodes the three buttons with their documented mode values", () => {
  const cases = [
    [protocol.MODES.START_LEARNING, 3],
    [protocol.MODES.STAND_UP, 1],
    [protocol.MODES.CROUCH_DOWN, 2],
  ];

  for (const [mode, expectedMode] of cases) {
    const bytes = protocol.encodeModeCommand(7, mode, 0);
    assert.equal(bytes[5], expectedMode);
  }
});

test("decodes a matching successful learning acknowledgement", () => {
  const fixture = Uint8Array.from([
    0xa2, 0x01, 0x0a,
    0x08, 0x01,
    0x10, 0x03,
    0x18, 0x01,
    0x22, 0x02, 0x6f, 0x6b,
  ]);

  assert.deepEqual(protocol.decodeModeAck(fixture), {
    seq: 1,
    mode: protocol.MODES.START_LEARNING,
    result: 1,
    message: "ok",
  });
});

test("ignores non-ack robot envelopes", () => {
  assert.equal(protocol.decodeModeAck(Uint8Array.from([0x08, 0x01])), null);
});
