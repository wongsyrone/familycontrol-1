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
BRIDGED = "--bridge" in sys.argv
LAN_DEVICE = "br-lan" if BRIDGED else "lan0"
assert os.geteuid() == 0, "Run with root for isolated network namespaces"
assert (ROOT / "usr/bin/ucode").is_file(), "Supply a disposable OpenWrt rootfs"
assert ROOT != Path("/") and ROOT != REPO and ROOT not in REPO.parents

if "--isolated" not in sys.argv:
    raise SystemExit(subprocess.call([
        "unshare", "--net", "--mount", "--pid", "--fork", "--mount-proc",
        "--propagation", "private", sys.executable, __file__, str(ROOT),
        *sys.argv[2:], "--isolated"
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


def link(process, router, remote, router4, remote4, router6, remote6, master=None):
    run("ip", "link", "add", router, "type", "veth", "peer", "name", remote)
    run("ip", "link", "set", remote, "netns", process.pid)
    if master:
        run("ip", "link", "set", router, "master", master)
    run("ip", "addr", "add", router4, "dev", master or router)
    run("ip", "-6", "addr", "add", router6, "dev", master or router, "nodad")
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
nas, netifd = None, None
run("ip", "link", "set", "lo", "up")
if BRIDGED:
    # Match OpenWrt's sysctl-br-netfilter.conf rather than WSL's bridge defaults.
    bridge_netfilter = {}
    for protocol in ("iptables", "ip6tables", "arptables"):
        setting = "bridge-nf-call-" + protocol
        path = Path("/proc/sys/net/bridge") / setting
        if path.exists():
            run("sysctl", "-q", "-w", f"net.bridge.{setting}=0")
            bridge_netfilter[setting] = path.read_text().strip()
            assert bridge_netfilter[setting] == "0"
    run("ip", "link", "add", "br-lan", "type", "bridge")
    run("ip", "link", "set", "br-lan", "up")
    nas = peer()
    run("ip", "link", "add", "lan1", "type", "veth", "peer", "name", "nas0")
    run("ip", "link", "set", "nas0", "netns", nas.pid)
    run("ip", "link", "set", "lan1", "master", "br-lan")
    run("ip", "link", "set", "lan1", "up")
    in_peer(nas, "ip", "link", "set", "lo", "up")
    in_peer(nas, "ip", "link", "set", "nas0", "up")
    in_peer(nas, "ip", "addr", "add", "10.123.0.3/24", "dev", "nas0")
    in_peer(nas, "ip", "-6", "addr", "add", "fd42:1::3/64", "dev", "nas0", "nodad")
link(client, "lan0", "client0", "10.123.0.1/24", "10.123.0.2/24",
     "fd42:1::1/64", "fd42:1::2/64", master="br-lan" if BRIDGED else None)
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
if BRIDGED:
    (ROOT / "etc/config/network").write_text("""
config interface 'lan'
 option device 'br-lan'
 option proto 'static'
 option ipaddr '10.123.0.1/24'
 list ip6addr 'fd42:1::1/64'
""")
    chroot("uci", "delete", "firewall.@zone[0].device")
    chroot("uci", "add_list", "firewall.@zone[0].network=lan")
    chroot("uci", "commit", "firewall")
    fallback = chroot("ucode", "-e", """
import { cursor } from 'uci';
import { build } from '/usr/share/familycontrol/enforcement.uc';
print(sprintf('%J', build(cursor(), { test: { src_mac: ['00:11:22:33:44:55'] } }).interfaces));
""")
    assert json.loads(fallback.stdout) == ["br-lan"]
    with (ROOT / "tmp/familycontrol-netifd.log").open("w") as log:
        netifd = subprocess.Popen(
            ["/usr/sbin/chroot", str(ROOT), "/sbin/netifd", "-S"], stdout=log, stderr=log)
    for _ in range(100):
        interfaces = chroot("ubus", "call", "network.interface", "dump", check=False)
        network = json.loads(interfaces.stdout or "{}")
        lan = next((item for item in network.get("interface", [])
                    if item["interface"] == "lan"), {})
        # netifd reports up before IPv6 duplicate-address detection finishes.
        addresses = json.loads(run("ip", "-j", "-6", "addr", "show", "br-lan").stdout)[0]["addr_info"]
        ready = any(item["local"] == "fd42:1::1" and
                    not item.get("tentative") and not item.get("dadfailed") for item in addresses)
        if lan.get("up") and lan.get("l3_device") == "br-lan" and ready:
            break
        time.sleep(0.05)
    else:
        raise AssertionError((ROOT / "tmp/familycontrol-netifd.log").read_text())
    bridge = json.loads(run("ip", "-j", "-d", "link", "show", "br-lan").stdout)[0]
    assert bridge["linkinfo"]["info_kind"] == "bridge"
    ports = json.loads(run("ip", "-j", "link", "show", "master", "br-lan").stdout)
    assert {item["ifname"] for item in ports} == {"lan0", "lan1"}
    (ROOT / "tmp/familycontrol-bridge-topology.json").write_text(
        json.dumps({"bridge": bridge, "ports": ports, "netifd": network,
                    "ipv6_addresses": addresses, "bridge_netfilter": bridge_netfilter}, indent=2))
    print("PASS real br-lan with two member ports, UCI startup fallback and netifd LAN resolution", flush=True)
person = rpc("save_person", {"name": "Packet test"})["person"]
rpc("save_device", {"person": person, "name": "Client", "mac": "00:11:22:33:44:55"})
run("ip", "-6", "neigh", "replace", "fd42:1::99", "lladdr", "02:00:00:00:00:99",
    "dev", LAN_DEVICE, "nud", "reachable")
ipv6_device = rpc("save_device", {"person": person, "name": "IPv6 neighbour",
                                "mac": "02:00:00:00:00:99"})["device"]
detected = next(p for p in rpc("status")["people"] if p["id"] == person)
assert next(d for d in detected["devices"] if d["id"] == ipv6_device)["connected"]
candidate = next(d for d in rpc("devices")["devices"] if d["mac"] == "02:00:00:00:00:99")
assert "neighbor" in candidate["sources"] and "fd42:1::99" in candidate["addresses"]
rpc("delete_device", {"device": ipv6_device})
print("PASS IPv6 neighbour discovery and status", flush=True)
services = [server(8443, upstream), server(9000, upstream, True), server(444),
            server(7892), server(9000, udp=True), server(9001, client)]
if BRIDGED:
    services.extend([server(8444, nas), server(9004, nas, True), netifd])
(ROOT / "tmp/dnsmasq-test.conf").write_text(f"""
interface={LAN_DEVICE}
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
    local_tcp = client_socket(client, "10.123.0.1", 7892)
    local_udp = client_socket(client, "10.123.0.1", 9000, True)
    listener = socket.socket()
    listener.bind(("10.123.0.1", 9002))
    listener.listen(1)
    passive = client_socket(client, "10.123.0.1", 9002)
    sender, _ = listener.accept()
    sender.sendall(b"before-pause")
    assert passive.recv(128) == b"before-pause"
    exchange(old_tcp)
    exchange(old_udp)
    exchange(local_tcp)
    exchange(local_udp)
    nas_connections = []
    if BRIDGED:
        for address in ("10.123.0.3", "fd42:1::3"):
            for port, udp in ((8444, False), (9004, True)):
                connection = client_socket(client, address, port, udp)
                exchange(connection)
                nas_connections.append(connection)
    with client_socket(client, "fd42:2::2", 8443) as connection:
        exchange(connection)
    rpc("set_paused", {"person": person, "paused": True})
    assert rpc("status")["enforcement"]["ok"]
    assert rpc("status")["enforcement"]["scope"] == "input"
    if BRIDGED:
        devices = json.loads(run(
            "nft", "-j", "list", "set", "inet", "fw4", "familycontrol_devices").stdout)
        assert next(item["set"] for item in devices["nftables"] if "set" in item)["elem"] == ["br-lan"]
        for connection in nas_connections:
            exchange(connection)
            connection.close()
        for address in ("10.123.0.3", "fd42:1::3"):
            for port, udp in ((8444, False), (9004, True)):
                with client_socket(client, address, port, udp) as connection:
                    exchange(connection)
        route = json.loads(in_peer(client, "ip", "-j", "route", "get", "10.123.0.3").stdout)[0]
        assert route["dev"] == "client0" and "gateway" not in route
        (ROOT / "tmp/familycontrol-bridge-restricted.json").write_text(
            json.dumps({"devices": devices, "nas_route": route,
                        "kernel": json.loads(run("nft", "-j", "list", "table", "inet", "fw4").stdout)},
                       indent=2))
        print("PASS restricted bridged client still reaches same-subnet NAS over new/existing IPv4/IPv6 TCP/UDP", flush=True)
    exchange(old_tcp)
    exchange(old_udp)
    exchange(local_tcp, False)
    exchange(local_udp, False)
    sender.sendall(b"after-pause")
    try:
        received = passive.recv(128)
    except socket.timeout:
        received = b""
    assert not received, "An existing local stream continued after pausing"
    for connection in (local_tcp, local_udp, passive, sender, listener):
        connection.close()
    old_tcp.close()
    old_udp.close()
    for address in ("198.51.100.2", "fd42:2::2"):
        with client_socket(client, address, 8443) as connection:
            exchange(connection)
        with client_socket(client, address, 9000, True) as connection:
            exchange(connection)
    for address in ("10.123.0.1", "fd42:1::1"):
        blocked(client, address, 7892)
        blocked(client, address, 9000, True)
        with client_socket(client, address, 444) as connection:
            exchange(connection)
    for address in ("10.123.0.2", "fd42:1::2"):
        family = socket.AF_INET6 if ":" in address else socket.AF_INET
        connection = socket.socket(family)
        connection.settimeout(0.7)
        connection.connect((address, 9001))
        exchange(connection)
        connection.close()
    print("PASS INPUT TCP/UDP and passive replies blocked; IPv4/IPv6 forwarding, management and router-initiated connections preserved", flush=True)
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
""".replace('"lan0"', f'"{LAN_DEVICE}"'))
    blocked(client, "198.51.100.2", 8443)
    rpc("set_paused", {"person": person, "paused": False})
    with client_socket(client, "198.51.100.2", 8443) as connection:
        exchange(connection)
        rpc("set_paused", {"person": person, "paused": True})
        exchange(connection, False)
    print("PASS redirect path before/after pause, including an existing redirected connection", flush=True)
    adapted = (ROOT / "usr/share/rpcd/ucode/familycontrol").read_text()
    module = ROOT / "usr/share/familycontrol/enforcement.uc"
    adapted_module = module.read_text()
    previous = "956790814560c6c116bdad9f054e3a679a4dfc01"
    baseline = run("git", "-c", f"safe.directory={REPO}", "-C", REPO, "show",
                   previous + ":luci-app-familycontrol/root/usr/share/rpcd/ucode/familycontrol").stdout
    old_module = run("git", "-c", f"safe.directory={REPO}", "-C", REPO, "show",
                     previous + ":luci-app-familycontrol/root/usr/share/familycontrol/enforcement.uc").stdout
    rpc("set_paused", {"person": person, "paused": False})
    module.write_text(old_module)
    restart_api(baseline)
    rpc("set_paused", {"person": person, "paused": True})
    blocked(client, "198.51.100.2", 8443)
    blocked(client, "198.51.100.2", 9000, True)
    retained_config = (ROOT / "etc/config/familycontrol").read_bytes()
    module.write_text(adapted_module)
    restart_api(adapted)
    rpc("tick")
    assert (ROOT / "etc/config/familycontrol").read_bytes() == retained_config
    blocked(client, "198.51.100.2", 8443)
    with client_socket(client, "198.51.100.2", 9000, True) as connection:
        exchange(connection)
    for name in ("familycontrol_prerouting", "familycontrol_forward"):
        chain = run("nft", "-j", "list", "chain", "inet", "fw4", name, check=False)
        if chain.returncode == 0:
            assert not any("rule" in entry for entry in json.loads(chain.stdout)["nftables"])
    assert rpc("status")["enforcement"]["ok"]
    print("PASS r25 upgrade removes WAN/prerouting/forward restrictions and retains INPUT proxy blocking", flush=True)
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
""".replace('"lan0"', f'"{LAN_DEVICE}"'))
    if BRIDGED:
        with (ROOT / "tmp/familycontrol-bridge-tproxy-trace.log").open("w") as log:
            services.append(subprocess.Popen(["nft", "monitor", "trace"], stdout=log, stderr=log))
        run("nft", "-f", "-", input="""table inet familycontrol_test_trace {
 chain prerouting {
  type filter hook prerouting priority -301; policy accept;
  iifname "br-lan" tcp dport 8443 meta nftrace set 1
 }
}
""")
    rpc("set_paused", {"person": person, "paused": False})
    for address in ("198.51.100.2", "fd42:2::2"):
        print("Checking TPROXY", address, flush=True)
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
    if BRIDGED and sys.exc_info()[0]:
        diagnostics = {
            "sysctls": run("sysctl", "net.ipv6.conf.all.forwarding",
                           "net.ipv6.conf.br-lan.forwarding",
                           "net.ipv6.conf.wan0.forwarding",
                           "net.ipv4.conf.all.rp_filter", "net.ipv4.conf.br-lan.rp_filter",
                           "net.ipv4.conf.all.src_valid_mark", "net.ipv4.conf.br-lan.src_valid_mark",
                           "net.bridge.bridge-nf-call-iptables",
                           "net.bridge.bridge-nf-call-ip6tables", check=False).stdout,
            "router_routes4": run("ip", "route", "show", "table", "all").stdout,
            "router_rules4": run("ip", "rule").stdout,
            "router_routes": run("ip", "-6", "route", "show", "table", "all").stdout,
            "router_rules": run("ip", "-6", "rule").stdout,
            "client_routes": in_peer(client, "ip", "-6", "route").stdout,
            "client_neighbors": in_peer(client, "ip", "-6", "neigh").stdout,
            "router_addresses": run("ip", "-j", "addr").stdout,
            "kernel": run("nft", "-j", "list", "table", "inet", "fw4", check=False).stdout,
        }
        (ROOT / "tmp/familycontrol-bridge-failure.json").write_text(json.dumps(diagnostics, indent=2))
    for process in services:
        process.terminate()
    client.terminate()
    upstream.terminate()
    if nas:
        nas.terminate()
