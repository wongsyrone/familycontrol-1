#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Run against a disposable OpenWrt rootfs, entirely inside private namespaces."""

import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import time


REPO = Path(__file__).resolve().parents[1]
ROOT = Path(sys.argv[1]).resolve()
assert os.geteuid() == 0, "Run with root for isolated network namespaces"
assert (ROOT / "usr/bin/ucode").is_file(), "Supply a disposable OpenWrt rootfs"
assert ROOT != Path("/") and ROOT != REPO and ROOT not in REPO.parents

if "--isolated" not in sys.argv:
    raise SystemExit(subprocess.call([
        "unshare", "--net", "--mount", "--pid", "--fork", "--mount-proc",
        "--propagation", "private", sys.executable, __file__, str(ROOT), "--isolated"
    ]))


def run(*args, check=True, **kwargs):
    result = subprocess.run(
        [str(arg) for arg in args], text=True, capture_output=True, **kwargs
    )
    if check and result.returncode:
        raise AssertionError(f"{args}: {result.stderr[-2000:]} {result.stdout[-2000:]}")
    return result


def chroot(*args, **kwargs):
    return run("/usr/sbin/chroot", ROOT, *args, **kwargs)


def rpc(method, args=None, ok=True):
    reply = json.loads(chroot("ubus", "call", "familycontrol", method,
                              json.dumps(args or {})).stdout)
    assert reply.get("ok") is ok, reply
    return reply


def peer():
    process = subprocess.Popen(["unshare", "--net", "sleep", "infinity"])
    for _ in range(100):
        if os.readlink(f"/proc/{process.pid}/ns/net") != os.readlink("/proc/self/ns/net"):
            return process
        time.sleep(0.01)
    raise AssertionError("Peer namespace did not start")


def in_peer(process, *args, **kwargs):
    return run("nsenter", "-t", process.pid, "-n", *args, **kwargs)


def link(process, router, remote, router4, remote4, router6, remote6):
    run("ip", "link", "add", router, "type", "veth", "peer", "name", remote)
    run("ip", "link", "set", remote, "netns", process.pid)
    run("ip", "addr", "add", router4, "dev", router)
    run("ip", "-6", "addr", "add", router6, "dev", router, "nodad")
    run("ip", "link", "set", router, "up")
    in_peer(process, "ip", "link", "set", "lo", "up")
    in_peer(process, "ip", "link", "set", remote, "up")
    in_peer(process, "ip", "addr", "add", remote4, "dev", remote)
    in_peer(process, "ip", "-6", "addr", "add", remote6, "dev", remote, "nodad")
    in_peer(process, "ip", "route", "add", "default", "via", router4.split("/")[0])
    in_peer(process, "ip", "-6", "route", "add", "default", "via", router6.split("/")[0])


def client_socket(process, address, port, udp=False):
    original = os.open("/proc/self/ns/net", os.O_RDONLY)
    target = os.open(f"/proc/{process.pid}/ns/net", os.O_RDONLY)
    try:
        os.setns(target, 0)
        family = socket.AF_INET6 if ":" in address else socket.AF_INET
        connection = socket.socket(family, socket.SOCK_DGRAM if udp else socket.SOCK_STREAM)
        connection.settimeout(0.7)
        connection.connect((address, port))
        return connection
    finally:
        os.setns(original, 0)
        os.close(original)
        os.close(target)


def exchange(connection, expected=True):
    try:
        connection.send(b"familycontrol")
        received = connection.recv(128)
        success = received == b"familycontrol"
    except OSError:
        success = False
    assert success is expected, ("unexpected packet result", expected)


def blocked(process, address, port, udp=False):
    try:
        connection = client_socket(process, address, port, udp)
    except OSError:
        return
    with connection:
        exchange(connection, False)


SERVER = """
import socket, socketserver, sys
class TCP(socketserver.ThreadingTCPServer):
    address_family = socket.AF_INET6
    allow_reuse_address = True
    daemon_threads = True
    def server_bind(self):
        self.socket.setsockopt(socket.SOL_IP, 19, 1)
        super().server_bind()
class UDP(socketserver.ThreadingUDPServer):
    address_family = socket.AF_INET6
    allow_reuse_address = True
    daemon_threads = True
class Stream(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            try:
                data = self.request.recv(4096)
            except ConnectionResetError:
                return
            if not data: return
            self.request.sendall(data)
class Datagram(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        sock.sendto(data, self.client_address)
kind, port = sys.argv[1], int(sys.argv[2])
(UDP if kind == "udp" else TCP)(("::", port), Datagram if kind == "udp" else Stream).serve_forever()
"""


def server(port, process=None, udp=False):
    command = [sys.executable, "-c", SERVER, "udp" if udp else "tcp", str(port)]
    if process:
        command = ["nsenter", "-t", str(process.pid), "-n", *command]
    return subprocess.Popen(command, stdout=subprocess.DEVNULL)

def restart_api(source):
    plugin = ROOT / "usr/share/rpcd/ucode/familycontrol"
    plugin.write_text(source)
    chroot("killall", "rpcd", check=False)
    with (ROOT / "tmp/familycontrol-rpcd.log").open("a") as log:
        subprocess.Popen(["/usr/sbin/chroot", str(ROOT), "rpcd"], stdout=log, stderr=log)
    for _ in range(100):
        if "familycontrol" in chroot("ubus", "list").stdout:
            return
        time.sleep(0.02)
    raise AssertionError("RPC backend did not start")


run("mount", "--bind", "/dev", ROOT / "dev")
run("mount", "-t", "proc", "proc", ROOT / "proc")
(ROOT / "src").mkdir(exist_ok=True)
run("mount", "--bind", REPO, ROOT / "src")
run("mount", "-o", "remount,bind,ro", ROOT / "src")
shutil.copytree(REPO / "luci-app-familycontrol/root", ROOT, dirs_exist_ok=True)
for name in ("var/run/ubus", "var/lock"):
    (ROOT / name).mkdir(parents=True, exist_ok=True)
client, upstream = peer(), peer()
run("ip", "link", "set", "lo", "up")
link(client, "lan0", "client0", "10.123.0.1/24", "10.123.0.2/24",
     "fd42:1::1/64", "fd42:1::2/64")
link(upstream, "wan0", "server0", "198.51.100.1/24", "198.51.100.2/24",
     "fd42:2::1/64", "fd42:2::2/64")
in_peer(client, "ip", "link", "set", "client0", "address", "00:11:22:33:44:55")
run("sysctl", "-q", "-w", "net.ipv4.ip_forward=1", "net.ipv6.conf.all.forwarding=1")
shutil.copyfile(REPO / "tests/fixtures/firewall-config", ROOT / "etc/config/firewall")
(ROOT / "etc/config/dropbear").write_text("config dropbear\n option Port 444\n")
chroot("/usr/libexec/familycontrol-firewall", "prepare")
assert run("nft", "list", "table", "inet", "fw4", check=False).returncode != 0
print("PASS startup preparation before fw4 and rpcd", flush=True)
chroot("sh", "-x", "/src/tests/openwrt-integration.sh")
print("PASS upstream business, rollback, expiry and no-op checks", flush=True)
person = rpc("save_person", {"name": "Packet test"})["person"]
rpc("save_device", {"person": person, "name": "Client", "mac": "00:11:22:33:44:55"})
run("ip", "-6", "neigh", "replace", "fd42:1::99", "lladdr", "02:00:00:00:00:99",
    "dev", "lan0", "nud", "reachable")
ipv6_device = rpc("save_device", {"person": person, "name": "IPv6 neighbour",
                                "mac": "02:00:00:00:00:99"})["device"]
detected = next(p for p in rpc("status")["people"] if p["id"] == person)
assert next(d for d in detected["devices"] if d["id"] == ipv6_device)["connected"]
candidate = next(d for d in rpc("devices")["devices"] if d["mac"] == "02:00:00:00:00:99")
assert "neighbor" in candidate["sources"] and "fd42:1::99" in candidate["addresses"]
rpc("delete_device", {"device": ipv6_device})
print("PASS IPv6 neighbour discovery and status", flush=True)
services = [server(8443, upstream), server(9000, upstream, True), server(444), server(7892)]
(ROOT / "tmp/dnsmasq-test.conf").write_text("""
interface=lan0
bind-interfaces
user=root
no-resolv
address=/familycontrol.test/192.0.2.123
dhcp-range=10.123.0.100,10.123.0.110,255.255.255.0,1h
dhcp-authoritative
dhcp-leasefile=/tmp/familycontrol-test.leases
""")
services.append(subprocess.Popen([
    "/usr/sbin/chroot", str(ROOT), "dnsmasq", "--no-daemon",
    "--conf-file=/tmp/dnsmasq-test.conf"
], stdout=subprocess.DEVNULL, stderr=(ROOT / "tmp/familycontrol-dnsmasq.log").open("w")))
time.sleep(0.3)
assert services[-1].poll() is None, (ROOT / "tmp/familycontrol-dnsmasq.log").read_text()
try:
    old_tcp = client_socket(client, "198.51.100.2", 8443)
    old_udp = client_socket(client, "198.51.100.2", 9000, True)
    exchange(old_tcp)
    exchange(old_udp)
    with client_socket(client, "fd42:2::2", 8443) as connection:
        exchange(connection)
    rpc("set_paused", {"person": person, "paused": True})
    assert rpc("status")["enforcement"]["ok"]
    exchange(old_tcp, False)
    exchange(old_udp, False)
    old_tcp.close()
    old_udp.close()
    blocked(client, "198.51.100.2", 8443)
    blocked(client, "fd42:2::2", 8443)
    blocked(client, "198.51.100.2", 9000, True)
    blocked(client, "10.123.0.1", 7892)
    with client_socket(client, "10.123.0.1", 444) as connection:
        exchange(connection)
    print("PASS IPv4/IPv6 direct, existing TCP/UDP, explicit proxy denial and local management", flush=True)
    query = bytes.fromhex("1234010000010000000000000d66616d696c79636f6e74726f6c04746573740000010001")
    for address in ("10.123.0.1", "fd42:1::1"):
        print("Checking DNS", address, flush=True)
        with client_socket(client, address, 53, True) as connection:
            connection.send(query)
            assert b"\xc0\x00\x02\x7b" in connection.recv(1024)
    original = os.open("/proc/self/ns/net", os.O_RDONLY)
    target = os.open(f"/proc/{client.pid}/ns/net", os.O_RDONLY)
    os.setns(target, 0)
    capture = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0800))
    capture.bind(("client0", 0))
    os.setns(original, 0)
    os.close(original)
    os.close(target)
    dhcp = in_peer(client, "/usr/sbin/chroot", ROOT, "udhcpc", "-i", "client0",
                   "-B", "-n", "-q", "-t", "3", "-T", "1", "-s", "/bin/true", check=False)
    capture.setblocking(False)
    packets = []
    while True:
        try:
            frame = capture.recv(4096)
        except BlockingIOError:
            break
        if len(frame) < 42 or frame[23] != 17:
            continue
        offset = 14 + (frame[14] & 15) * 4
        sport, dport, length, checksum = struct.unpack("!4H", frame[offset:offset + 8])
        if {sport, dport} != {67, 68}:
            continue
        packets.append({"src": socket.inet_ntoa(frame[26:30]), "dst": socket.inet_ntoa(frame[30:34]),
                        "sport": sport, "dport": dport, "length": length,
                        "checksum": checksum, "payload": frame[offset + 8:].hex()})
    (ROOT / "tmp/familycontrol-dhcp-packets.json").write_text(json.dumps(packets, indent=2))
    assert dhcp.returncode == 0, dhcp.stderr + dhcp.stdout
    assert "lease of 10.123.0." in dhcp.stdout + dhcp.stderr
    unicast = in_peer(client, "/usr/sbin/chroot", ROOT, "udhcpc", "-i", "client0",
                      "-n", "-q", "-t", "3", "-T", "1", "-s", "/bin/true")
    assert "lease of 10.123.0." in unicast.stdout + unicast.stderr
    capture.close()
    print("PASS local IPv4/IPv6 DNS and real DHCP acquisition while paused", flush=True)
    run("nft", "-f", "-", input="""table inet nikki_test {
 chain prerouting {
  type nat hook prerouting priority -99; policy accept;
  iifname "lan0" tcp dport 8443 redirect to :7892
 }
}
""")
    blocked(client, "198.51.100.2", 8443)
    rpc("set_paused", {"person": person, "paused": False})
    with client_socket(client, "198.51.100.2", 8443) as connection:
        exchange(connection)
        rpc("set_paused", {"person": person, "paused": True})
        exchange(connection, False)
    print("PASS redirect path before/after pause, including an existing redirected connection", flush=True)
    adapted = (ROOT / "usr/share/rpcd/ucode/familycontrol").read_text()
    baseline = run("git", "-c", f"safe.directory={REPO}", "-C", REPO, "show",
                   "b20760068780f659ac957ca09d1d7f6f8d1f6c21:"
                   "luci-app-familycontrol/root/usr/share/rpcd/ucode/familycontrol").stdout
    rpc("set_paused", {"person": person, "paused": False})
    restart_api(baseline)
    (ROOT / "var/run/familycontrol/enforcement.nft").write_text("# Unmodified upstream baseline\n")
    rpc("set_paused", {"person": person, "paused": True})
    with client_socket(client, "198.51.100.2", 8443) as connection:
        exchange(connection)
    restart_api(adapted)
    rpc("tick")
    blocked(client, "198.51.100.2", 8443)
    print("PASS upstream redirect bypass reproduced and fixed by the adapted backend", flush=True)
    run("nft", "delete", "table", "inet", "nikki_test")
    run("ip", "rule", "add", "fwmark", "0x80", "lookup", "100")
    run("ip", "route", "add", "local", "0.0.0.0/0", "dev", "lo", "table", "100")
    run("ip", "-6", "rule", "add", "fwmark", "0x80", "lookup", "100")
    run("ip", "-6", "route", "add", "local", "::/0", "dev", "lo", "table", "100")
    run("nft", "-f", "-", input="""table inet nikki_test {
 chain prerouting {
  type filter hook prerouting priority -150; policy accept;
  iifname "lan0" tcp dport 8443 meta mark set 0x80 tproxy to :7892 accept
 }
}
""")
    rpc("set_paused", {"person": person, "paused": False})
    for address in ("198.51.100.2", "fd42:2::2"):
        with client_socket(client, address, 8443) as connection:
            exchange(connection)
    rpc("set_paused", {"person": person, "paused": True})
    blocked(client, "198.51.100.2", 8443)
    blocked(client, "fd42:2::2", 8443)
    print("PASS IPv4/IPv6 TCP TPROXY path and pause", flush=True)
    reloads = (ROOT / "tmp/firewall-reloads").read_text()
    rpc("tick")
    assert (ROOT / "tmp/firewall-reloads").read_text() == reloads
    run("nft", "flush", "chain", "inet", "fw4", "familycontrol_client")
    assert rpc("status")["enforcement"]["ok"] is False
    rpc("tick")
    assert rpc("status")["enforcement"]["ok"] is True
    blocked(client, "198.51.100.2", 8443)
    print("PASS no-op tick and repair after actual kernel rule loss", flush=True)

    # Exercise the installed scheduler using real seconds and real nftables.
    now = int(chroot("date", "+%s").stdout)
    def clock_fields(value):
        return chroot("date", "-d", f"@{value}", "+%Y-%m-%d %H:%M:%S").stdout.strip().split()

    date, start = clock_fields(now + 5)
    end_date, end = clock_fields(now + 11)
    rpc("save_schedule", {"person": person, "format": "windows", "policy": "block",
                         "windows": [
                             {"repeat": "daily", "all_day": True, "action": "allow", "priority": 0},
                             {"repeat": "range", "start_date": date, "end_date": end_date,
                              "start": start, "end": end, "action": "block", "priority": 10}]})
    rpc("set_mode", {"person": person, "mode": "schedule"})
    scheduled_connection = client_socket(client, "198.51.100.2", 8443)
    exchange(scheduled_connection)
    scheduler = subprocess.Popen(
        ["/usr/sbin/chroot", str(ROOT), "/usr/sbin/familycontrol-scheduler"],
        stdout=subprocess.DEVNULL, stderr=(ROOT / "tmp/familycontrol-scheduler.log").open("w"))
    try:
        while time.time() < now + 7:
            time.sleep(0.05)
        assert scheduler.poll() is None, (ROOT / "tmp/familycontrol-scheduler.log").read_text()
        exchange(scheduled_connection, False)
        reason = next(p for p in rpc("status")["people"] if p["id"] == person)["reason"]
        assert reason["winning_rules"] == [2] and reason["priority"] == 10 and not reason["online"], reason
        blocked(client, "198.51.100.2", 8443)
        blocked(client, "fd42:2::2", 8443)
        while time.time() < now + 13:
            time.sleep(0.05)
        with client_socket(client, "198.51.100.2", 8443) as connection:
            exchange(connection)
        assert rpc("status")["enforcement"]["ok"]
    finally:
        scheduled_connection.close()
        scheduler.terminate()
        scheduler.wait(timeout=5)
    rpc("set_mode", {"person": person, "mode": "online"})
    invalid = rpc("save_schedule", {"person": person, "format": "windows", "policy": "block",
                                   "windows": [{"repeat": "weekly", "days": [], "start": start, "end": end}]},
                  ok=False)
    assert invalid["code"] == "invalid_schedule"
    assert rpc("status")["enforcement"]["ok"]
    print("PASS real scheduler: mixed-priority exception, second boundaries, existing/new IPv4/IPv6 and recovery", flush=True)

    # Interpose only the clock and bus transport in a scratch copy; retain the
    # production loop so clock-correction handling is tested without changing WSL time.
    source = (ROOT / "usr/sbin/familycontrol-scheduler").read_text()
    source = source.replace("import { readfile }", "import { readfile, writefile }")
    source = source.replace("const now = time();", "const now = +readfile('/tmp/scheduler-clock');")
    tick_call = "result = bus?.call('familycontrol', 'tick', { clock_changed: !!clockChanged });"
    assert source.count(tick_call) == 1, "scheduler tick interception no longer matches"
    source = source.replace(tick_call, """
        result = {ok: true};
        writefile('/var/run/familycontrol/next-check', '' + (now + 1000));
        writefile('/tmp/scheduler-calls', (readfile('/tmp/scheduler-calls') || '') +
            sprintf('%d:%d\\n', now, !!clockChanged));
    """)
    source = source.replace("sleep(1000 - int(clock()[1] / 1000000));", "sleep(100);")
    (ROOT / "tmp/scheduler-clock-probe.uc").write_text(source)
    (ROOT / "tmp/scheduler-calls").write_text("")
    (ROOT / "tmp/scheduler-clock").write_text("1000")
    (ROOT / "var/run/familycontrol/next-check").write_text("0")
    probe = subprocess.Popen(["/usr/sbin/chroot", str(ROOT), "ucode", "/tmp/scheduler-clock-probe.uc"])
    try:
        for value, expected in [(1000, ["1000:0"]), (1001, ["1000:0"]),
                                (1008, ["1000:0", "1008:1"]),
                                (900, ["1000:0", "1008:1", "900:1"])]:
            (ROOT / "tmp/scheduler-clock").write_text(str(value))
            time.sleep(0.35)
            assert (ROOT / "tmp/scheduler-calls").read_text().splitlines() == expected
        assert probe.poll() is None
    finally:
        probe.terminate()
        probe.wait(timeout=5)
    rpc("tick")
    print("PASS scheduler clock jumps forward/backward and idle loop without repeated reconcile", flush=True)

    rpc("set_mode", {"person": person, "mode": "paused"})
    chroot("uci", "set", "firewall.@defaults[0].flow_offloading=1")
    chroot("uci", "commit", "firewall")
    failure = rpc("save_device", {
        "person": person, "name": "Offload", "mac": "02:00:00:00:00:99"
    }, ok=False)
    assert "offloading" in failure["message"], failure
    chroot("uci", "set", "firewall.@defaults[0].flow_offloading=0")
    chroot("uci", "commit", "firewall")
    rpc("set_paused", {"person": person, "paused": False})
    with client_socket(client, "198.51.100.2", 8443) as connection:
        exchange(connection)
    print("PASS offload rejection and access recovery", flush=True)
finally:
    for process in services:
        process.terminate()
    client.terminate()
    upstream.terminate()
