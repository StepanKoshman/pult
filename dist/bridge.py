#!/usr/bin/env python3
"""Мост WebSocket для браузеров без WebUSB и Web Serial (Firefox, Safari).

Соединяет страницу Пульта с COM-портом прибора: LT1 через адаптер, DM40 через
порт Bluetooth SPP. USB-приборы в Chrome и Edge подключаются без моста.

    pip install pyserial
    python bridge.py COM7            адрес в Пульте: ws://localhost:8765
    python bridge.py COM7 115200 8765
"""
import base64
import hashlib
import socket
import struct
import sys
import threading

import serial

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def handshake(c):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = c.recv(4096)
        if not chunk:
            return False
        data += chunk
    key = [ln.split(b":", 1)[1].strip() for ln in data.split(b"\r\n") if ln.lower().startswith(b"sec-websocket-key")][0]
    accept = base64.b64encode(hashlib.sha1(key + GUID).digest())
    c.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
    return True


def recv_exact(c, n):
    b = b""
    while len(b) < n:
        p = c.recv(n - len(b))
        if not p:
            raise ConnectionError
        b += p
    return b


def send_frame(c, data):
    n = len(data)
    head = bytes([0x82, n]) if n < 126 else bytes([0x82, 126]) + struct.pack(">H", n) if n < 65536 else bytes([0x82, 127]) + struct.pack(">Q", n)
    c.sendall(head + data)


def serve(c, port):
    if not handshake(c):
        return
    stop = threading.Event()

    def pump():
        while not stop.is_set():
            d = port.read(port.in_waiting or 1)
            if d:
                try:
                    send_frame(c, d)
                except OSError:
                    return

    threading.Thread(target=pump, daemon=True).start()
    try:
        while True:
            h = recv_exact(c, 2)
            op, n = h[0] & 15, h[1] & 127
            if n == 126:
                n = struct.unpack(">H", recv_exact(c, 2))[0]
            elif n == 127:
                n = struct.unpack(">Q", recv_exact(c, 8))[0]
            mask = recv_exact(c, 4)
            d = bytes(b ^ mask[i & 3] for i, b in enumerate(recv_exact(c, n)))
            if op == 8:
                break
            if op in (1, 2):
                port.write(d)
    except (ConnectionError, OSError):
        pass
    stop.set()
    c.close()


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    baud = int(sys.argv[2]) if len(sys.argv) > 2 else 115200
    tcp = int(sys.argv[3]) if len(sys.argv) > 3 else 8765
    port = serial.Serial(sys.argv[1], baud, timeout=0.05)
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", tcp))
    s.listen(1)
    print(f"{sys.argv[1]} {baud}, мост на ws://localhost:{tcp}")
    while True:
        c, _ = s.accept()
        serve(c, port)


if __name__ == "__main__":
    main()
