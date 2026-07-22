#!/bin/sh
set -eu

deploy_dir=${1:-/tmp/memebox-deploy}

if ! swapon --show=NAME --noheadings | grep -q .; then
    fallocate -l 1G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -o root -g root -m 0644 "$deploy_dir/99-memebox-memory.conf" /etc/sysctl.d/99-memebox-memory.conf
sysctl --system >/dev/null

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y caddy

if ! id memebox >/dev/null 2>&1; then
    useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin memebox
fi

install -d -o root -g root -m 0755 /opt/memebox-api
install -d -o memebox -g memebox -m 0750 /var/lib/memebox-api
install -o root -g root -m 0644 "$deploy_dir/app.py" /opt/memebox-api/app.py
install -o root -g root -m 0644 "$deploy_dir/backup.py" /opt/memebox-api/backup.py
install -o root -g root -m 0644 "$deploy_dir/seed_registry.py" /opt/memebox-api/seed_registry.py
install -o root -g memebox -m 0640 "$deploy_dir/memebox-api.env.tmp" /etc/memebox-api.env
install -o root -g root -m 0644 "$deploy_dir/memebox-api.service" /etc/systemd/system/memebox-api.service
install -o root -g root -m 0644 "$deploy_dir/memebox-api-backup.service" /etc/systemd/system/memebox-api-backup.service
install -o root -g root -m 0644 "$deploy_dir/memebox-api-backup.timer" /etc/systemd/system/memebox-api-backup.timer
install -o root -g root -m 0644 "$deploy_dir/Caddyfile" /etc/caddy/Caddyfile

iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 1 -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT
netfilter-persistent save

systemctl daemon-reload
systemctl enable memebox-api.service memebox-api-backup.timer
systemctl start memebox-api.service

install -o memebox -g memebox -m 0640 "$deploy_dir/meme-entry-ids.json" /var/lib/memebox-api/meme-entry-ids.json
sudo -u memebox /usr/bin/python3 /opt/memebox-api/seed_registry.py \
    /var/lib/memebox-api/memebox.db /var/lib/memebox-api/meme-entry-ids.json

systemd-analyze verify /etc/systemd/system/memebox-api.service /etc/systemd/system/memebox-api-backup.service
caddy validate --config /etc/caddy/Caddyfile
systemctl restart memebox-api.service
systemctl enable --now caddy.service memebox-api-backup.timer
systemctl restart caddy.service

rm -rf "$deploy_dir"
