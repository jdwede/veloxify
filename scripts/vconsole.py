"""Minimal client for Valve's VConsole2 protocol (TCP 29000), used by CS2's developer console tool.

Packet header (12 bytes, big endian): 4-byte ASCII type, u16 version, u32 total length
(including the header), u16 handle. Commands are CMND packets carrying a NUL-terminated string;
console output arrives as PRNT packets whose text starts 28 bytes into the payload.
(Reverse-engineered from CS2 build 10924, Oct 2026.)
"""

import socket
import struct
import threading
import time

HEADER = struct.Struct(">4sHIH")
VERSION = 0x00D4
PRNT_TEXT_OFFSET = 28


class VConsole:
    def __init__(self, port=29000, timeout=120):
        deadline = time.time() + timeout
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=3)
                break
            except OSError:
                if time.time() > deadline:
                    raise RuntimeError("VConsole port never opened")
                time.sleep(1)
        self.sock.settimeout(None)
        self.lines = []
        self.types = {}
        self.alive = True
        threading.Thread(target=self._reader, daemon=True).start()

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("closed")
            buf += chunk
        return buf

    def _reader(self):
        try:
            while True:
                kind, _ver, length, _handle = HEADER.unpack(self._recv_exact(HEADER.size))
                payload = self._recv_exact(length - HEADER.size)
                k = kind.decode("ascii", "replace")
                self.types[k] = self.types.get(k, 0) + 1
                if k == "PRNT":
                    # Channel/colour metadata precedes the NUL-terminated text.
                    text = payload[payload.find(b"\x00", 24) :] if False else payload
                    s = text.decode("utf-8", "replace")
                    for line in s.replace("\x00", "\n").splitlines():
                        line = "".join(ch for ch in line if ch.isprintable()).strip()
                        if line:
                            self.lines.append(line)
        except (OSError, ConnectionError):
            self.alive = False

    def send(self, cmd):
        payload = cmd.encode() + b"\x00"
        self.sock.sendall(HEADER.pack(b"CMND", VERSION, HEADER.size + len(payload), 0) + payload)

    def wait_for(self, needle, timeout):
        deadline = time.time() + timeout
        seen = 0
        while time.time() < deadline:
            for line in self.lines[seen:]:
                if needle in line:
                    return line
            seen = len(self.lines)
            time.sleep(0.1)
        return None

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass
