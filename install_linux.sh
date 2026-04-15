#!/bin/sh
set -eu

# Racemo installer for Linux
# Usage: curl -fsSL https://racemo.dev/install_linux | sh

REPO="racemo-dev/racemo"
INSTALL_DIR="$HOME/.local/bin"
APP_NAME="Racemo.AppImage"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons"

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
    BOLD='\033[1m'    DIM='\033[2m'   RESET='\033[0m'
    GREEN='\033[32m'  CYAN='\033[36m' RED='\033[31m' YELLOW='\033[33m'
else
    BOLD='' DIM='' RESET='' GREEN='' CYAN='' RED='' YELLOW=''
fi

info()  { printf "${CYAN}  ::${RESET} %s\n" "$1"; }
ok()    { printf "${GREEN}  ok${RESET} %s\n" "$1"; }
warn()  { printf "${YELLOW}warn${RESET} %s\n" "$1"; }
err()   { printf "${RED}  !!${RESET} %s\n" "$1"; exit 1; }

main() {
    printf "\n"
    printf "${BOLD}  ____                                  ${RESET}\n"
    printf "${BOLD} |  _ \\ __ _  ___ ___ _ __ ___   ___   ${RESET}\n"
    printf "${BOLD} | |_) / _\` |/ __/ _ \\ '_ \` _ \\ / _ \\  ${RESET}\n"
    printf "${BOLD} |  _ < (_| | (_|  __/ | | | | | (_) | ${RESET}\n"
    printf "${BOLD} |_| \\_\\__,_|\\___\\___|_| |_| |_|\\___/  ${RESET}\n"
    printf "${DIM}  Terminal Multiplexer for Linux${RESET}\n"
    printf "\n"

    # ── Detect architecture ──
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64)  ARCH_LABEL="x64" ;;
        aarch64) ARCH_LABEL="aarch64" ;;
        *)       err "Unsupported architecture: $ARCH" ;;
    esac

    # ── Check dependencies ──
    command -v curl >/dev/null 2>&1 || err "curl is required but not installed"

    # ── Fetch latest version ──
    info "Checking latest version..."
    VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | grep '"tag_name"' | head -1 | cut -d'"' -f4 | sed 's/^v//')

    [ -z "$VERSION" ] && err "Failed to fetch latest version"

    RELEASE_FILE="Racemo_${VERSION}_Linux_${ARCH_LABEL}.AppImage"
    URL="https://github.com/$REPO/releases/download/v${VERSION}/${RELEASE_FILE}"
    DEST="$INSTALL_DIR/$APP_NAME"

    printf "\n"
    printf "  ${DIM}version${RESET}  ${BOLD}v%s${RESET}\n" "$VERSION"
    printf "  ${DIM}arch${RESET}     %s (%s)\n" "$ARCH" "$ARCH_LABEL"
    printf "  ${DIM}path${RESET}     %s\n" "$DEST"
    printf "\n"

    # ── Clean up old versions ──
    mkdir -p "$INSTALL_DIR"
    for old in "$INSTALL_DIR"/Racemo_*_Linux_*.AppImage "$INSTALL_DIR"/Racemo*.bak; do
        [ -f "$old" ] && rm -f "$old" && warn "Removed $(basename "$old")"
    done

    # ── Download ──
    info "Downloading ${RELEASE_FILE}..."
    printf "\n"
    curl -fSL --progress-bar "$URL" -o "$DEST"
    chmod +x "$DEST"
    ok "Binary installed"

    # ── Desktop entry + icon ──
    mkdir -p "$DESKTOP_DIR" "$ICON_DIR"

    if curl -fsSL "https://raw.githubusercontent.com/$REPO/main/scripts/linux-fa.svg" \
        -o "$ICON_DIR/racemo.svg" 2>/dev/null; then
        ok "Icon installed"
    fi

    cat > "$DESKTOP_DIR/racemo.desktop" << EOF
[Desktop Entry]
Name=Racemo
Comment=Terminal Multiplexer
Exec=$DEST
Icon=$ICON_DIR/racemo.svg
Type=Application
Categories=Development;TerminalEmulator;
StartupWMClass=Racemo
EOF
    ok "Desktop entry created"

    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    fi

    # ── PATH check ──
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) ;;
        *)
            warn "$INSTALL_DIR is not in your PATH"
            printf "       Add this to your shell config:\n"
            printf "       ${DIM}export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}\n"
            printf "\n"
            ;;
    esac

    # ── Done ──
    printf "\n"
    printf "  ${GREEN}${BOLD}Racemo v%s installed successfully!${RESET}\n" "$VERSION"
    printf "\n"
    printf "  ${DIM}Run${RESET}          ${BOLD}Racemo.AppImage${RESET}\n"
    printf "  ${DIM}Launcher${RESET}     Search ${BOLD}Racemo${RESET} in your app menu\n"
    printf "  ${DIM}Uninstall${RESET}    rm %s \\\\\n" "$DEST"
    printf "               %s/racemo.desktop \\\\\n" "$DESKTOP_DIR"
    printf "               %s/racemo.svg\n" "$ICON_DIR"
    printf "\n"
}

main
