#!/usr/bin/env bash
set -euo pipefail

service_name="llm-dashboard.service"
dashboard_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node_bin="$(command -v node)"
port="${PORT:-8787}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_file="$unit_dir/$service_name"

mkdir -p "$unit_dir"
cat >"$unit_file" <<EOF
[Unit]
Description=LLM Fuel Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$dashboard_dir
Environment=PORT=$port
ExecStart=$node_bin $dashboard_dir/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$service_name"

if command -v loginctl >/dev/null 2>&1; then
  if ! loginctl show-user "$USER" -p Linger --value 2>/dev/null | grep -qx yes; then
    echo "Enabling user lingering so the dashboard starts at boot..."
    sudo loginctl enable-linger "$USER"
  fi
fi

echo "Installed and started $service_name"
echo "Dashboard: http://127.0.0.1:$port"
echo "Status: systemctl --user status $service_name"
