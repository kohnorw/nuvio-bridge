// Desktop VLC registers no URL scheme, so a web page has no way to start it:
// the best a browser can do on its own is download an .m3u and hope the file
// association points at VLC. The launcher closes that gap. Installed once, it
// registers `nuvio-vlc:` with the OS, and a link of the form
//
//   nuvio-vlc:https://this-server/playlist/<token>.m3u
//
// starts VLC and hands it the playlist URL to stream. Nothing is downloaded.
// It also registers `vlc:`, so a plain VLC link carrying a stream,
//
//   vlc://https://some-host/path/to/file.mkv
//
// starts VLC on that stream. Those can point anywhere, so they are held to
// http(s) and a conservative character set: nothing a shell, PowerShell or
// VLC's own option parser could read as anything but part of a URL. Links
// are normalised to that set (see streamLinkUrl) before they are made.
//
// Every installer is generated for one server. The handler it installs only
// accepts playlist URLs on that exact origin, matched in full against a
// pattern with no room for anything else, so another website can't use the
// scheme to make VLC open arbitrary links. The URL is never URL-decoded or
// passed through a shell: it goes to VLC as a single argument.
//
// The patterns avoid backslashes altogether (a literal dot is written [.])
// because the same text is embedded in PowerShell, AppleScript and sh, each
// with its own escaping rules.

export const SCHEME = 'nuvio-vlc';

const TOKEN_PATTERN = '[0-9a-f]{48}';

// Any http(s) URL made only of unreserved and sub-delimiter characters plus
// percent escapes. No quotes, brackets, backslashes, spaces or controls.
export const STREAM_PATTERN = "https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+";

// Percent-encode whatever falls outside STREAM_PATTERN, so a real stream URL
// with a bracket or quote in its filename still makes a link the handler
// accepts. Servers treat the encoded and unencoded forms the same.
export function streamLinkUrl(url) {
  const href = new URL(url).href;
  return href.replace(/[^A-Za-z0-9._~:/?#@!$&()*+,;=%-]/g,
    (ch) => (ch === "'" ? '%27' : encodeURIComponent(ch)));
}

export function vlcLink(url) {
  return `vlc://${streamLinkUrl(url)}`;
}

// A regex for the host part of the origin, safe in .NET and POSIX ERE.
function literal(text) {
  return [...text].map((ch) => {
    if (/[A-Za-z0-9:/-]/.test(ch)) return ch;
    if (ch === '.') return '[.]';
    if (ch === '[') return '[[]';
    if (ch === ']') return '[]]';
    throw new Error(`Unsupported character in PUBLIC_URL: ${ch}`);
  }).join('');
}

export function allowedPattern(origin) {
  const { protocol, host } = new URL(origin);
  return `${literal(`${protocol}//${host}`)}/playlist/${TOKEN_PATTERN}[.]m3u`;
}

export function launchLink(playlistUrl) {
  return `${SCHEME}:${playlistUrl}`;
}

export const FILES = {
  windows: { name: 'nuvio-vlc-windows.cmd', type: 'application/octet-stream' },
  macos: { name: 'nuvio-vlc-macos.sh', type: 'text/x-shellscript' },
  linux: { name: 'nuvio-vlc-linux.sh', type: 'text/x-shellscript' },
};

export function installer(os, origin, { remove = false } = {}) {
  const pattern = allowedPattern(origin);
  switch (os) {
    case 'windows': return windows(pattern, origin, remove).replace(/\r?\n/g, '\r\n');
    case 'macos': return macos(pattern, origin, remove);
    case 'linux': return linux(pattern, origin, remove);
    default: throw new Error(`No launcher for ${os}`);
  }
}

// ---------------------------------------------------------------- Windows
//
// A .cmd, because that is what double-clicks into running. It hands the rest
// of its own file to PowerShell. Everything is per-user (HKCU, %LOCALAPPDATA%)
// so no administrator prompt is needed.

function windows(pattern, origin, remove) {
  const STREAM = STREAM_PATTERN;
  return `@echo off
rem Nuvio VLC launcher for ${origin}
rem ${remove ? 'Removes' : 'Registers'} the nuvio-vlc: link for this Windows user.
set "NUVIO_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:NUVIO_SELF); iex $t.Substring($t.IndexOf('#'+'POWERSHELL'))"
echo.
pause
exit /b

#POWERSHELL
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'NuvioVLC'
$key = 'HKCU:\\Software\\Classes\\${SCHEME}'
$vlcKey = 'HKCU:\\Software\\Classes\\vlc'

${remove ? `
Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue
$existing = Get-ItemProperty -Path "$vlcKey\\shell\\open\\command" -ErrorAction SilentlyContinue
if ($existing -and $existing.'(default)' -like '*NuvioVLC*') { Remove-Item -Path $vlcKey -Recurse -Force }
Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'The Nuvio VLC launcher has been removed.'
return
` : ''}
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$handler = Join-Path $dir 'open.ps1'

@'
param([string]$Link)
if ($Link -match '[\\x00-\\x1f]') { exit 1 }
if ($Link -match '^${SCHEME}:(//)?(?<u>${pattern})\\z') { $url = $Matches.u }
elseif ($Link -match '^vlc:(//)?(?<u>${STREAM})\\z') { $url = $Matches.u }
else { exit 1 }

$candidates = @()
foreach ($reg in 'HKLM:\\SOFTWARE\\VideoLAN\\VLC', 'HKLM:\\SOFTWARE\\WOW6432Node\\VideoLAN\\VLC') {
  $item = Get-ItemProperty -Path $reg -ErrorAction SilentlyContinue
  if ($item) { $candidates += $item.'(default)'; if ($item.InstallDir) { $candidates += (Join-Path $item.InstallDir 'vlc.exe') } }
}
$candidates += (Join-Path $env:ProgramFiles 'VideoLAN\\VLC\\vlc.exe')
if (\${env:ProgramFiles(x86)}) { $candidates += (Join-Path \${env:ProgramFiles(x86)} 'VideoLAN\\VLC\\vlc.exe') }
$cmd = Get-Command vlc.exe -ErrorAction SilentlyContinue
if ($cmd) { $candidates += $cmd.Source }

$vlc = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $vlc) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('VLC is not installed. Get it from videolan.org, then try again.', 'Nuvio') | Out-Null
  exit 1
}
Start-Process -FilePath $vlc -ArgumentList ('"' + $url + '"')
'@ | Set-Content -Path $handler -Encoding UTF8

$command = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $handler + '" "%1"'
foreach ($k in @($key, $vlcKey)) {
  New-Item -Path $k -Force | Out-Null
  Set-ItemProperty -Path $k -Name '(default)' -Value 'URL:Nuvio VLC launcher'
  Set-ItemProperty -Path $k -Name 'URL Protocol' -Value ''
  New-Item -Path "$k\\shell\\open\\command" -Force | Out-Null
  Set-ItemProperty -Path "$k\\shell\\open\\command" -Name '(default)' -Value $command
}

Write-Host 'The Nuvio VLC launcher is installed.'
if (-not (Test-Path (Join-Path $env:ProgramFiles 'VideoLAN\\VLC\\vlc.exe')) -and -not (Get-ItemProperty 'HKLM:\\SOFTWARE\\VideoLAN\\VLC' -ErrorAction SilentlyContinue)) {
  Write-Host 'VLC was not found. Install the desktop version from https://www.videolan.org before playing.'
}
Write-Host 'Go back to Nuvio and choose Open in VLC.'
`;
}

// ------------------------------------------------------------------ macOS
//
// macOS only routes URL schemes to application bundles, so the script builds
// a tiny background AppleScript app in ~/Applications, declares the scheme in
// its Info.plist, re-signs it ad hoc (editing the plist breaks the signature
// osacompile gave it) and registers it with Launch Services.

function macos(pattern, origin, remove) {
  const STREAM = STREAM_PATTERN;
  return `#!/bin/sh
# Nuvio VLC launcher for ${origin}
# Run with:  sh ${FILES.macos.name}
set -eu

APP="$HOME/Applications/Nuvio VLC Launcher.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

${remove ? `
if [ -d "$APP" ]; then
  "$LSREGISTER" -u "$APP" 2>/dev/null || true
  rm -rf "$APP"
fi
echo "The Nuvio VLC launcher has been removed."
exit 0
` : ''}
if ! [ -d /Applications/VLC.app ] && ! [ -d "$HOME/Applications/VLC.app" ] \
  && ! mdfind "kMDItemCFBundleIdentifier == 'org.videolan.vlc'" 2>/dev/null | grep -q .; then
  echo "VLC was not found. Install it from https://www.videolan.org, then run this again."
  exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/launcher.applescript" <<'APPLESCRIPT'
on open location theLink
	set target to do shell script "printf '%s' " & quoted form of theLink & " | /usr/bin/tr -d '[:cntrl:]' | /usr/bin/sed -E 's#^${SCHEME}:(//)?#N #;s#^vlc:(//)?#V #' | /usr/bin/grep -Ex 'N ${pattern}|V ${STREAM}' | /usr/bin/cut -c3- || true"
	if target is "" then return
	do shell script "/usr/bin/open -a VLC " & quoted form of target
end open location

on run
	display dialog "The Nuvio VLC launcher is installed. Use Open in VLC in Nuvio." buttons {"OK"} default button "OK"
end run
APPLESCRIPT

mkdir -p "$HOME/Applications"
rm -rf "$APP"
osacompile -o "$APP" "$WORK/launcher.applescript"

PLIST="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
$PB -c "Delete :CFBundleIdentifier" "$PLIST" 2>/dev/null || true
$PB -c "Add :CFBundleIdentifier string app.nuvio.vlc-launcher" "$PLIST"
$PB -c "Delete :CFBundleURLTypes" "$PLIST" 2>/dev/null || true
$PB -c "Add :CFBundleURLTypes array" "$PLIST"
$PB -c "Add :CFBundleURLTypes:0 dict" "$PLIST"
$PB -c "Add :CFBundleURLTypes:0:CFBundleURLName string Nuvio VLC launcher" "$PLIST"
$PB -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST"
$PB -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${SCHEME}" "$PLIST"
$PB -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:1 string vlc" "$PLIST"
$PB -c "Delete :LSUIElement" "$PLIST" 2>/dev/null || true
$PB -c "Add :LSUIElement bool true" "$PLIST"

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
"$LSREGISTER" -f "$APP"
# Make this app the handler for vlc: links even if another app declares them.
/usr/bin/osascript -l JavaScript -e 'ObjC.import("CoreServices"); for (const s of ["${SCHEME}", "vlc"]) $.LSSetDefaultHandlerForURLScheme($(s), $("app.nuvio.vlc-launcher"));' >/dev/null 2>&1 || true

echo "The Nuvio VLC launcher is installed. Go back to Nuvio and choose Open in VLC."
`;
}

// ------------------------------------------------------------------ Linux
//
// A handler script in ~/.local/bin and a hidden .desktop entry that claims
// x-scheme-handler/nuvio-vlc, which is what Chrome, Firefox and the desktop
// environments consult. It finds VLC as a package, a Flatpak or a Snap.

function linux(pattern, origin, remove) {
  const STREAM = STREAM_PATTERN;
  return `#!/bin/sh
# Nuvio VLC launcher for ${origin}
# Run with:  sh ${FILES.linux.name}
set -eu

BIN="$HOME/.local/bin/nuvio-vlc-open"
APPS="\${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP="$APPS/nuvio-vlc.desktop"

${remove ? `
rm -f "$BIN" "$DESKTOP"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true
echo "The Nuvio VLC launcher has been removed."
exit 0
` : ''}
mkdir -p "$HOME/.local/bin" "$APPS"

cat > "$BIN" <<'HANDLER'
#!/bin/sh
# Control characters go first, so the link is a single line matched in full:
# a newline can't smuggle a second URL past the check.
url=$(printf '%s' "\${1:-}" | tr -d '[:cntrl:]' \\
  | sed -E 's#^${SCHEME}:(//)?#N #;s#^vlc:(//)?#V #' \\
  | grep -Ex 'N ${pattern}|V ${STREAM}' | cut -c3-) || exit 1
[ -n "$url" ] || exit 1

if command -v vlc >/dev/null 2>&1; then
  exec vlc "$url"
elif command -v flatpak >/dev/null 2>&1 && flatpak info org.videolan.VLC >/dev/null 2>&1; then
  exec flatpak run org.videolan.VLC "$url"
elif [ -x /snap/bin/vlc ]; then
  exec /snap/bin/vlc "$url"
fi
command -v notify-send >/dev/null 2>&1 && notify-send "Nuvio" "VLC is not installed."
exit 1
HANDLER
chmod +x "$BIN"

cat > "$DESKTOP" <<DESKTOPENTRY
[Desktop Entry]
Type=Application
Name=Nuvio VLC launcher
Exec="$BIN" %u
NoDisplay=true
Terminal=false
MimeType=x-scheme-handler/${SCHEME};x-scheme-handler/vlc;
DESKTOPENTRY

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true
if command -v xdg-mime >/dev/null 2>&1; then
  xdg-mime default nuvio-vlc.desktop x-scheme-handler/${SCHEME}
  xdg-mime default nuvio-vlc.desktop x-scheme-handler/vlc
else
  echo "xdg-mime is missing (install xdg-utils); your browser may not find the launcher."
fi

if ! command -v vlc >/dev/null 2>&1 && ! [ -x /snap/bin/vlc ] && ! (command -v flatpak >/dev/null 2>&1 && flatpak info org.videolan.VLC >/dev/null 2>&1); then
  echo "VLC was not found. Install it (for example: sudo apt install vlc) before playing."
fi
echo "The Nuvio VLC launcher is installed. Go back to Nuvio and choose Open in VLC."
`;
}
