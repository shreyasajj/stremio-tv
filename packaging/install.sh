#!/usr/bin/env bash
# Install Stremio TV on a Plasma Bigscreen box.
# Run from the repo root: bash packaging/install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
APPS_DIR="${HOME}/.local/share/applications"

command -v node >/dev/null || { echo "node is required (install nodejs + npm first)"; exit 1; }
command -v npm >/dev/null || { echo "npm is required"; exit 1; }

echo "==> Installing dependencies (this downloads Electron)"
cd "$REPO_DIR"
npm install --no-audit --no-fund

echo "==> Creating launcher script at ${BIN_DIR}/stremio-tv"
mkdir -p "$BIN_DIR"
cat > "${BIN_DIR}/stremio-tv" <<EOF
#!/usr/bin/env bash
cd "${REPO_DIR}"
exec npx electron . "\$@"
EOF
chmod +x "${BIN_DIR}/stremio-tv"

echo "==> Installing desktop entry"
mkdir -p "$APPS_DIR"
sed "s|^Exec=.*|Exec=${BIN_DIR}/stremio-tv|" "${REPO_DIR}/packaging/stremio-tv.desktop" > "${APPS_DIR}/stremio-tv.desktop"

command -v update-desktop-database >/dev/null && update-desktop-database "$APPS_DIR" || true

echo
echo "Done. 'Stremio TV' should now appear in the Plasma Bigscreen launcher."
echo "Start it manually with: ${BIN_DIR}/stremio-tv"
