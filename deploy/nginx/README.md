# Nginx Deployment Config

Production nginx config for BlackDelta dashboard. Mirrors what's live
at `/etc/nginx/sites-available/blackdelta`.

## Architecture

```
Browser → Cloudflare proxy → nginx (76.13.208.204) → BlackDelta bot (port 3030)
```

## Server Blocks

| Hostname | Port | Behavior |
|---|---|---|
| `blackdelta.cc` | 80 + 443 | proxy_pass to bot, requires CF-Connecting-IP header |
| `www.blackdelta.cc` | 80 + 443 | 301 redirect to canonical blackdelta.cc |
| `selsiscan.online` | 80 + 443 | 410 Gone (retired domain) |
| `www.selsiscan.online` | 80 + 443 | 410 Gone |

## Security Hardening

**Level 1 — CF-only check (active):**
- Every server block checks `$http_cf_connecting_ip`
- Missing header → `return 444` (drop connection, no response)
- Blocks direct VPS IP scrapers, DDoS bots, casual attackers
- Spoofable by determined attackers (Level 2/3 closes that gap)

**Level 2 — Cloudflare Authenticated Origin Pulls (not deployed):**
- Cloudflare presents TLS client cert to origin
- nginx verifies cert before serving
- Closes the spoof-header bypass

**Level 3 — UFW firewall IP whitelist (not deployed):**
- Kernel-level drop of non-Cloudflare IPs
- Strongest defense, requires periodic CF IP list refresh

## SSL Certificate

Self-signed cert at `/etc/nginx/ssl/blackdelta-cert.pem` with 4 SANs:
- blackdelta.cc
- www.blackdelta.cc
- selsiscan.online
- www.selsiscan.online

Cloudflare SSL mode: **Full** (accepts self-signed origin cert).

To upgrade to "Full (strict)", replace with Let's Encrypt cert:
```bash
sudo apt install -y certbot python3-certbot-nginx
# Temporarily disable Cloudflare proxy (orange → grey)
sudo certbot --nginx -d blackdelta.cc -d www.blackdelta.cc
# Re-enable Cloudflare proxy
```

## Deployment

```bash
sudo cp deploy/nginx/blackdelta.conf /etc/nginx/sites-available/blackdelta
sudo ln -sf /etc/nginx/sites-available/blackdelta /etc/nginx/sites-enabled/blackdelta
sudo nginx -t && sudo systemctl reload nginx
```
