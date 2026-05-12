#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""AIQ Research API client with Starfleet device-flow OAuth authentication."""

import json
import os
import platform
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Curl argv safety (defense in depth: list args, no shell — still reject odd inputs)
# ---------------------------------------------------------------------------

_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
_JOB_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_AGENT_TYPE_RE = re.compile(r"^[a-zA-Z0-9_.-]{1,128}$")
_ALLOWED_CURL_METHODS = frozenset({"GET", "POST"})
_MAX_AIQ_BASE_URL_LEN = 2048
_MAX_API_PATH_LEN = 4096
_MAX_FULL_URL_LEN = 8192
_MAX_BEARER_TOKEN_LEN = 65536
_MAX_HEADER_KEY_LEN = 256
_MAX_HEADER_VALUE_LEN = 8192


def _validate_aiq_base_url(url: str) -> str:
    """Require http(s) URL with host; no credentials or control characters."""
    raw = (url or "").strip()
    if not raw:
        raise RuntimeError("AIQ_SERVER_URL is empty")
    if len(raw) > _MAX_AIQ_BASE_URL_LEN:
        raise RuntimeError("AIQ_SERVER_URL exceeds maximum length")
    if _CONTROL_CHAR_RE.search(raw):
        raise RuntimeError("AIQ_SERVER_URL contains disallowed control characters")
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in ("https", "http"):
        raise RuntimeError("AIQ_SERVER_URL must be an http or https URL")
    if not parsed.netloc:
        raise RuntimeError("AIQ_SERVER_URL must include a host name")
    if parsed.username is not None or parsed.password is not None:
        raise RuntimeError("AIQ_SERVER_URL must not include user:password@ in the URL")
    return raw


def _validate_api_path(path: str) -> None:
    """Reject path smuggling (//, ..), control chars, and non-relative paths."""
    if not path.startswith("/") or path.startswith("//"):
        raise RuntimeError("Invalid API path")
    if len(path) > _MAX_API_PATH_LEN or ".." in path or _CONTROL_CHAR_RE.search(path):
        raise RuntimeError("Invalid API path")


def _validate_full_request_url(url: str) -> None:
    if len(url) > _MAX_FULL_URL_LEN or _CONTROL_CHAR_RE.search(url):
        raise RuntimeError("Invalid request URL")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("https", "http") or not parsed.netloc:
        raise RuntimeError("Invalid request URL")


def _validate_bearer_token(token: str) -> str:
    if len(token) > _MAX_BEARER_TOKEN_LEN:
        raise RuntimeError("Bearer token exceeds maximum length")
    if _CONTROL_CHAR_RE.search(token):
        raise RuntimeError("Bearer token contains disallowed characters")
    return token


def _validate_header_dict(headers: dict[str, str]) -> None:
    for k, v in headers.items():
        if len(k) > _MAX_HEADER_KEY_LEN or len(v) > _MAX_HEADER_VALUE_LEN:
            raise RuntimeError("HTTP header key or value too long")
        if _CONTROL_CHAR_RE.search(k) or _CONTROL_CHAR_RE.search(v):
            raise RuntimeError("HTTP header contains disallowed characters")


def _validate_job_id(job_id: str) -> str:
    j = job_id.strip()
    if not _JOB_UUID_RE.fullmatch(j):
        raise RuntimeError("job_id must be a UUID")
    return j


def _validate_agent_type(agent_type: str) -> str:
    a = agent_type.strip()
    if not _AGENT_TYPE_RE.fullmatch(a):
        raise RuntimeError("Invalid agent_type")
    return a


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

AIQ_STARFLEET_CLIENT_ID = "yiOW0S_IzL5qY26huFw3xNzUX7RupZuzdawrNcPcH3w"  # pragma: allowlist secret
AIQ_SERVER_URL = _validate_aiq_base_url(os.environ.get("AIQ_SERVER_URL", "https://api.aiq.nvidia.com"))
DEFAULT_AGENT_TYPE = "shallow_researcher"
STARFLEET_CACHE_FILE = Path.home() / ".aiq" / "tokens" / "starfleet_credentials.json"
STARFLEET_AUTH_BASE_URL = "https://login.nvidia.com"
REFRESH_TOKEN_VALIDITY_SECONDS = 604800  # 7 days
TOKEN_REFRESH_BUFFER_SECONDS = 300  # refresh 5 min before expiry

# Starfleet OAuth (login.nvidia.com)
STARFLEET_OAUTH_SCOPE = "openid email profile"
OAUTH_GRANT_TYPE_DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code"
OAUTH_GRANT_TYPE_REFRESH_TOKEN = "refresh_token"
OAUTH_ERROR_AUTHORIZATION_PENDING = "authorization_pending"
OAUTH_ERROR_SLOW_DOWN = "slow_down"

DEVICE_LOGIN_TIMEOUT_SECONDS = 600
DEVICE_POLL_INTERVAL_MIN_SECONDS = 1

# AIQ HTTP: short JSON calls vs long-running chat / polling / SSE
DEFAULT_API_TIMEOUT_SECONDS = 120
DEFAULT_LONG_HTTP_TIMEOUT_SECONDS = 3600

JOB_POLL_INTERVAL_SECONDS = 15
STATUS_CHECK_MAX_ATTEMPTS = 3
POLL_MAX_CONSECUTIVE_ERRORS = 3

# Terminal states returned by async job status polling
_DONE_JOB_STATES = frozenset({"completed", "success", "failed", "cancelled", "failure"})
_SUCCESS_JOB_STATES = frozenset({"completed", "success"})
_FAILED_JOB_STATES = frozenset({"failed", "failure", "cancelled"})
_STREAM_TERMINAL_EVENTS = frozenset({"complete", "error", "done"})

_LINUX_CA_CANDIDATES = [
    "/etc/ssl/certs/ca-certificates.crt",  # Debian/Ubuntu
    "/etc/pki/tls/certs/ca-bundle.crt",  # RHEL/CentOS/Fedora
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",  # RHEL 7+
    "/etc/ssl/ca-bundle.pem",  # SUSE
    "/etc/ssl/certs/ca-bundle.crt",  # some distros
    "/etc/pki/tls/cert.pem",  # some RHEL variants
    "/etc/ssl/cert.pem",  # Alpine / BSD
    "/usr/local/etc/openssl/cert.pem",  # BSD-like / Homebrew OpenSSL
]

_WINDOWS_CA_CANDIDATES = [
    r"C:\Program Files\Git\usr\ssl\certs\ca-bundle.crt",
    r"C:\Program Files (x86)\Git\usr\ssl\certs\ca-bundle.crt",
    r"C:\ProgramData\ssl\certs\ca-bundle.crt",
    r"C:\msys64\usr\ssl\certs\ca-bundle.crt",
    r"C:\cygwin64\usr\ssl\certs\ca-bundle.crt",
    r"C:\cygwin\usr\ssl\certs\ca-bundle.crt",
]

_INSECURE_ENV_VALUES = ("1", "true", "yes")
_insecure_warning_emitted = False


def _is_insecure_tls_enabled() -> bool:
    """Return True when AIQ_INSECURE disables TLS verification."""
    return os.environ.get("AIQ_INSECURE", "1").lower() in _INSECURE_ENV_VALUES


def _warn_if_insecure_tls_enabled() -> None:
    """Emit a prominent warning once per process when TLS verification is disabled."""
    global _insecure_warning_emitted
    if _insecure_warning_emitted or not _is_insecure_tls_enabled():
        return
    _insecure_warning_emitted = True
    print(
        "WARNING: AIQ_INSECURE is enabled. TLS certificate verification is disabled for AIQ requests. "
        "This weakens transport security and can expose tokens and research data to interception. "
        "Use only for temporary debugging on a trusted network.",
        file=sys.stderr,
    )


def _find_ca_bundle(system: str) -> str | None:
    """Find a usable CA bundle for the given platform.

    Checks well-known paths first. If none exist, falls back to discovery via
    Python's ssl module and (on Linux) the ``openssl`` CLI. Prints a hint when
    discovery is used so the caller can persist the result in AIQ_CACERT.

    Returns the path if found, None if nothing could be located.
    """
    candidates = _WINDOWS_CA_CANDIDATES if system == "Windows" else _LINUX_CA_CANDIDATES
    for path in candidates:
        if Path(path).exists():
            return path

    # --- Discovery (only reached when no candidate matched) ---
    discovered: str | None = None

    # Python's ssl module knows where OpenSSL was compiled to look
    try:
        import ssl

        ssl_paths = ssl.get_default_verify_paths()
        for attr in ("cafile", "openssl_cafile"):
            val = getattr(ssl_paths, attr, None)
            if val and Path(val).exists():
                discovered = val
                break
    except Exception:
        pass

    # On Linux, ask openssl directly
    if not discovered and system != "Windows":
        try:
            result = subprocess.run(
                ["openssl", "version", "-d"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            m = re.search(r'OPENSSLDIR:\s*"([^"]+)"', result.stdout)
            if m:
                base = Path(m.group(1))
                for name in ("certs/ca-certificates.crt", "cert.pem", "certs/ca-bundle.crt"):
                    p = base / name
                    if p.exists():
                        discovered = str(p)
                        break
        except Exception:
            pass

    # On Windows, walk from the curl binary to find a sibling ca-bundle
    if not discovered and system == "Windows":
        try:
            result = subprocess.run(
                ["where.exe", "curl"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            if result.returncode == 0:
                for curl_str in result.stdout.strip().splitlines():
                    curl_bin = Path(curl_str.strip())
                    for rel in (
                        Path("..") / "ssl" / "certs" / "ca-bundle.crt",  # Git Bash
                        Path("..") / "etc" / "ssl" / "certs" / "ca-bundle.crt",  # MSYS2
                    ):
                        p = (curl_bin.parent / rel).resolve()
                        if p.exists():
                            discovered = str(p)
                            break
                    if discovered:
                        break
        except Exception:
            pass

    if discovered:
        print(
            f"  Tip: CA bundle auto-discovered at: {discovered}\n"
            f"  Set AIQ_CACERT={discovered} to skip this discovery next time.",
            file=sys.stderr,
        )
        return discovered

    print(
        f"  Warning: No CA bundle found on {system}. SSL connections may fail if the\n"
        "  NVIDIA CA is not in the system trust store.\n"
        "  Fix: set AIQ_CACERT=/path/to/ca-bundle.pem",
        file=sys.stderr,
    )
    return None


def _build_curl_cmd() -> list[str]:
    """Return base curl invocation with platform-appropriate CA cert handling.

    NVIDIA internal servers use a private CA pushed by IT/MDM. Each OS has
    a different trust store, so we pick the right curl accordingly:

    - macOS  : /usr/bin/curl  — Apple SecureTransport reads from Keychain (NVIDIA CA via MDM)
    - Windows: System32/curl.exe — Schannel reads from Windows Certificate Store (NVIDIA CA via MDM)
    - Linux/WSL: system curl — uses OS trust store (NVIDIA CA installed by IT provisioning)

    When no system trust store is available, _find_ca_bundle() probes common
    paths and falls back to discovery, printing the found path so users can
    pin it via AIQ_CACERT.

    Override: set AIQ_CACERT=/path/to/nvidia-ca.pem to pass --cacert on any platform.
    """
    system = platform.system()
    cacert = os.environ.get("AIQ_CACERT")

    using_native_trust_store = False

    if system == "Darwin":
        # Apple SecureTransport reads from Keychain — no --cacert needed
        cmd = ["/usr/bin/curl"]
        using_native_trust_store = True
    elif system == "Windows":
        system_root = os.environ.get("SystemRoot", r"C:\Windows")
        win_curl = Path(system_root) / "System32" / "curl.exe"
        if win_curl.exists():
            # System32 curl uses Schannel — no --cacert needed
            cmd = [str(win_curl)]
            using_native_trust_store = True
        else:
            # Third-party curl (Git Bash, MSYS2, …) — needs explicit CA bundle
            cmd = ["curl"]
    else:
        # Linux / WSL
        cmd = ["curl"]

    if not cacert and not using_native_trust_store:
        cacert = _find_ca_bundle(system)

    if cacert:
        cmd += ["--cacert", cacert]

    if _is_insecure_tls_enabled():
        cmd += ["--insecure"]

    return cmd


_CURL_CMD = _build_curl_cmd()


def _curl_json_headers_and_body_args(
    token: str | None,
    extra_headers: dict[str, str] | None,
    body: dict[str, Any] | list[Any] | None,
) -> list[str]:
    """Shared curl flags: JSON Content-Type, Bearer token, extra headers, JSON body (-d)."""
    parts = ["-H", "Content-Type: application/json"]
    if token:
        parts += ["-H", f"Authorization: Bearer {token}"]
    if extra_headers:
        for k, v in extra_headers.items():
            parts += ["-H", f"{k}: {v}"]
    if body is not None:
        parts += ["-d", json.dumps(body)]
    return parts


def _get_mac_address() -> str:
    """Colon-separated MAC from uuid.getnode() for device OAuth."""
    mac = uuid.getnode()
    return ":".join([f"{(mac >> i) & 0xFF:02x}" for i in range(0, 48, 8)][::-1])


# Starfleet OAuth uses stdlib urllib against login.nvidia.com. That host uses a public CA
# chain, so urllib's default SSL context is sufficient (unlike AIQ, which may need AIQ_CACERT).
# AIQ API calls use the curl subprocess so AIQ_CACERT / platform CA apply to internal hosts.


def _post_form(url: str, params: dict, timeout: int = 30) -> dict:
    """POST form-encoded params to url; return response JSON dict."""
    data = urllib.parse.urlencode(params).encode()
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _get_json(url: str, token: str | None = None, timeout: int = 30) -> dict:
    """GET url with optional Bearer token; return response JSON dict."""
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _curl_api(
    method: str,
    url: str,
    body: dict[str, Any] | list[Any] | None = None,
    token: str | None = None,
    extra_headers: dict[str, str] | None = None,
    timeout: int = DEFAULT_API_TIMEOUT_SECONDS,
) -> dict:
    """Non-streaming HTTP request via curl, using the platform's system CA trust store."""
    if method not in _ALLOWED_CURL_METHODS:
        raise RuntimeError(f"Unsupported HTTP method for curl: {method!r}")
    _validate_full_request_url(url)
    cmd = _CURL_CMD + ["--silent", "--show-error", "--max-time", str(timeout), "-X", method, "-w", "\n%{http_code}"]
    cmd.extend(_curl_json_headers_and_body_args(token, extra_headers, body))
    cmd.append(url)

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout + 30,
        check=False,
    )

    parts = result.stdout.rsplit("\n", 1)
    resp_body = parts[0] if len(parts) > 1 else result.stdout
    status_str = parts[1].strip() if len(parts) > 1 else "0"
    status_code = int(status_str) if status_str.isdigit() else 0

    if status_code >= 400:
        print(f"HTTP {status_code}: {resp_body[:500]}", file=sys.stderr)
        raise RuntimeError(f"HTTP {status_code}")
    if result.returncode != 0 and status_code == 0:
        print(f"curl error: {result.stderr.strip()}", file=sys.stderr)
        raise RuntimeError(f"curl failed: {result.stderr.strip()}")

    try:
        return json.loads(resp_body)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON in API response: {resp_body[:500]!r}", file=sys.stderr)
        raise RuntimeError(f"Invalid JSON in API response: {e}") from e


def _load_cached_credentials() -> dict | None:
    """Load Starfleet credential cache JSON, or None if missing/unreadable."""
    if not STARFLEET_CACHE_FILE.exists():
        return None
    try:
        with open(STARFLEET_CACHE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Warning: could not read cached credentials: {e}", file=sys.stderr)
        return None


def _save_credentials(creds: dict) -> None:
    """Persist creds to the Starfleet cache path with restrictive file modes."""
    tokens_dir = STARFLEET_CACHE_FILE.parent
    tokens_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(tokens_dir, 0o700)
    # mkdir(..., parents=True) may create ~/.aiq/ with a loose umask; lock that down too.
    aiq_dir = tokens_dir.parent
    if aiq_dir.exists():
        os.chmod(aiq_dir, 0o700)
    fd = os.open(STARFLEET_CACHE_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(creds, f, indent=2)


def _fetch_client_token(access_token: str) -> tuple[str, float]:
    """Fetch the client_token using the access_token. Returns (client_token, expires_at)."""
    data = _get_json(f"{STARFLEET_AUTH_BASE_URL}/client_token", token=access_token)
    return data["client_token"], time.time() + data["expires_in"]


def _device_login_flow(client_id: str) -> dict:
    """Run interactive OAuth device flow. Returns credentials dict."""
    params = {
        "client_id": client_id,
        "device_id": _get_mac_address(),
        "display_name": socket.gethostname(),
        "scope": STARFLEET_OAUTH_SCOPE,
    }
    device_auth = _post_form(f"{STARFLEET_AUTH_BASE_URL}/device/authorize", params)

    url = device_auth["verification_uri_complete"]
    print("\n" + "=" * 80, file=sys.stderr)
    print("NVIDIA Authentication Required", file=sys.stderr)
    print("=" * 80, file=sys.stderr)
    print("\nOpening browser for authentication...", file=sys.stderr)
    print(f"If the browser doesn't open, go to:\n  {url}", file=sys.stderr)
    print(f"\nOr visit: {device_auth['verification_uri']}", file=sys.stderr)
    print(f"And enter code: {device_auth['user_code']}", file=sys.stderr)
    print("=" * 80, file=sys.stderr)
    webbrowser.open(url)
    print(f"\nWaiting for you to complete login at:\n  {url}\n", file=sys.stderr)

    interval = max(device_auth.get("interval", 5), DEVICE_POLL_INTERVAL_MIN_SECONDS)
    device_code = device_auth["device_code"]
    deadline = time.time() + DEVICE_LOGIN_TIMEOUT_SECONDS

    while time.time() < deadline:
        time.sleep(interval)
        try:
            token_data = _post_form(
                f"{STARFLEET_AUTH_BASE_URL}/token",
                {
                    "grant_type": OAUTH_GRANT_TYPE_DEVICE_CODE,
                    "device_code": device_code,
                    "client_id": client_id,
                },
            )
        except urllib.error.HTTPError as e:
            body = json.loads(e.read().decode("utf-8", errors="replace"))
            error = body.get("error")
            if error == OAUTH_ERROR_AUTHORIZATION_PENDING:
                continue
            elif error == OAUTH_ERROR_SLOW_DOWN:
                interval += 5
                continue
            else:
                print(f"Authorization failed: {body}", file=sys.stderr)
                sys.exit(1)

        break
    else:
        print("Device login timed out.", file=sys.stderr)
        sys.exit(1)

    id_token_expires_at = time.time() + token_data["expires_in"]
    refresh_token = token_data.get("refresh_token")
    refresh_token_expires_at = time.time() + REFRESH_TOKEN_VALIDITY_SECONDS if refresh_token else None

    client_token, client_token_expires_at = _fetch_client_token(token_data["access_token"])

    print("Authenticated successfully.", file=sys.stderr)

    return {
        "id_token": token_data["id_token"],
        "access_token": token_data["access_token"],
        "token_type": token_data["token_type"],
        "id_token_expires_at": id_token_expires_at,
        "client_token": client_token,
        "client_token_expires_at": client_token_expires_at,
        "refresh_token": refresh_token,
        "refresh_token_expires_at": refresh_token_expires_at,
        "updated_at": time.time(),
        "client_id": client_id,  # persisted so future sessions don't need the env var
    }


def _refresh_tokens(creds: dict, client_id: str) -> dict:
    """Refresh using the refresh_token. Returns updated credentials dict."""
    token_data = _post_form(
        f"{STARFLEET_AUTH_BASE_URL}/token",
        {
            "grant_type": OAUTH_GRANT_TYPE_REFRESH_TOKEN,
            "refresh_token": creds["refresh_token"],
            "client_id": client_id,
        },
    )

    id_token_expires_at = time.time() + token_data["expires_in"]
    refresh_token = token_data.get("refresh_token") or creds["refresh_token"]
    refresh_token_expires_at = (
        time.time() + REFRESH_TOKEN_VALIDITY_SECONDS
        if token_data.get("refresh_token")
        else creds.get("refresh_token_expires_at")
    )

    client_token, client_token_expires_at = _fetch_client_token(token_data["access_token"])

    return {
        "id_token": token_data["id_token"],
        "access_token": token_data["access_token"],
        "token_type": token_data["token_type"],
        "id_token_expires_at": id_token_expires_at,
        "client_token": client_token,
        "client_token_expires_at": client_token_expires_at,
        "refresh_token": refresh_token,
        "refresh_token_expires_at": refresh_token_expires_at,
        "updated_at": time.time(),
        "client_id": client_id,  # preserved so future sessions don't need the env var
    }


def check_auth() -> bool:
    """Return True only if the id_token is still valid (local clock check only)."""
    creds = _load_cached_credentials()
    if not creds:
        return False
    return time.time() < creds.get("id_token_expires_at", 0) - TOKEN_REFRESH_BUFFER_SECONDS


def _try_silent_refresh() -> bool:
    """If refresh_token is still valid, refresh and persist. Returns True on success."""
    creds = _load_cached_credentials()
    if not creds:
        return False
    client_id = AIQ_STARFLEET_CLIENT_ID
    refresh_token = creds.get("refresh_token")
    refresh_token_expires_at = creds.get("refresh_token_expires_at")
    if not refresh_token or not refresh_token_expires_at or time.time() >= refresh_token_expires_at:
        return False
    try:
        print("Refreshing Starfleet token...", file=sys.stderr)
        creds = _refresh_tokens(creds, client_id)
        _save_credentials(creds)
        return True
    except Exception as e:
        print(f"Silent token refresh failed ({e})", file=sys.stderr)
        return False


def get_token(force_login: bool = False) -> str:
    """Get a valid Starfleet id_token, using cache → refresh → device flow."""
    client_id = AIQ_STARFLEET_CLIENT_ID

    if not force_login:
        creds = _load_cached_credentials()
        if creds:
            id_token_expires_at = creds.get("id_token_expires_at", 0)

            # Token still valid
            if time.time() < id_token_expires_at - TOKEN_REFRESH_BUFFER_SECONDS:
                return creds["id_token"]

            # Token expiring/expired — try refresh
            if _try_silent_refresh():
                creds = _load_cached_credentials()
                if creds:
                    return creds["id_token"]

    # Full device flow login
    creds = _device_login_flow(client_id)
    _save_credentials(creds)
    return creds["id_token"]


# ---------------------------------------------------------------------------
# AIQ API calls
# ---------------------------------------------------------------------------


def _api_request(
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    token: str | None = None,
    stream: bool = False,
    extra_headers: dict[str, str] | None = None,
    timeout: int | None = None,
) -> dict | subprocess.Popen[bytes]:
    """Make an HTTP request to the AIQ server via curl (uses platform system CA trust store).

    ``timeout`` is the curl ``--max-time`` (seconds). If omitted, streaming requests default to
    ``DEFAULT_LONG_HTTP_TIMEOUT_SECONDS``; non-streaming requests default to ``DEFAULT_API_TIMEOUT_SECONDS``.
    """
    if method not in _ALLOWED_CURL_METHODS:
        raise RuntimeError(f"Unsupported HTTP method for curl: {method!r}")
    _validate_api_path(path)
    if token is not None:
        token = _validate_bearer_token(token)
    if extra_headers:
        _validate_header_dict(extra_headers)
    url = f"{AIQ_SERVER_URL}{path}"
    _validate_full_request_url(url)

    if stream:
        stream_timeout = timeout if timeout is not None else DEFAULT_LONG_HTTP_TIMEOUT_SECONDS
        cmd = _CURL_CMD + [
            "--silent",
            "--show-error",
            "--no-buffer",
            "-N",
            "--max-time",
            str(stream_timeout),
            "-X",
            method,
        ]
        cmd.extend(_curl_json_headers_and_body_args(token, extra_headers, body))
        cmd.append(url)
        return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    api_timeout = timeout if timeout is not None else DEFAULT_API_TIMEOUT_SECONDS
    return _curl_api(method, url, body=body, token=token, extra_headers=extra_headers, timeout=api_timeout)


def list_agents(token: str) -> dict:
    """GET /v1/jobs/async/agents — available async agent types."""
    return _api_request("GET", "/v1/jobs/async/agents", token=token)


def submit_job(query: str, agent_type: str = DEFAULT_AGENT_TYPE, token: str | None = None) -> dict:
    """POST async job submit; returns JSON including job_id when accepted."""
    agent_type = _validate_agent_type(agent_type)
    body = {"agent_type": agent_type, "input": query}
    return _api_request("POST", "/v1/jobs/async/submit", body=body, token=token)


def get_job_status(job_id: str, token: str) -> dict:
    """GET async job status JSON for job_id."""
    job_id = _validate_job_id(job_id)
    return _api_request("GET", f"/v1/jobs/async/job/{job_id}", token=token)


def stream_job(job_id: str, token: str) -> None:
    """Stream job SSE payload lines to stdout until terminal event."""
    job_id = _validate_job_id(job_id)
    proc = _api_request("GET", f"/v1/jobs/async/job/{job_id}/stream", token=token, stream=True)
    try:
        for raw_line in proc.stdout:
            line = raw_line.decode("utf-8").strip()
            if line.startswith("data:"):
                data = line[5:].strip()
                if data:
                    print(data, flush=True)
            elif line.startswith("event:"):
                event_type = line[6:].strip()
                if event_type in _STREAM_TERMINAL_EVENTS:
                    break
    finally:
        proc.stdout.close()
        proc.stderr.close()
        try:
            proc.wait(timeout=DEFAULT_LONG_HTTP_TIMEOUT_SECONDS + 60)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def get_report(job_id: str, token: str) -> dict:
    """GET final async job report JSON."""
    job_id = _validate_job_id(job_id)
    return _api_request("GET", f"/v1/jobs/async/job/{job_id}/report", token=token)


def cancel_job(job_id: str, token: str) -> dict:
    """POST cancel for async job_id; returns API JSON."""
    job_id = _validate_job_id(job_id)
    return _api_request("POST", f"/v1/jobs/async/job/{job_id}/cancel", token=token)


def get_job_state(job_id: str, token: str) -> dict:
    """GET /v1/jobs/async/job/{job_id}/state — event-store artifacts (tool calls, steps, etc.)."""
    job_id = _validate_job_id(job_id)
    return _api_request("GET", f"/v1/jobs/async/job/{job_id}/state", token=token)


def _handle_interrupt(job_id: str, token: str) -> None:
    """Handle Ctrl+C during poll: print resume help, optionally cancel, then exit."""
    print(f"\n\nInterrupted. Job {job_id} is still running server-side.", file=sys.stderr)
    print(f"  Resume later:  aiq.py research_poll {job_id}", file=sys.stderr)
    print(f"  Fetch report:  aiq.py report {job_id}", file=sys.stderr)

    if sys.stdin.isatty():
        try:
            answer = input("Cancel the server-side job? [y/N] ").strip().lower()
        except (EOFError, OSError, KeyboardInterrupt):
            answer = ""
        if answer == "y":
            try:
                cancel_job(job_id, token)
                print(f"Job {job_id} cancelled.", file=sys.stderr)
            except Exception as e:
                print(f"Cancel failed: {e}", file=sys.stderr)
        else:
            print("Job left running. Use research_poll to resume.", file=sys.stderr)
    sys.exit(1)


def chat_request(query: str, token: str, timeout: int = DEFAULT_LONG_HTTP_TIMEOUT_SECONDS) -> dict:
    """POST /chat (headless); returns routing/shallow/deep JSON response."""
    body = {"messages": [{"role": "user", "content": query}]}
    print(f"Sending request to: {AIQ_SERVER_URL}/chat", file=sys.stderr)
    return _api_request(
        "POST",
        "/chat",
        body=body,
        token=token,
        extra_headers={"X-AIQ-Mode": "headless"},
        timeout=timeout,
    )


def poll_until_complete(
    job_id: str,
    token: str,
    timeout: int = DEFAULT_LONG_HTTP_TIMEOUT_SECONDS,
    max_consecutive_errors: int = POLL_MAX_CONSECUTIVE_ERRORS,
) -> dict:
    """Poll get_job_status until done/failed or wall timeout; returns last status dict."""
    deadline = time.time() + timeout
    consecutive_errors = 0
    while time.time() < deadline:
        try:
            status = get_job_status(job_id, token)
            consecutive_errors = 0
        except RuntimeError as exc:
            consecutive_errors += 1
            if consecutive_errors >= max_consecutive_errors:
                print(f"  Status check failed {consecutive_errors} times in a row: {exc}", file=sys.stderr)
                raise
            print(
                f"  Status check failed ({exc}), retrying... ({consecutive_errors}/{max_consecutive_errors})",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(JOB_POLL_INTERVAL_SECONDS)
            continue
        state = status.get("status", "UNKNOWN").lower()
        if state in _DONE_JOB_STATES:
            return status
        print(f"  Status: {state}", file=sys.stderr, flush=True)
        time.sleep(JOB_POLL_INTERVAL_SECONDS)
    print("  Timed out waiting for job.", file=sys.stderr)
    return {"status": "TIMEOUT"}


def _poll_until_success_or_exit(job_id: str, token: str) -> None:
    """Poll until job succeeds; print report JSON or exit non-zero on failure/timeout."""
    try:
        final = poll_until_complete(job_id, token, timeout=DEFAULT_LONG_HTTP_TIMEOUT_SECONDS)
    except KeyboardInterrupt:
        _handle_interrupt(job_id, token)
        return  # _handle_interrupt always exits, but guard against future changes

    if final.get("status", "").lower() not in _SUCCESS_JOB_STATES:
        print(f"Job did not complete: {final.get('status')}", file=sys.stderr)
        print(json.dumps(final, indent=2))
        sys.exit(1)

    report = get_report(job_id, token)
    print(json.dumps(report, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    """Parse argv and run aiq.py CLI subcommands."""
    _warn_if_insecure_tls_enabled()
    if len(sys.argv) < 2:
        print("Usage: aiq.py <command> [args]")
        print()
        print("Commands:")
        print("  login                         Authenticate via browser device flow (re-login)")
        print("  check-auth                    Local id_token ok, else silent OAuth refresh; exit 1 = need browser")
        print("  chat <query>                  POST /chat — auto-routes shallow/deep, returns full response")
        print("  agents                        List available agent types")
        print("  submit <query> [agent_type]   Submit an async job (explicit agent type)")
        print("  status <job_id>               Job status + /state artifacts (event store)")
        print("  stream <job_id>               Stream SSE events from an async job")
        print("  report <job_id>               Get final report from an async job")
        print("  research <query> [agent_type] Submit async job, poll, and return report")
        print("  research_poll <job_id>        Resume polling an existing async job")
        print("  cancel <job_id>               Cancel a running async job")
        print("  state <job_id>                Event-store artifacts for one async job (/state)")
        print()
        print("Environment:")
        print("  AIQ_SERVER_URL                AIQ server base URL")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "check-auth":
        if check_auth():
            print("ok")
            sys.exit(0)
        if _try_silent_refresh():
            print("ok")
            sys.exit(0)
        print("need_browser_login")
        sys.exit(1)

    elif cmd == "login":
        if _try_silent_refresh():
            print("Token refreshed successfully.", file=sys.stderr)
            return
        get_token(force_login=True)
        print("Login complete. Credentials cached at:", STARFLEET_CACHE_FILE, file=sys.stderr)
        return

    token = get_token()

    if cmd == "chat":
        if len(sys.argv) < 3:
            print("Usage: aiq.py chat <query>", file=sys.stderr)
            sys.exit(1)
        query = sys.argv[2]
        result = chat_request(query, token)

        content = ""
        try:
            content = result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            pass

        match = re.search(r"Job ID:\s*([0-9a-f-]{36})", content, re.IGNORECASE)
        if match:
            job_id = match.group(1)
            # Print structured output and exit — caller should run `research_poll <job_id>` in background
            print(json.dumps({"status": "deep_research_running", "job_id": job_id}))
        else:
            print(json.dumps(result, indent=2))

    elif cmd == "agents":
        agents = list_agents(token)
        print(json.dumps(agents, indent=2))

    elif cmd == "submit":
        if len(sys.argv) < 3:
            print("Usage: aiq.py submit <query> [agent_type]", file=sys.stderr)
            sys.exit(1)
        query = sys.argv[2]
        agent_type = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_AGENT_TYPE
        result = submit_job(query, agent_type=agent_type, token=token)
        print(json.dumps(result, indent=2))

    elif cmd == "status":
        if len(sys.argv) < 3:
            print("Usage: aiq.py status <job_id>", file=sys.stderr)
            sys.exit(1)
        job_id = sys.argv[2]
        job_status = get_job_status(job_id, token)
        try:
            job_state = get_job_state(job_id, token)
        except RuntimeError as exc:
            job_state = {"_fetch_error": str(exc)}
        print(json.dumps({"job_status": job_status, "job_state": job_state}, indent=2))

    elif cmd == "stream":
        if len(sys.argv) < 3:
            print("Usage: aiq.py stream <job_id>", file=sys.stderr)
            sys.exit(1)
        stream_job(sys.argv[2], token)

    elif cmd == "report":
        if len(sys.argv) < 3:
            print("Usage: aiq.py report <job_id>", file=sys.stderr)
            sys.exit(1)
        result = get_report(sys.argv[2], token)
        print(json.dumps(result, indent=2))

    elif cmd == "research":
        if len(sys.argv) < 3:
            print("Usage: aiq.py research <query> [agent_type]", file=sys.stderr)
            sys.exit(1)
        query = sys.argv[2]
        agent_type = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_AGENT_TYPE

        print(f"Submitting {agent_type} job...", file=sys.stderr)
        result = submit_job(query, agent_type=agent_type, token=token)
        job_id = result.get("job_id")
        if not job_id:
            print(f"ERROR: No job_id in response: {result}", file=sys.stderr)
            sys.exit(1)
        print(f"Job submitted: {job_id}", file=sys.stderr)

        _poll_until_success_or_exit(job_id, token)

    elif cmd == "research_poll":
        if len(sys.argv) < 3:
            print("Usage: aiq.py research_poll <job_id>", file=sys.stderr)
            sys.exit(1)
        job_id = sys.argv[2]

        state = "UNKNOWN"
        for attempt in range(1, STATUS_CHECK_MAX_ATTEMPTS + 1):
            try:
                status = get_job_status(job_id, token)
                state = status.get("status", "UNKNOWN").lower()
                break
            except RuntimeError as exc:
                if attempt == STATUS_CHECK_MAX_ATTEMPTS:
                    print(
                        f"Status check failed after {STATUS_CHECK_MAX_ATTEMPTS} attempts: {exc}",
                        file=sys.stderr,
                    )
                    sys.exit(1)
                print(
                    f"Status check failed ({exc}), retrying in {JOB_POLL_INTERVAL_SECONDS}s... "
                    f"({attempt}/{STATUS_CHECK_MAX_ATTEMPTS})",
                    file=sys.stderr,
                )
                time.sleep(JOB_POLL_INTERVAL_SECONDS)
        print(f"Current status: {state}", file=sys.stderr)

        if state in _SUCCESS_JOB_STATES:
            report = get_report(job_id, token)
            print(json.dumps(report, indent=2))
        elif state in _FAILED_JOB_STATES:
            print(f"Job {job_id} ended with status: {state}", file=sys.stderr)
            print(json.dumps(status, indent=2))
            sys.exit(1)
        else:
            print("Job still running, polling...", file=sys.stderr)
            _poll_until_success_or_exit(job_id, token)

    elif cmd == "cancel":
        if len(sys.argv) < 3:
            print("Usage: aiq.py cancel <job_id>", file=sys.stderr)
            sys.exit(1)
        job_id = sys.argv[2]
        result = cancel_job(job_id, token)
        print(json.dumps(result, indent=2))

    elif cmd == "state":
        if len(sys.argv) < 3:
            print("Usage: aiq.py state <job_id>", file=sys.stderr)
            sys.exit(1)
        result = get_job_state(sys.argv[2], token)
        print(json.dumps(result, indent=2))

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
