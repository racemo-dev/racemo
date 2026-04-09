#!/bin/sh
set -eu

# Racemo installer for Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/racemo-dev/racemo/main/install.sh | sh

REPO="racemo-dev/racemo"
INSTALL_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons"

main() {
    echo "Installing Racemo..."
    echo

    # Detect architecture
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64)  ARCH_LABEL="x64" ;;
        aarch64) ARCH_LABEL="aarch64" ;;
        *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    # Get latest version
    VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | grep '"tag_name"' | head -1 | cut -d'"' -f4 | sed 's/^v//')

    if [ -z "$VERSION" ]; then
        echo "Failed to fetch latest version."
        exit 1
    fi

    FILENAME="Racemo_${VERSION}_Linux_${ARCH_LABEL}.AppImage"
    URL="https://github.com/$REPO/releases/download/v${VERSION}/${FILENAME}"
    DEST="$INSTALL_DIR/Racemo.AppImage"

    echo "  Version:  v$VERSION"
    echo "  Arch:     $ARCH ($ARCH_LABEL)"
    echo "  Install:  $DEST"
    echo

    # Download
    mkdir -p "$INSTALL_DIR"
    echo "Downloading $FILENAME..."
    curl -fSL --progress-bar "$URL" -o "$DEST"
    chmod +x "$DEST"

    # Desktop icon
    mkdir -p "$DESKTOP_DIR" "$ICON_DIR"

    # Download icon
    curl -fsSL "https://raw.githubusercontent.com/$REPO/main/scripts/linux-fa.svg" \
        -o "$ICON_DIR/racemo.svg" 2>/dev/null || true

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

    # Update desktop database if available
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    fi

    echo
    echo "Racemo v$VERSION installed successfully!"
    echo
    echo "  Run:       Racemo.AppImage"
    echo "  Or find 'Racemo' in your application launcher."
    echo
    echo "  To uninstall: rm $DEST $DESKTOP_DIR/racemo.desktop $ICON_DIR/racemo.svg"
}

main
