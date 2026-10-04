# Deploy on GCP Always Free (e2-micro)

One VM runs everything via `docker-compose.prod.yml`: Caddy (TLS) → signaling + static
frontends, mediasoup SFU + coturn on host network, Postgres + Redis internal.

**Free-tier limits to know:** e2-micro = 1 shared vCPU / 1GB RAM (we add swap), and
**~1GB/month free egress** — fine for demos, video relay will exceed it under real use.

## 1. Create the VM (GCP Console)

- Compute Engine → Create instance
- **Machine**: `e2-micro` · **Region**: `us-west1`, `us-central1`, or `us-east1` (Always Free only in these)
- **Boot disk**: Ubuntu 24.04 LTS, **30GB standard persistent disk** (free ceiling)
- **Firewall**: allow HTTP + HTTPS checkboxes
- Note the **external IP** after boot (make it static: VPC → IP addresses → Reserve)

## 2. Firewall rules (VPC → Firewall → Create)

| Name | Protocol/ports | Purpose |
|---|---|---|
| `allow-turn` | `udp:3478, tcp:3478` | TURN |
| `allow-turn-relay` | `udp:49160-49200` | TURN relay range |
| `allow-sfu-rtc` | `udp:40000-40100` | mediasoup media |

Source ranges `0.0.0.0/0`, apply to the VM (or all instances).

## 3. Free domain

[duckdns.org](https://www.duckdns.org) → create `yourname.duckdns.org` → set it to the VM's external IP.
Required: Let's Encrypt won't issue for a bare IP, and browsers block mic/camera without HTTPS.

## 4. On the VM (SSH from console)

```bash
# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# Swap — 1GB RAM is not enough without it
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# App
git clone https://github.com/Devs-private-limited/rtc-platform.git
cd rtc-platform
cp .env.production.example .env.production
nano .env.production   # fill: DOMAIN, TLS_EMAIL, PUBLIC_IP=<external IP>,
                       # JWT_SECRET/ADMIN_API_KEY/passwords via: openssl rand -hex 32

docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

First build takes a while on e2-micro. Then:

```bash
curl https://<your-domain>/ready     # {"ok":true,...}
```

## 5. Live links

| | URL |
|---|---|
| Admin dashboard | `https://<your-domain>/admin/` (sign in with your `ADMIN_API_KEY`) |
| Demo | `https://<your-domain>/demo/` |
| API | `https://<your-domain>/v1/...` |

## Troubleshooting

- **Cert not issued** — DNS not propagated yet, or port 80 blocked. `docker compose -f docker-compose.prod.yml logs caddy`
- **Calls connect but no audio** — `udp:40000-40100` firewall rule missing, or `PUBLIC_IP` wrong (must be the external IP, not `10.x`)
- **Server won't boot** — production guards: dev-default `JWT_SECRET`/`ADMIN_API_KEY` or `ANNOUNCED_IP=127.0.0.1` are refused by design
- **OOM** — check swap is active (`free -h`); consider `docker compose stop coturn` if unused (P2P + STUN often suffices)

## Updating

```bash
git pull && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```
