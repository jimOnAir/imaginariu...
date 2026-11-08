#!/usr/bin/env bash
# af_download.sh - the AstraForge download core for the Linux scripts: installer/install.sh,
# installer/pixal3d/install-pixal3d.sh and scripts/vfx/install-vfx.sh all source this file.
# It re-derives, for Linux and with no code copied (ADR-0003), the network survival of 0.4.12-0.4.14
# from installer/Install.ps1: Download's reason/retry loop, DownloadMirrors, DownloadChecked/FileOk
# and the uv retry Uvx. The Windows certificate-revocation workaround (curl code 35 with
# --ssl-no-revoke + ASTRA_CURL_NO_REVOKE) has no Linux twin: curl here is built against OpenSSL,
# which does not ask CAs about revoked certificates at all, so there is nothing to turn off -
# code 35 on this platform is an ordinary flaky-TLS failure and joins the resume-and-retry set.
#
# WriteInstallStatus <progress> <text> [code] appends one JSON line to $ASTRA_INSTALL_STATUS
# when it is set (0.6.10 wave ticket 24): the Components window re-attaches to a run that outlived
# its studio by reading this file - the installer owns the truth, the studio is just a viewer.
# The other two installers that source this file never set the variable: they pay nothing.
WriteInstallStatus() {
  [ -n "${ASTRA_INSTALL_STATUS:-}" ] || return 0
  local esc; esc="$(printf '%s' "${2:-}" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r')"
  printf '{"at":"%s","pid":%s,"progress":%s,"text":"%s"%s%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "${1:-0}" "$esc" "${3:+,\"code\":$3}" "${4:+,\"failed\":\"$4\"}" >> "$ASTRA_INSTALL_STATUS" 2>/dev/null || true
}

# The sourcing script must define say(). Optional:
#   DL_USER_AGENT            sent as -A on every request (itch.io and friends want one)
#   ASTRA_UNATTENDED=1       curl goes quiet, the loop prints '##PROGRESS <pct>|<text>' lines
#                            instead of the progress bar (what install.sh does with -Yes/-Only;
#                            the studio Components window reads these lines)
# Test hook: ASTRA_INSTALL_CURL=<path> replaces the curl binary (the same name Windows uses).

# pip/uv tolerate slow links the same way Install.ps1 pins it (0.4.13)
: "${PIP_DEFAULT_TIMEOUT:=120}"; export PIP_DEFAULT_TIMEOUT
: "${PIP_RETRIES:=10}"; export PIP_RETRIES

CurlBin() { printf '%s' "${ASTRA_INSTALL_CURL:-curl}"; }

# what a curl exit code means in plain words (the CurlReason table of Install.ps1)
CurlReason() { case "$1" in
  6)  printf 'the site address was not found: no internet or DNS is not answering' ;;
  7)  printf 'cannot connect to the site: the site is down or blocked on this network' ;;
  18) printf 'the transfer broke off halfway' ;;
  22) printf 'the site answered with an error: the file is not there or access is closed' ;;
  28) printf 'no data for too long: a very slow or unstable connection' ;;
  33) printf 'the site cannot continue a download from the break point' ;;
  35) printf 'the secure connection was not established: the network, proxy or antivirus interferes with the TLS check' ;;
  52) printf 'the server closed the connection without answering' ;;
  56) printf 'the connection dropped while receiving data' ;;
  60) printf 'the site certificate failed verification: a proxy or antivirus replaces certificates' ;;
  92) printf 'the HTTP/2 stream broke off' ;;
  *)  printf 'curl error' ;;
esac; }

DlHuman() { awk -v b="$1" 'BEGIN{if (b>=1e9) printf "%.1f GB", b/1e9; else printf "%.0f MB", b/1e6}'; }

# Download <url> <dst> [size] - the retry loop of Install.ps1 Download:
# dead-slow connections are cut after 2 minutes of almost no data (--speed-limit/--speed-time),
# flaky codes resume from the same .part (up to 4 tries), code 33 restarts the file from scratch,
# and every failure ends in a plain-language reason plus the exact curl text, both in the log.
Download() {
  local url="$1" dst="$2" size="${3:-0}"
  mkdir -p "$(dirname "$dst")"
  if [ -f "$dst" ]; then say "    already downloaded: $(basename "$dst")"; return 0; fi
  say "    downloading $url"
  local part="$dst.part" err="$dst.part.err" resume=() ua=() bar=(--progress-bar) try=1 code=0 msg got pid
  [ -n "${DL_USER_AGENT:-}" ] && ua=(-A "$DL_USER_AGENT")
  [ "${ASTRA_UNATTENDED:-}" = 1 ] && bar=(-sS)
  while :; do
    resume=()
    [ -f "$part" ] && resume=(-C -)   # resume only with an existing partial: some hosts refuse byte ranges
    "$(CurlBin)" -L --fail "${bar[@]}" "${ua[@]}" --retry 5 --retry-delay 3 --connect-timeout 30 \
      --speed-limit 1024 --speed-time 120 "${resume[@]}" --stderr "$err" -o "$part" "$url" &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      if [ "${ASTRA_UNATTENDED:-}" = 1 ]; then
        got="$(stat -c%s "$part" 2>/dev/null || echo 0)"   # the file length: curl is quiet in this mode
        local pct text
        pct="$(awk -v g="$got" -v s="$size" 'BEGIN{printf "%d", (s>0)?(g/s*99):0}')"
        text="$(printf 'downloaded %s%s' "$(DlHuman "$got")" "$( [ "$size" != 0 ] && printf ' of %s' "$(DlHuman "$size")")")"
        printf '##PROGRESS %d|%s\n' "$pct" "$text"
        WriteInstallStatus "$pct" "$text"   # ticket 24: the same truth for a studio that restarts
      fi
      sleep 2
    done
    wait "$pid"; code=$?
    if [ "$code" = 0 ]; then rm -f "$err"; break; fi
    msg="$(tr -s '[:space:]' ' ' < "$err" 2>/dev/null | sed 's/^ //; s/ $//')"
    [ -n "$msg" ] && say "    curl: $msg"
    # 33 - the site will not continue from the break point (actionforge.app does this after a 28):
    # the partial file goes away and the download starts clean
    if [ "$code" = 33 ] && [ "$try" -lt 4 ]; then
      rm -f "$part"
      say "    the site cannot continue a download from the break point (code 33) - downloading the file from the start, try $((try+1)) of 4"
      try=$((try+1)); continue
    fi
    # 6, 7 (DNS/connect), 18 (broke off), 28 (no data), 35 (TLS flake), 52, 56, 92 - keep the .part and resume
    case " 6 7 18 28 35 52 56 92 " in
      *" $code "*)
        if [ "$try" -lt 4 ]; then
          say "    connection dropped (code $code - $(CurlReason "$code")) - continuing from the same place, try $((try+1)) of 4"
          try=$((try+1)); continue
        fi ;;
    esac
    say "  Download failed: $url (curl code $code - $(CurlReason "$code")${msg:+; curl: $msg}). Run the installer again - the download will resume."
    rm -f "$err"
    return 1
  done
  if [ ! -f "$part" ]; then
    say "  The downloaded file vanished between the connection and the folder - an antivirus or a folder-sync tool deletes downloads from here. Add $(dirname "$dst") to its exclusions and run the installer again; downloading the same file once more without an exclusion changes nothing."
    return 1
  fi
  # 0.6.10 wave ticket 23 (the 0.6.8 interception line, Linux form): curl says OK and hands over
  # an EMPTY file - that is something answering on the way (captive provider login, proxy block
  # page, antivirus substitute). Name it; a later checksum verdict would just confuse the story.
  if [ ! -s "$part" ]; then
    say "  The site answered with an empty file: something intercepted the transfer (a captive provider login page, a proxy block page, or an antivirus substitute). Open the site's address in a browser - if you see a login or a block page there, finish that first; otherwise add $(dirname "$dst") to the antivirus exclusions and run the installer again."
    rm -f "$part"
    return 1
  fi
  mv -f "$part" "$dst" || {
    say "  The downloaded file cannot be put in place - an antivirus or a folder-sync tool interferes with $(dirname "$dst"). Add the folder to its exclusions and run the installer again; retrying the download without an exclusion is pointless."
    return 1
  }
}

# FileOk <path> [size] [sha256] and the checked downloads - a wrong-size or wrong-hash file is
# deleted and never used, only a fresh verified download is renamed into place
FileOk() {
  [ -f "$1" ] || return 1
  local len; len="$(stat -c%s "$1" 2>/dev/null || echo 0)"
  if [ "${2:-0}" != 0 ] && [ "$len" != "$2" ]; then return 1; fi
  if [ "$len" = 0 ]; then return 1; fi
  if [ -n "${3:-}" ]; then
    local h; h="$(sha256sum "$1" | cut -d' ' -f1)"
    [ "$h" = "$3" ] || return 1
  fi
  return 0
}

HfMirrorUrl() { # <url> - the hf-mirror.com twin of a huggingface.co URL, '' for anything else
  case "$1" in
    https://huggingface.co/*) printf '%s' "https://hf-mirror.com/${1#https://huggingface.co/}" ;;
    *) printf '' ;;
  esac
}

DownloadChecked() { # <url> <dst> [size] [sha256]
  local leaf; leaf="$(basename "$2")"
  if FileOk "$2" "${3:-0}"; then
    if [ -z "${4:-}" ]; then say "    already in place: $leaf"; return 0; fi
    say "    checking checksum: $leaf"
    if FileOk "$2" "${3:-0}" "$4"; then say '    matches, no download needed'; return 0; fi
    say "    file $leaf does not match the checksum - downloading again"
  fi
  rm -f "$2"
  if ! Download "$1" "$2" "${3:-0}"; then
    # huggingface.co drops or throttles connections on whole networks (0.6.x wave, ticket 16):
    # a verified file (sha256 present) may also come from the official hf-mirror.com host -
    # the same path, the checksum verified as always, so a substituted file can never pass
    local alt; alt="$(HfMirrorUrl "$1")"
    if [ -n "$alt" ] && [ -n "${4:-}" ]; then
      say "    huggingface.co did not come through - trying the same file through hf-mirror.com (the checksum still decides)"
      Download "$alt" "$2" "${3:-0}" || return 1
    else
      return 1
    fi
  fi
  [ -n "${4:-}" ] && say "    checking checksum: $leaf"
  if ! FileOk "$2" "${3:-0}" "${4:-}"; then
    # arrived but damaged (interrupted transfers do this): one FULL re-download from scratch, then truth
    local alt2; alt2="$(HfMirrorUrl "$1")"
    rm -f "$2"
    say "  File $leaf downloaded damaged (size or sha256 mismatch) - downloading it once more from the start"
    if ! Download "$1" "$2" "${3:-0}"; then
      [ -n "$alt2" ] && [ -n "${4:-}" ] && Download "$alt2" "$2" "${3:-0}" || { rm -f "$2"; say "  file $leaf downloaded damaged (size or sha256 mismatch); removed - run the installer again"; return 1; }
    fi
    if ! FileOk "$2" "${3:-0}" "${4:-}"; then
      rm -f "$2"
      say "  file $leaf downloaded damaged (size or sha256 mismatch); removed - run the installer again"
      return 1
    fi
  fi
}

# DownloadMirrors <dst> <size> <sha> <url> [url...] - the primary site first, then the official
# mirrors of installer/manifest.json; the checksum is verified on whichever site answered
DownloadMirrors() {
  local dst="$1" size="$2" sha="$3"; shift 3
  local urls=("$@") n="${#@}" i
  if [ "$n" = 0 ]; then say "  Download failed: no address given for $dst."; return 1; fi
  for ((i = 0; i < n; i++)); do
    if DownloadChecked "${urls[i]}" "$dst" "$size" "$sha"; then return 0; fi
    [ "$i" -lt $((n-1)) ] && say "    using the backup mirror $((i+2)) of $n"
  done
  say "  Download failed: $dst - none of the $n mirrors answered."
  return 1
}

# UvTry <what> <tries> <cmd...> - the Uvx of Install.ps1: uv/pip downloads of the multi-GB PyTorch
# class get a second and third chance on network failures with a growing pause; the first 'error:'
# line and the last 'cause'/'Caused by' line ride along into the log, and a network failure ends
# with the advice about the package servers. Non-network errors fail at once (retries would not help).
UvTry() {
  local what="$1" tries="$2" outf code try=1 why net wait
  shift 2
  outf="$(mktemp "${TMPDIR:-/tmp}/af-uv.XXXXXX")"
  while :; do
    say "    $what$( [ "$try" -gt 1 ] && printf ' - try %s of %s' "$try" "$tries" )"
    "$@" > >(tee "$outf" >/dev/null) 2>&1; code=$?
    if [ "$code" = 0 ]; then rm -f "$outf"; return 0; fi
    why="$( { grep -m1 -Ei '^[[:space:]]*error:' "$outf"; grep -Ei '^[[:space:]]*(caused by|cause):' "$outf" | tail -1; } 2>/dev/null \
      | tr '\n' '|'; )"
    why="$(printf '%s' "$why" | sed 's/|*$//; s/|/ · /g; s/^[[:space:]]*//; s/[[:space:]]*$//; s/[[:space:]]\{2,\}/ /g')"
    if grep -Eqi 'timed out|timeout|connect|error sending request|failed to fetch|failed to download|connection|dns|reset|broken pipe|tls|certificate|server error|50[0-9] ' "$outf"; then net=1; else net=''; fi
    if [ -z "$net" ] || [ "$try" -ge "$tries" ]; then
      say "  $what - failed (code $code)${why:+: $why}."
      if [ -n "$net" ]; then
        say '  The Python package servers (download.pytorch.org, pypi.org) did not answer or dropped the connection:'
        say '  a slow or unstable link, sometimes the provider gets in the way - another network or a VPN helps.'
        say '  Run the installer again: packages already downloaded are not downloaded a second time.'
      fi
      rm -f "$outf"; return "$code"
    fi
    wait=$(( ${ASTRA_UV_WAIT:-20} * try ))
    say "    the network faltered (${why:-no error line}) - waiting ${wait}s and trying again"
    sleep "$wait"
    try=$((try+1))
  done
}
