"""Cross-platform clipboard image grabbing.

Supports macOS (osascript), Windows (PowerShell), Linux (xclip / wl-paste).
"""

from __future__ import annotations

import platform
import subprocess
from pathlib import Path

_SYSTEM = platform.system()


def has_image() -> bool:
    """Check if the system clipboard contains an image."""
    try:
        if _SYSTEM == "Darwin":
            r = subprocess.run(
                ["osascript", "-e",
                 'try\n'
                 '    the clipboard as «class PNGf»\n'
                 '    return "yes"\n'
                 'on error\n'
                 '    return "no"\n'
                 'end try'],
                capture_output=True, text=True, timeout=5,
            )
            return r.stdout.strip() == "yes"

        elif _SYSTEM == "Windows":
            r = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "Add-Type -AssemblyName System.Windows.Forms;"
                 "if ([System.Windows.Forms.Clipboard]::ContainsImage())"
                 '{ Write-Output "yes" } else { Write-Output "no" }'],
                capture_output=True, text=True, timeout=5,
            )
            return r.stdout.strip() == "yes"

        else:  # Linux
            # Try wl-paste (Wayland) first, then xclip (X11)
            for cmd in [
                ["wl-paste", "--list-types"],
                ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
            ]:
                try:
                    r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
                    if "image/png" in r.stdout:
                        return True
                except FileNotFoundError:
                    continue
            return False

    except Exception:
        return False


def save_image(dest: Path) -> bool:
    """Save the clipboard image to `dest`.  Returns True on success."""
    try:
        if _SYSTEM == "Darwin":
            script = (
                'try\n'
                '    set imgData to the clipboard as «class PNGf»\n'
                f'    set fp to POSIX path of "{dest}"\n'
                '    set fh to open for access fp with write permission\n'
                '    write imgData to fh\n'
                '    close access fh\n'
                '    return "ok"\n'
                'on error errMsg\n'
                '    return "error:" & errMsg\n'
                'end try'
            )
            r = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True, timeout=10,
            )
            return r.stdout.strip() == "ok"

        elif _SYSTEM == "Windows":
            ps_script = (
                "Add-Type -AssemblyName System.Windows.Forms;"
                "$img = [System.Windows.Forms.Clipboard]::GetImage();"
                "if ($img) {"
                f'  $img.Save("{dest}");'
                '  Write-Output "ok"'
                "} else {"
                '  Write-Output "no_image"'
                "}"
            )
            r = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_script],
                capture_output=True, text=True, timeout=10,
            )
            return r.stdout.strip() == "ok"

        else:  # Linux
            # Try Wayland first, then X11
            for cmd in [
                ["wl-paste", "--type", "image/png"],
                ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
            ]:
                try:
                    r = subprocess.run(cmd, capture_output=True, timeout=10)
                    if r.returncode == 0 and len(r.stdout) > 0:
                        dest.write_bytes(r.stdout)
                        return True
                except FileNotFoundError:
                    continue
            return False

    except Exception:
        return False
