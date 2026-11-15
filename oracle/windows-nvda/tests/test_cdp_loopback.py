#!/usr/bin/env python3
"""Echte eigene Loopback-Sockets; kein NVDA, Browser, Gast oder Container."""
import argparse
import ast
import hashlib
import http.client
import json
from pathlib import Path
import select
import socket
from socketserver import BaseRequestHandler
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

PLUGIN_PATH = (
    Path(__file__).parents[1]
    / "oem/hoosaidthat/nvdaConfig/scratchpad/globalPlugins/hoosaidthatControl.py"
)
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=PLUGIN_PATH)
    parser.add_argument("--receipts", type=Path)
    options, test_args = parser.parse_known_args()
else:
    options = SimpleNamespace(source=PLUGIN_PATH, receipts=None)
    test_args = []
source_path = options.source
source_bytes = source_path.read_bytes()
source_sha = hashlib.sha256(source_bytes).hexdigest()
tree = ast.parse(source_bytes.decode())
handler_node = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "CdpProxyHandler")
handler_code = compile(ast.Module(body=[handler_node], type_ignores=[]), str(source_path), "exec")
receipt_root = options.receipts
if receipt_root is not None:
    receipt_root.mkdir(exist_ok=True)
REQUEST = b"GET /json/version HTTP/1.1\r\nHost: synthetic.invalid\r\nConnection: keep-alive\r\n\r\n"
BODY = b"{}"
RESPONSE = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n" + BODY

class MappedSocket:
    def __init__(self, fixture, family, kind):
        self.fixture = fixture
        self.real = socket.socket(family, kind)
        self.family = family
        self.closed = False
        fixture.created.append(self)

    def connect(self, address):
        host, port = address
        self.fixture.validate_address(address)
        self.fixture.attempts.append({"host": host, "requestedPort": port, "mode": "nonblocking"})
        return self.real.connect((host, self.fixture.upstream_port))

    def close(self):
        self.closed = True
        return self.real.close()

    def __getattr__(self, name):
        return getattr(self.real, name)

class Fixture:
    def __init__(self, family):
        self.family = family
        self.stop = threading.Event()
        self.errors = []
        self.attempts = []
        self.created = []
        self.peer_addresses = []
        self.listeners = []
        self.threads = []
        self.bind_upstream_pair()
        self.proxy = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.proxy.bind(("127.0.0.1", 0))
        self.proxy.listen(1)
        self.proxy.settimeout(0.05)
        self.listeners.append(self.proxy)
        module = SimpleNamespace(
            create_connection=self.create_connection,
            socket=lambda family, kind: MappedSocket(self, family, kind),
            AF_INET=socket.AF_INET, AF_INET6=socket.AF_INET6,
            SOCK_STREAM=socket.SOCK_STREAM, SOL_SOCKET=socket.SOL_SOCKET,
            SO_ERROR=socket.SO_ERROR, SHUT_WR=socket.SHUT_WR,
        )
        scope = {"BaseRequestHandler": BaseRequestHandler, "socket": module, "select": select, "time": time}
        exec(handler_code, scope)
        self.handler = scope["CdpProxyHandler"]

    def bind_upstream_pair(self):
        address = "::1" if self.family == socket.AF_INET6 else "127.0.0.1"
        other_family = socket.AF_INET if self.family == socket.AF_INET6 else socket.AF_INET6
        other_address = "127.0.0.1" if other_family == socket.AF_INET else "::1"
        for _ in range(20):
            listener = socket.socket(self.family, socket.SOCK_STREAM)
            blocker = socket.socket(other_family, socket.SOCK_STREAM)
            try:
                if self.family == socket.AF_INET6:
                    listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                if other_family == socket.AF_INET6:
                    blocker.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                listener.bind((address, 0))
                port = listener.getsockname()[1]
                blocker.bind((other_address, port))
                listener.listen(1)
                listener.settimeout(0.05)
                self.upstream, self.blocker, self.upstream_port = listener, blocker, port
                self.listeners.extend([listener, blocker])
                return
            except OSError:
                listener.close()
                blocker.close()
        raise RuntimeError("Kein isoliertes Loopback-Portpaar verfügbar")

    def validate_address(self, address):
        if address[0] not in {"::1", "127.0.0.1"} or address[1] != 9223:
            raise AssertionError("Verbindung außerhalb der zwei numerischen Loopback-Ziele")

    def create_connection(self, address, timeout):
        self.validate_address(address)
        self.attempts.append({"host": address[0], "requestedPort": address[1], "mode": "blocking", "timeoutSeconds": timeout})
        return socket.create_connection((address[0], self.upstream_port), timeout=timeout)

    def start_worker(self, function):
        def guarded():
            try:
                function()
            except OSError as error:
                if not self.stop.is_set():
                    self.errors.append(type(error).__name__)
            except Exception as error:
                self.errors.append(type(error).__name__)
        thread = threading.Thread(target=guarded, daemon=True)
        self.threads.append(thread)
        thread.start()

    def accept(self, listener):
        while not self.stop.is_set():
            try:
                return listener.accept()
            except socket.timeout:
                continue
        return None, None

    def serve_upstream(self):
        connection, address = self.accept(self.upstream)
        if connection is None:
            return
        self.peer_addresses.append(address[0])
        with connection:
            connection.settimeout(0.05)
            request = bytearray()
            while not self.stop.is_set() and b"\r\n\r\n" not in request:
                try:
                    data = connection.recv(4096)
                except socket.timeout:
                    continue
                if not data:
                    return
                request.extend(data)
                if len(request) > 65536:
                    raise AssertionError("Unerwartet große synthetische Anfrage")
            connection.sendall(RESPONSE)
            # Keine EOF-Vermischung: Gegenstelle bleibt bis zum Clientende offen.
            while not self.stop.is_set():
                try:
                    if not connection.recv(4096):
                        break
                except socket.timeout:
                    continue

    def serve_proxy(self):
        connection, address = self.accept(self.proxy)
        if connection is not None:
            with connection:
                self.handler(connection, address, None)

    def request(self):
        self.start_worker(self.serve_upstream)
        self.start_worker(self.serve_proxy)
        result = {"status": None, "bodyBytes": 0}
        started = time.monotonic()
        response = None
        with socket.create_connection(self.proxy.getsockname(), timeout=2) as client:
            client.sendall(REQUEST)
            try:
                response = http.client.HTTPResponse(client)
                response.begin()
                body = response.read()
                result.update(status=response.status, bodyBytes=len(body), bodySha256=hashlib.sha256(body).hexdigest())
            except (http.client.HTTPException, OSError) as error:
                result["errorType"] = type(error).__name__
            finally:
                if response is not None:
                    response.close()
        result["elapsedMs"] = round((time.monotonic() - started) * 1000, 3)
        return result

    def close(self):
        self.stop.set()
        for listener in self.listeners:
            listener.close()
        for thread in self.threads:
            thread.join(timeout=1)

class LoopbackFamilienRegressionen(unittest.TestCase):
    def exercise(self, family, name):
        fixture = Fixture(family)
        try:
            observation = fixture.request()
        finally:
            fixture.close()
        record = {
            "sourceSha256": source_sha,
            "chromeListenerFamily": name,
            "chromeBind": "::1" if family == socket.AF_INET6 else "127.0.0.1",
            "otherFamilyReservedWithoutListener": True,
            "proxyBind": "127.0.0.1",
            "fixedSourcePortMappedToOwnedEphemeralPort": True,
            "observation": observation,
            "connectAttempts": fixture.attempts,
            "upstreamPeerAddresses": fixture.peer_addresses,
            "workerErrors": fixture.errors,
            "allWorkersStopped": all(not thread.is_alive() for thread in fixture.threads),
            "allCandidateSocketsClosed": all(endpoint.closed for endpoint in fixture.created),
            "realGuestBrowserNativeOrContainerCalls": False,
            "eofCaseDeliberatelyExcluded": True,
        }
        if receipt_root is not None:
            (receipt_root / (name + ".json")).write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
        self.assertEqual(fixture.errors, [])
        self.assertTrue(record["allWorkersStopped"])
        self.assertTrue(record["allCandidateSocketsClosed"])
        self.assertEqual(observation["status"], 200, "HTTP-Antwort der vorhandenen Loopback-Familie")
        self.assertEqual(observation["bodyBytes"], len(BODY))
        self.assertEqual(observation["bodySha256"], hashlib.sha256(BODY).hexdigest())
        self.assertLess(observation["elapsedMs"], 1500, "Keine vorgeschaltete Verzögerung um zwei Sekunden")

    def test_ipv6_only_chrome_wird_ohne_ipv4_listener_erreicht(self):
        self.exercise(socket.AF_INET6, "ipv6-only")

    def test_ipv4_only_chrome_bleibt_ohne_ipv6_listener_erreichbar(self):
        self.exercise(socket.AF_INET, "ipv4-only")


class LoopbackVerbindungsRegressionen(unittest.TestCase):
    def connector(self, error=None):
        ipv6, ipv4 = mock.Mock(), mock.Mock()
        for endpoint in (ipv6, ipv4):
            endpoint.connect.side_effect = error or BlockingIOError()
            endpoint.getsockopt.return_value = 0
        socket_module = SimpleNamespace(
            socket=mock.Mock(side_effect=[ipv6, ipv4]),
            AF_INET=socket.AF_INET, AF_INET6=socket.AF_INET6,
            SOCK_STREAM=socket.SOCK_STREAM, SOL_SOCKET=socket.SOL_SOCKET,
            SO_ERROR=socket.SO_ERROR,
        )
        select_function = mock.Mock(return_value=([], [ipv4], []))
        clock = mock.Mock(return_value=0.0)
        scope = {
            "BaseRequestHandler": BaseRequestHandler,
            "socket": socket_module,
            "select": SimpleNamespace(select=select_function),
            "time": SimpleNamespace(monotonic=clock),
        }
        exec(handler_code, scope)
        return (
            scope["CdpProxyHandler"]._connect_chrome_loopback,
            ipv6, ipv4, select_function, clock,
        )

    def assert_both_attempted(self, ipv6, ipv4):
        ipv6.connect.assert_called_once_with(("::1", 9223))
        ipv4.connect.assert_called_once_with(("127.0.0.1", 9223))
        ipv6.setblocking.assert_called_once_with(False)
        ipv4.setblocking.assert_called_once_with(False)

    def test_langsame_ipv6_verbindung_blockiert_ipv4_nicht(self):
        connect, ipv6, ipv4, select_function, _ = self.connector()

        def ipv4_ready(readable, writable, exceptional, timeout):
            self.assertEqual(readable, [])
            self.assertEqual(writable, [ipv6, ipv4])
            self.assertEqual(exceptional, [ipv6, ipv4])
            self.assertEqual(timeout, 3.0)
            return [], [ipv4], []

        select_function.side_effect = ipv4_ready
        self.assertIs(connect(), ipv4)
        self.assert_both_attempted(ipv6, ipv4)
        select_function.assert_called_once()
        ipv6.close.assert_called_once_with()
        ipv4.close.assert_not_called()

    def test_windows_pending_codes_bleiben_als_oserror_in_der_auswahl(self):
        for attribute in ("errno", "winerror"):
            for code in (10035, 10036, 10037):
                with self.subTest(attribute=attribute, code=code):
                    error = OSError("synthetic Winsock pending connect")
                    setattr(error, attribute, code)
                    connect, ipv6, ipv4, _, _ = self.connector(error)
                    self.assertIs(connect(), ipv4)
                    self.assert_both_attempted(ipv6, ipv4)
                    ipv6.close.assert_called_once_with()
                    ipv4.close.assert_not_called()

    def test_beide_familien_teilen_drei_sekunden_und_schliessen_bei_timeout(self):
        connect, ipv6, ipv4, select_function, clock = self.connector()
        clock.side_effect = [0.0, 0.0, 1.0, 3.0]
        select_function.return_value = ([], [], [])
        self.assertIsNone(connect())
        self.assert_both_attempted(ipv6, ipv4)
        self.assertEqual([call.args[3] for call in select_function.call_args_list], [3.0, 2.0])
        ipv6.close.assert_called_once_with()
        ipv4.close.assert_called_once_with()

    def test_fehlgeschlagener_kandidat_wird_vor_gewinner_geschlossen(self):
        connect, ipv6, ipv4, select_function, _ = self.connector()
        ipv6.getsockopt.return_value = 10061
        select_function.return_value = ([], [ipv6, ipv4], [ipv6])
        self.assertIs(connect(), ipv4)
        self.assert_both_attempted(ipv6, ipv4)
        ipv6.close.assert_called_once_with()
        ipv4.close.assert_not_called()

    def test_socketfehler_schliesst_alle_ausstehenden_kandidaten(self):
        connect, ipv6, ipv4, select_function, _ = self.connector()
        ipv4.getsockopt.side_effect = OSError("synthetic socket status failure")
        with self.assertRaises(OSError):
            connect()
        self.assert_both_attempted(ipv6, ipv4)
        ipv6.close.assert_called_once_with()
        ipv4.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main(argv=[str(Path(__file__).name), *test_args])
