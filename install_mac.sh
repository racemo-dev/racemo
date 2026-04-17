#!/bin/sh
set -eu

# Racemo installer for macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/racemo-dev/racemo/main/install_mac.sh | sh

REPO="racemo-dev/racemo"
APP_NAME="Racemo.app"
INSTALL_DIR="/Applications"

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
    printf "${DIM}  Terminal Multiplexer for macOS${RESET}\n"
    printf "\n"

    # ── Check OS ──
    [ "$(uname -s)" = "Darwin" ] || err "This installer is for macOS only"

    # ── Check dependencies ──
    command -v curl >/dev/null 2>&1 || err "curl is required but not installed"
    command -v hdiutil >/dev/null 2>&1 || err "hdiutil is required but not found"

    # ── Fetch latest version ──
    info "Checking latest version..."
    VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | grep '"tag_name"' | head -1 | cut -d'"' -f4 | sed 's/^v//')

    [ -z "$VERSION" ] && err "Failed to fetch latest version"

    RELEASE_FILE="Racemo_${VERSION}_Mac.dmg"
    URL="https://github.com/$REPO/releases/download/v${VERSION}/${RELEASE_FILE}"
    TMP_DMG="/tmp/${RELEASE_FILE}"
    MOUNT_POINT="/tmp/racemo-dmg-mount"

    printf "\n"
    printf "  ${DIM}version${RESET}  ${BOLD}v%s${RESET}\n" "$VERSION"
    printf "  ${DIM}arch${RESET}     %s\n" "$(uname -m)"
    printf "  ${DIM}path${RESET}     %s/%s\n" "$INSTALL_DIR" "$APP_NAME"
    printf "\n"

    # ── Download ──
    info "Downloading ${RELEASE_FILE}..."
    printf "\n"
    curl -fSL --progress-bar "$URL" -o "$TMP_DMG"
    ok "Downloaded"

    # ── Mount DMG ──
    info "Mounting disk image..."
    mkdir -p "$MOUNT_POINT"
    hdiutil attach "$TMP_DMG" -mountpoint "$MOUNT_POINT" -nobrowse -quiet
    ok "Mounted"

    # ── Install ──
    if [ -d "$INSTALL_DIR/$APP_NAME" ]; then
        warn "Removing existing $APP_NAME..."
        rm -rf "$INSTALL_DIR/$APP_NAME"
    fi

    info "Installing to $INSTALL_DIR..."
    cp -R "$MOUNT_POINT/$APP_NAME" "$INSTALL_DIR/"
    ok "Installed"

    # ── Cleanup ──
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
    rm -f "$TMP_DMG"
    rmdir "$MOUNT_POINT" 2>/dev/null || true
    ok "Cleaned up"

    # ── Remove quarantine (downloaded from internet) ──
    xattr -rd com.apple.quarantine "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true

    # ── Done ──
    printf "\n"
    printf "  ${GREEN}${BOLD}Racemo v%s installed successfully!${RESET}\n" "$VERSION"
    printf "\n"
    printf "  ${DIM}Run${RESET}          ${BOLD}open -a Racemo${RESET}\n"
    printf "  ${DIM}Spotlight${RESET}    Search ${BOLD}Racemo${RESET}\n"
    printf "  ${DIM}Uninstall${RESET}    rm -rf /Applications/Racemo.app\n"
    printf "\n"
}

main
