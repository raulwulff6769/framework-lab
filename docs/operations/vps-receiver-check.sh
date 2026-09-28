#!/usr/bin/env bash
# VPS receiver-readiness check for the ITles/«Отсчёт» migration.
# READ-ONLY: installs nothing, changes nothing. Run it ON the target VPS
# (you are already SSH'd in), then paste the whole output back.
#
#   bash vps-receiver-check.sh
# or, since the VPS reaches GitHub:
#   curl -fsSL https://raw.githubusercontent.com/raulwulff6769/framework-lab/otschet-current/docs/operations/vps-receiver-check.sh | bash
set -u

line() { printf '\n=== %s ===\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1 && printf '  %-12s %s\n' "$1" "$($1 --version 2>&1 | head -1)" || printf '  %-12s MISSING\n' "$1"; }
# TCP probe without extra tools (pure bash /dev/tcp), 5s timeout
tcp() { timeout 5 bash -c "cat < /dev/null > /dev/tcp/$1/$2" 2>/dev/null && echo "  $1:$2  OPEN" || echo "  $1:$2  blocked/timeout"; }

line "IDENTITY / OS"
echo "  host: $(hostname)   user: $(whoami)"
. /etc/os-release 2>/dev/null && echo "  os:   ${PRETTY_NAME:-unknown}"
echo "  kernel: $(uname -r)   arch: $(uname -m)"
echo "  uptime: $(uptime -p 2>/dev/null || true)"

line "HARDWARE"
echo "  cpu cores: $(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
echo "  cpu model: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ //')"
free -h 2>/dev/null | awk 'NR==1||/Mem|Swap/{print "  "$0}'
echo "  disk (/, and /var):"; df -h / /var 2>/dev/null | awk 'NR==1||/\//{print "    "$0}'
echo "  virtualization: $(systemd-detect-virt 2>/dev/null || echo n/a)"

line "PRIVILEGES"
if sudo -n true 2>/dev/null; then echo "  sudo: passwordless OK"; \
elif command -v sudo >/dev/null 2>&1; then echo "  sudo: present (needs password)"; \
else echo "  sudo: MISSING"; fi
echo "  init system: $(ps -p 1 -o comm= 2>/dev/null)"

line "RUNTIMES / SERVERS ALREADY INSTALLED"
for c in node npm pnpm bun deno git docker "docker compose" podman nginx caddy psql postgres pg_ctl certbot ufw firewall-cmd; do have "$c"; done
echo "  postgres server pkg: $(ls -d /usr/lib/postgresql/* 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ' || echo none)"

line "LISTENING PORTS (who owns 22/80/443 etc.)"
(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | awk 'NR==1||/:(22|80|443|5432|3000|8080)\>/{print "  "$0}' | head -30

line "LOCAL FIREWALL STATE (should NOT be the blocker)"
if command -v ufw >/dev/null 2>&1; then echo "  ufw: $(sudo -n ufw status 2>/dev/null | head -1 || echo 'need sudo')"; fi
echo "  iptables INPUT policy: $(sudo -n iptables -S 2>/dev/null | grep -m1 'P INPUT' || echo 'need sudo / none')"

line "PUBLIC IDENTITY (geo / provider — for firewall + latency planning)"
MYIP=$(curl -s --max-time 8 https://api.ipify.org || echo '?'); echo "  public ip: $MYIP"
curl -s --max-time 8 "https://ipinfo.io/${MYIP}/json" 2>/dev/null | grep -E '"(city|region|country|org|timezone)"' | sed 's/^/  /'

line "OUTBOUND REACHABILITY (VPS -> world)"
tcp github.com 443
tcp github.com 22
tcp registry.npmjs.org 443
tcp api.cloudflare.com 443
tcp 1.1.1.1 443
# Neon Postgres (mirroring target). Pass your Neon host as \$1 to test 5432, e.g.
#   bash vps-receiver-check.sh ep-xxxx.<region>.aws.neon.tech
if [ "${1:-}" != "" ]; then tcp "$1" 5432; else echo "  (neon 5432: pass your Neon host as arg to test)"; fi

line "DNS"
echo "  resolv: $(grep -m1 nameserver /etc/resolv.conf 2>/dev/null)"
getent hosts github.com >/dev/null 2>&1 && echo "  dns resolve github.com: OK" || echo "  dns resolve github.com: FAIL"

line "VERDICT (read the lines above)"
echo "  - Receiver-capable if: >=2 cores, >=2GB RAM, >=10GB free disk, sudo available,"
echo "    outbound 443 to github/npm OPEN, and you can (or will) install Node 20+ / Caddy / Postgres."
echo "  - Inbound 80/443/22 openness is set in the Tencent Security Group, NOT on this box"
echo "    (local firewall is shown above; if it's ACCEPT/inactive, the console SG is the gate)."
printf '\n=== END — paste everything above ===\n'
