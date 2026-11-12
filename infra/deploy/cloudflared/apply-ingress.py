#!/usr/bin/env python3
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

CONFIG = "/etc/cloudflared/config.yml"
SNIPPET = "/opt/t3-infra/cloudflared/ingress.yml"
BEGIN = "  # t3-infra:begin"
END = "  # t3-infra:end"
CATCH_ALL = re.compile(r"^\s*- service: http_status:404\s*$")
HOSTNAME = re.compile(r"^- hostname: ([a-z0-9-]+\.amartuvshin\.com)$")
SERVICE = re.compile(r"^  service: (http://127\.0\.0\.1:[0-9]{2,5})$")


def fail(message):
    print(f"apply-ingress: {message}", file=sys.stderr)
    sys.exit(1)


def read_rules():
    lines = [line.rstrip() for line in open(SNIPPET, encoding="utf-8") if line.strip()]
    if not lines or len(lines) % 2:
        fail(f"{SNIPPET} must hold hostname/service pairs")
    rules = []
    for hostname_line, service_line in zip(lines[::2], lines[1::2]):
        hostname = HOSTNAME.match(hostname_line)
        service = SERVICE.match(service_line)
        if not hostname or not service:
            fail(f"rejected rule: {hostname_line!r} {service_line!r}")
        rules.append((hostname.group(1), service.group(1)))
    return rules


def render(current, rules):
    lines = current.splitlines()
    unmanaged = []
    inside = False
    for line in lines:
        if line == BEGIN:
            inside = True
        elif line == END:
            inside = False
        elif not inside:
            unmanaged.append(line)
    if inside:
        fail(f"{CONFIG} has an unterminated t3-infra block")
    taken = {m.group(1) for m in (re.match(r"^\s*- hostname: (\S+)\s*$", line) for line in unmanaged) if m}
    for hostname, _ in rules:
        if hostname in taken:
            fail(f"{hostname} is already routed by a rule this script does not own")
    catch_all = [i for i, line in enumerate(unmanaged) if CATCH_ALL.match(line)]
    if len(catch_all) != 1:
        fail(f"{CONFIG} must end its ingress with exactly one http_status:404 rule")
    block = [BEGIN]
    for hostname, service in rules:
        block += [f"  - hostname: {hostname}", f"    service: {service}"]
    block.append(END)
    at = catch_all[0]
    return "\n".join(unmanaged[:at] + block + unmanaged[at:]) + "\n"


def main():
    current = open(CONFIG, encoding="utf-8").read()
    updated = render(current, read_rules())
    if updated == current:
        print("apply-ingress: unchanged")
        return
    directory = os.path.dirname(CONFIG)
    with tempfile.NamedTemporaryFile("w", dir=directory, prefix=".config.", suffix=".yml", delete=False) as handle:
        handle.write(updated)
        candidate = handle.name
    try:
        shutil.copymode(CONFIG, candidate)
        check = subprocess.run(
            ["cloudflared", "tunnel", "--config", candidate, "ingress", "validate"],
            capture_output=True,
            text=True,
        )
        if check.returncode != 0:
            fail(f"cloudflared rejected the new config: {check.stderr.strip() or check.stdout.strip()}")
        shutil.copy2(CONFIG, f"{CONFIG}.bak-t3-infra")
        os.replace(candidate, CONFIG)
    finally:
        if os.path.exists(candidate):
            os.unlink(candidate)
    subprocess.run(["systemctl", "restart", "cloudflared"], check=True)
    for _ in range(30):
        if subprocess.run(["systemctl", "is-active", "--quiet", "cloudflared"]).returncode == 0:
            print("apply-ingress: updated and restarted cloudflared")
            return
        time.sleep(1)
    shutil.copy2(f"{CONFIG}.bak-t3-infra", CONFIG)
    subprocess.run(["systemctl", "restart", "cloudflared"])
    fail("cloudflared did not come back after restart; restored the previous config")


if __name__ == "__main__":
    main()
