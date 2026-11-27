-- Wireshark dissectors for SkyLink.
--
--   slcp : SkyLink Control Protocol, over TCP 7400 (length-prefixed frames, see docs/protocol.md)
--   sltp : SkyLink Telemetry Protocol, over UDP 7401 (binary datagrams, big-endian)
--
-- Install: copy this file to %APPDATA%\Wireshark\plugins\ (create the folder if needed),
-- then Analyze > Reload Lua Plugins (Ctrl+Shift+L), or restart Wireshark.
-- Without installing:  wireshark -X lua_script:tools/wireshark/skylink.lua -r captures/demo.pcapng
-- If you changed SKY_TCP_PORT / SKY_UDP_PORT: Edit > Preferences > Protocols > SLCP / SLTP.
-- Capture on the "Adapter for loopback traffic capture" (Npcap), capture filter: tcp port 7400 or udp port 7401
--
-- Useful display filters:
--   slcp                                         every SLCP frame
--   slcp.type == 0x10                            COMMAND only
--   slcp.type == 0x21                            LOG_CHUNK only (slcp.offset shows the position in the log)
--   slcp.type == 0x22                            LOG_ACK only (offset = bytes written to disk)
--   tcp.port == 7400 && tcp.flags.reset == 1     the voluntary RST of the demo
--   sltp.drone == 4                              telemetry and echoes of Delta
--   sltp.type == 2 || sltp.type == 3             UDP echo request / reply (RTT probes)

-- ---------------------------------------------------------------------------
-- SLCP (TCP)
-- ---------------------------------------------------------------------------
local slcp = Proto("slcp", "SkyLink Control Protocol")

local SLCP_TYPES = {
  [0x01] = "HELLO",
  [0x02] = "WELCOME",
  [0x10] = "COMMAND",
  [0x11] = "COMMAND_ACK",
  [0x20] = "LOG_BEGIN",
  [0x21] = "LOG_CHUNK",
  [0x22] = "LOG_ACK",
  [0x23] = "LOG_DONE",
  [0x30] = "PING",
  [0x31] = "PONG",
  [0x7F] = "ERROR",
}

local F = slcp.fields
F.len     = ProtoField.uint32("slcp.len", "Length (type + body)", base.DEC)
F.type    = ProtoField.uint8("slcp.type", "Type", base.HEX, SLCP_TYPES)
F.json    = ProtoField.string("slcp.json", "JSON body")
F.offset  = ProtoField.uint32("slcp.offset", "Chunk offset", base.DEC)
F.datalen = ProtoField.uint32("slcp.datalen", "Chunk data length", base.DEC)

slcp.prefs.port = Pref.uint("TCP port", 7400, "TCP port of the SkyLink ground station (SKY_TCP_PORT)")

local MAX_FRAME_LEN = 20000

-- Several PDUs can share one TCP segment: the first one replaces the TCP info, the next ones are appended.
local first_pdu = true

local function set_info(pinfo, text)
  if first_pdu then
    first_pdu = false
    pinfo.cols.info:set(text)
  else
    pinfo.cols.info:append(", " .. text)
  end
end

local function pdu_length(tvb, pinfo, offset)
  local len = tvb(offset, 4):uint()
  if len == 0 or len > MAX_FRAME_LEN then
    -- not a valid SLCP frame: do not ask Wireshark to reassemble garbage
    return 4
  end
  return 4 + len
end

local function dissect_pdu(tvb, pinfo, tree)
  pinfo.cols.protocol:set("SLCP")

  if tvb:len() < 5 then
    local bad = tree:add(slcp, tvb(), "SLCP (invalid frame)")
    bad:add(F.len, tvb(0, 4))
    set_info(pinfo, "INVALID FRAME")
    return tvb:len()
  end

  local len = tvb(0, 4):uint()
  local ty = tvb(4, 1):uint()
  local name = SLCP_TYPES[ty] or string.format("0x%02x", ty)
  local body = len - 1
  if body > tvb:len() - 5 then
    body = tvb:len() - 5
  end

  local sub = tree:add(slcp, tvb(), "SLCP " .. name)
  sub:add(F.len, tvb(0, 4))
  sub:add(F.type, tvb(4, 1))

  local info = name
  if ty == 0x21 then
    -- LOG_CHUNK: offset (u32 BE) | data
    if body >= 5 then
      local datalen = body - 4
      sub:add(F.offset, tvb(5, 4))
      sub:add(F.datalen, tvb(9, datalen), datalen)
      info = string.format("LOG_CHUNK off=%d len=%d", tvb(5, 4):uint(), datalen)
    else
      info = "LOG_CHUNK (short)"
    end
  elseif body > 0 then
    -- every other frame carries a compact JSON object
    local text = tvb(5, body):string()
    sub:add(F.json, tvb(5, body))
    if ty == 0x01 then
      local drone = text:match('"name":"([^"]*)"') or "?"
      local session = text:match('"sessionId":"(%x+)"')
      info = "HELLO " .. drone
      if session then
        info = info .. " session=" .. session
      end
    elseif ty == 0x02 then
      info = string.format("WELCOME resumed=%s queued=%s",
        text:match('"resumed":(%a+)') or "?", text:match('"queued":(%d+)') or "?")
    elseif ty == 0x10 then
      info = string.format("COMMAND %s #%s",
        text:match('"action":"([%w_]+)"') or "?", text:match('"cmdId":(%d+)') or "?")
    elseif ty == 0x11 then
      info = string.format("COMMAND_ACK #%s %s",
        text:match('"cmdId":(%d+)') or "?", text:match('"status":"(%a+)"') or "?")
    elseif ty == 0x20 then
      info = string.format("LOG_BEGIN %s size=%s",
        text:match('"logId":"([%w_%-]+)"') or "?", text:match('"size":(%d+)') or "?")
    elseif ty == 0x22 then
      info = "LOG_ACK offset=" .. (text:match('"offset":(%d+)') or "?")
    elseif ty == 0x23 then
      info = "LOG_DONE ok=" .. (text:match('"ok":(%a+)') or "?")
    elseif ty == 0x30 or ty == 0x31 then
      info = name .. " n=" .. (text:match('"n":(%d+)') or "?")
    elseif ty == 0x7F then
      info = "ERROR " .. (text:match('"code":"([%w_]+)"') or "?")
    end
  end

  set_info(pinfo, info)
  return tvb:len()
end

function slcp.dissector(tvb, pinfo, tree)
  first_pdu = true
  -- PDUs can be split over several TCP segments or glued in one: let Wireshark reassemble.
  dissect_tcp_pdus(tvb, tree, 4, pdu_length, dissect_pdu, true)
  return tvb:len()
end

local registered_tcp = 7400
DissectorTable.get("tcp.port"):add(registered_tcp, slcp)

-- ---------------------------------------------------------------------------
-- SLTP (UDP)
-- ---------------------------------------------------------------------------
local sltp = Proto("sltp", "SkyLink Telemetry Protocol")

local SLTP_TYPES = {
  [1] = "TELEMETRY",
  [2] = "ECHO_REQ",
  [3] = "ECHO_REP",
}

local STATES = {
  [0] = "LANDED",
  [1] = "TAKEOFF",
  [2] = "HOVER",
  [3] = "GOTO",
  [4] = "MISSION",
  [5] = "RTH",
  [6] = "LANDING",
}

local DRONES = {
  [1] = "Alpha",
  [2] = "Bravo",
  [3] = "Charlie",
  [4] = "Delta",
  [5] = "Echo",
  [6] = "Foxtrot",
  [7] = "Golf",
  [8] = "Hotel",
}

local G = sltp.fields
G.magic    = ProtoField.uint16("sltp.magic", "Magic", base.HEX)
G.version  = ProtoField.uint8("sltp.version", "Version", base.DEC)
G.type     = ProtoField.uint8("sltp.type", "Type", base.DEC, SLTP_TYPES)
G.drone    = ProtoField.uint8("sltp.drone", "Drone", base.DEC, DRONES)
G.flags    = ProtoField.uint8("sltp.flags", "Flags", base.HEX)
G.seq      = ProtoField.uint32("sltp.seq", "Sequence number", base.DEC)
G.ts       = ProtoField.uint32("sltp.ts", "Drone timestamp (ms)", base.DEC)
G.x        = ProtoField.float("sltp.x", "X (m)")
G.y        = ProtoField.float("sltp.y", "Y (m)")
G.alt      = ProtoField.float("sltp.alt", "Altitude (m)")
G.speed    = ProtoField.float("sltp.speed", "Speed (m/s)")
G.heading  = ProtoField.float("sltp.heading", "Heading (deg)")
G.battery  = ProtoField.uint8("sltp.battery", "Battery (%)", base.DEC)
G.state    = ProtoField.uint8("sltp.state", "State", base.DEC, STATES)
G.echo_seq = ProtoField.uint32("sltp.echo_seq", "Echo sequence", base.DEC)
G.t0us     = ProtoField.uint32("sltp.t0us", "Server send time (us)", base.DEC)

sltp.prefs.port = Pref.uint("UDP port", 7401, "UDP port of the SkyLink ground station (SKY_UDP_PORT)")

function sltp.dissector(tvb, pinfo, tree)
  local n = tvb:len()
  if n < 6 then
    return 0
  end
  if tvb(0, 2):uint() ~= 0x534C then
    return 0
  end

  pinfo.cols.protocol:set("SLTP")
  local ty = tvb(3, 1):uint()
  local id = tvb(4, 1):uint()
  local tname = SLTP_TYPES[ty] or string.format("type %d", ty)
  local dname = DRONES[id] or string.format("drone %d", id)

  local sub = tree:add(sltp, tvb(), "SkyLink datagram " .. tname .. " (" .. dname .. ")")
  sub:add(G.magic, tvb(0, 2))
  sub:add(G.version, tvb(2, 1))
  sub:add(G.type, tvb(3, 1))
  sub:add(G.drone, tvb(4, 1))
  sub:add(G.flags, tvb(5, 1))

  local info = string.format("%s %s", tname, dname)
  if ty == 1 and n >= 36 then
    -- TELEMETRY: seq | tsMs | x | y | alt | speed | heading (f32 BE) | battery | state
    sub:add(G.seq, tvb(6, 4))
    sub:add(G.ts, tvb(10, 4))
    sub:add(G.x, tvb(14, 4))
    sub:add(G.y, tvb(18, 4))
    sub:add(G.alt, tvb(22, 4))
    sub:add(G.speed, tvb(26, 4))
    sub:add(G.heading, tvb(30, 4))
    sub:add(G.battery, tvb(34, 1))
    sub:add(G.state, tvb(35, 1))
    info = string.format("TELEMETRY %s seq=%d alt=%.1f bat=%d%%",
      dname, tvb(6, 4):uint(), tvb(22, 4):float(), tvb(34, 1):uint())
  elseif (ty == 2 or ty == 3) and n >= 14 then
    -- ECHO_REQ / ECHO_REP: echoSeq | t0us
    sub:add(G.echo_seq, tvb(6, 4))
    sub:add(G.t0us, tvb(10, 4))
    info = string.format("%s %s #%d", tname, dname, tvb(6, 4):uint())
  end

  pinfo.cols.info:set(info)
  return n
end

local registered_udp = 7401
DissectorTable.get("udp.port"):add(registered_udp, sltp)

-- ---------------------------------------------------------------------------
-- Ports from the preferences dialog
-- ---------------------------------------------------------------------------
function slcp.prefs_changed()
  if slcp.prefs.port ~= registered_tcp then
    DissectorTable.get("tcp.port"):remove(registered_tcp, slcp)
    registered_tcp = slcp.prefs.port
    DissectorTable.get("tcp.port"):add(registered_tcp, slcp)
  end
end

function sltp.prefs_changed()
  if sltp.prefs.port ~= registered_udp then
    DissectorTable.get("udp.port"):remove(registered_udp, sltp)
    registered_udp = sltp.prefs.port
    DissectorTable.get("udp.port"):add(registered_udp, sltp)
  end
end
