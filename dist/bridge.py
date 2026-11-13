#!/usr/bin/env python3
"""Мост WebSocket для браузеров без WebUSB и Web Serial (Firefox, Safari).

Соединяет страницу Пульта с COM-портом прибора: LT1 через адаптер, DM40 через
порт Bluetooth SPP. USB-приборы в Chrome и Edge подключаются без моста.

    pip install pyserial
    python bridge.py COM7            адрес в Пульте: ws://localhost:8765
    python bridge.py COM7 115200 8765

C2 по USB (кнопка «C2 через мост»): мост открывает вендорный интерфейс C2 через
libusb. В Windows нужен драйвер WinUSB, его система ставит сама.

    pip install pyusb libusb-package
    python bridge.py c2              адрес в Пульте: ws://localhost:8765
    python bridge.py c2 8765

Вход в обновление прошивки (команда 15) мост пропускает, только если страница
перед ней прислала строку «!update».
"""
import base64
import hashlib
import socket
import struct
import sys
import threading

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


C2_VID = 0x2E88


def c2_open():
    """Первый C2 (или его загрузчик) с вендорным интерфейсом: (устройство, вход, выход)."""
    import usb.core
    import usb.util
    try:
        import libusb_package
        backend = libusb_package.get_libusb1_backend()
    except ImportError:
        backend = None
    dev = usb.core.find(idVendor=C2_VID, backend=backend)
    if dev is None:
        return None
    try:
        dev.set_configuration()
    except usb.core.USBError:
        pass
    for intf in dev.get_active_configuration():
        if intf.bInterfaceClass != 0xFF:
            continue
        ep_in = ep_out = None
        for e in intf:
            if usb.util.endpoint_type(e.bmAttributes) != usb.util.ENDPOINT_TYPE_BULK:
                continue
            if usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_IN:
                ep_in = e
            else:
                ep_out = e
        if ep_in and ep_out:
            try:
                if dev.is_kernel_driver_active(intf.bInterfaceNumber):
                    dev.detach_kernel_driver(intf.bInterfaceNumber)
            except (NotImplementedError, usb.core.USBError):
                pass
            usb.util.claim_interface(dev, intf.bInterfaceNumber)
            return dev, ep_in, ep_out
    usb.util.dispose_resources(dev)
    return None


def serve_c2(c):
    """Одно подключение страницы: свой сеанс USB. Прибора нет или он пропал
    (перезапуск в загрузчик): сокет закрывается, страница подключается снова."""
    import usb.core
    import usb.util
    if not handshake(c):
        return
    try:
        found = c2_open()
    except (usb.core.USBError, usb.core.NoBackendError) as e:
        print("C2:", e)
        found = None
    if not found:
        c.close()
        return
    dev, ep_in, ep_out = found
    stop = threading.Event()

    def pump():
        while not stop.is_set():
            try:
                d = ep_in.read(ep_in.wMaxPacketSize * 64, timeout=100)
            except usb.core.USBTimeoutError:
                continue
            except usb.core.USBError:
                break
            if d:
                try:
                    send_frame(c, bytes(d))
                except OSError:
                    break
        stop.set()
        try:
            c.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    threading.Thread(target=pump, daemon=True).start()
    armed = False
    try:
        while not stop.is_set():
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
            if op == 1 and d.strip() == b"!update":
                armed = True
                continue
            if op not in (1, 2):
                continue
            if len(d) >= 2 and d[0] == 0xEE and d[1] == 0x0F:
                if not armed:
                    print("C2: команда 15 (обновление) без «!update», не передана")
                    continue
                armed = False
            ep_out.write(d, timeout=1000)
    except (ConnectionError, OSError, usb.core.USBError):
        pass
    stop.set()
    try:
        usb.util.dispose_resources(dev)
    except usb.core.USBError:
        pass
    c.close()


def listen(tcp):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", tcp))
    s.listen(1)
    return s


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    if sys.argv[1].lower() == "c2":
        tcp = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
        s = listen(tcp)
        print(f"C2 по USB, мост на ws://localhost:{tcp}")
        while True:
            c, _ = s.accept()
            serve_c2(c)
    baud = int(sys.argv[2]) if len(sys.argv) > 2 else 115200
    tcp = int(sys.argv[3]) if len(sys.argv) > 3 else 8765
    import serial

    port = serial.Serial(sys.argv[1], baud, timeout=0.05)
    s = listen(tcp)
    print(f"{sys.argv[1]} {baud}, мост на ws://localhost:{tcp}")
    while True:
        c, _ = s.accept()
        serve(c, port)


if __name__ == "__main__":
    main()
