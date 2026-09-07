#!/usr/bin/env bash
set -euo pipefail

service_name="llm-dashboard.service"
unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$service_name"

systemctl --user disable --now "$service_name" 2>/dev/null || true
rm -f "$unit_file"
systemctl --user daemon-reload

echo "Removed $service_name. User lingering was left unchanged because other services may use it."
