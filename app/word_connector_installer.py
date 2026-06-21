"""
Word connector installer and manager.

Handles installation, repair, and uninstallation of the Office add-in manifest
on macOS and Windows. All operations are explicit and require user approval.
"""

import json
import logging
import os
import platform
import re
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

ADDIN_ID = "b1658ecb-8a2a-5e13-8472-5f87e5feb261"
ADDIN_NAME = "citation-workspace.word-connector"
MANIFEST_FILENAME = "citation-workspace-manifest.xml"
LOCAL_CERT_NAME = "TarCite Workspace Local"
LEGACY_LOCAL_CERT_NAME = "Citation Workspace Local"
LOCAL_CERT_FILENAME = "citation-workspace-local.pem"
LOCAL_KEY_FILENAME = "citation-workspace-local-key.pem"


def _run_connector_command(command: List[str], **kwargs: Any) -> subprocess.CompletedProcess:
    """Run connector helper commands without flashing console windows on Windows."""
    if platform.system() == "Windows" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        kwargs.setdefault("creationflags", subprocess.CREATE_NO_WINDOW)
    return subprocess.run(command, **kwargs)


def _get_app_dir() -> Path:
    from app.config import BASE_DIR
    return BASE_DIR


def _get_manifest_template() -> str:
    manifest_path = _get_app_dir() / "word-addin" / "manifest.xml"
    if manifest_path.exists():
        return manifest_path.read_text(encoding="utf-8")
    return _generate_manifest_xml()


def _format_base_url(protocol: str, host: str, port: int) -> str:
    port_part = "" if (protocol == "https" and port == 443) or (protocol == "http" and port == 80) else f":{port}"
    return f"{protocol}://{host}{port_part}"


def _local_cert_dir() -> Path:
    cert_dir = Path.home() / ".citation-workspace"
    cert_dir.mkdir(parents=True, exist_ok=True)
    return cert_dir


def _local_cert_paths() -> tuple[Path, Path]:
    cert_dir = _local_cert_dir()
    return cert_dir / LOCAL_CERT_FILENAME, cert_dir / LOCAL_KEY_FILENAME


def _get_word_base_url() -> str:
    """Return the URL Word should load from the local manifest.

    Prefer the app's real listening port. Earlier builds used port 443 and
    depended on pfctl forwarding 443 -> 4443; that can disappear after reboot
    or during distribution installs, while the server on 4443 is still healthy.
    """
    from app.config import config

    protocol = "https" if config.use_https else "http"
    host = config.app_display_host or config.app_host or "127.0.0.1"
    if detect_platform() == "windows" and protocol == "https":
        host = "localhost"
    candidate_ports = []
    for port in (config.app_port, 4443, config.app_external_port, 443):
        try:
            port = int(port)
        except (TypeError, ValueError):
            continue
        if port not in candidate_ports:
            candidate_ports.append(port)

    for port in candidate_ports:
        if _is_tcp_reachable(host, port) or _is_tcp_reachable("127.0.0.1", port):
            return _format_base_url(protocol, host, port)

    fallback_port = int(config.app_port) if int(config.app_port) != 443 else 4443
    return _format_base_url(protocol, host, fallback_port)


def _generate_manifest_xml() -> str:
    base_url = _get_word_base_url()
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
           xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
           xsi:type="TaskPaneApp">

  <Id>{ADDIN_ID}</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>TarCite Workspace</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="TarCite Workspace"/>
  <Description DefaultValue="Insert and manage citations from your local library directly within Microsoft Word."/>
  <IconUrl DefaultValue="{base_url}/static/logo/favicon-32x32.png"/>
  <HighResolutionIconUrl DefaultValue="{base_url}/static/logo/android-chrome-192x192.png"/>
  <SupportUrl DefaultValue="https://tarcite.com/"/>
  <AppDomains>
    <AppDomain>{base_url}</AppDomain>
  </AppDomains>

  <Hosts>
    <Host Name="Document"/>
  </Hosts>

  <Requirements>
    <Sets DefaultMinVersion="1.1">
      <Set Name="SharedRuntime" MinVersion="1.1"/>
    </Sets>
  </Requirements>

  <DefaultSettings>
    <SourceLocation DefaultValue="{base_url}/word-addin/taskpane.html"/>
  </DefaultSettings>

  <Permissions>ReadWriteDocument</Permissions>

  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="Document">
        <DesktopFormFactor>
          <GetStarted>
            <Title resid="GetStarted.Title"/>
            <Description resid="GetStarted.Description"/>
            <LearnMoreUrl resid="GetStarted.LearnMoreUrl"/>
          </GetStarted>
          <FunctionFile resid="Commands.Url"/>
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="CommandsGroup">
                <Label resid="CommandsGroup.Label"/>
                <Icon>
                  <bt:Image size="16" resid="Icon.16x16"/>
                  <bt:Image size="32" resid="Icon.32x32"/>
                  <bt:Image size="80" resid="Icon.80x80"/>
                </Icon>
                <Control xsi:type="Button" id="TaskpaneButton">
                  <Label resid="TaskpaneButton.Label"/>
                  <Supertip>
                    <Title resid="TaskpaneButton.Label"/>
                    <Description resid="TaskpaneButton.Tooltip"/>
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Icon.16x16"/>
                    <bt:Image size="32" resid="Icon.32x32"/>
                    <bt:Image size="80" resid="Icon.80x80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>ButtonId1</TaskpaneId>
                    <SourceLocation resid="Taskpane.Url"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>

    <Resources>
      <bt:Images>
        <bt:Image id="Icon.16x16" DefaultValue="{base_url}/static/logo/favicon-16x16.png"/>
        <bt:Image id="Icon.32x32" DefaultValue="{base_url}/static/logo/favicon-32x32.png"/>
        <bt:Image id="Icon.80x80" DefaultValue="{base_url}/static/logo/apple-touch-icon.png"/>
      </bt:Images>
      <bt:Urls>
        <bt:Url id="GetStarted.LearnMoreUrl" DefaultValue="https://tarcite.com/"/>
        <bt:Url id="Commands.Url" DefaultValue="{base_url}/word-addin/commands.html"/>
        <bt:Url id="Taskpane.Url" DefaultValue="{base_url}/word-addin/taskpane.html"/>
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="GetStarted.Title" DefaultValue="Welcome to TarCite Workspace!"/>
        <bt:String id="CommandsGroup.Label" DefaultValue="TarCite Workspace"/>
        <bt:String id="TaskpaneButton.Label" DefaultValue="TarCite Workspace"/>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="GetStarted.Description" DefaultValue="Insert and manage citations from your local library. Click the TarCite Workspace button to get started."/>
        <bt:String id="TaskpaneButton.Tooltip" DefaultValue="Open TarCite Workspace to insert and manage citations"/>
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>"""


def _get_macos_wef_folders() -> List[Path]:
    home = Path.home()
    paths = [
        home / "Library" / "Containers" / "com.microsoft.Word" / "Data" / "Documents" / "wef",
    ]
    for p in paths:
        if not p.exists():
            p.mkdir(parents=True, exist_ok=True)
    return paths


def _get_windows_catalog_path() -> str:
    return r"HKEY_CURRENT_USER\Software\Microsoft\Office\16.0\Wef\Developer"


def detect_platform() -> str:
    sys = platform.system()
    if sys == "Darwin":
        return "macos"
    if sys == "Windows":
        return "windows"
    return "unknown"


def _detect_word_windows() -> bool:
    """Try every known detection method for Word on Windows in priority order."""

    # 1. Click-to-Run: Office 365 / 2019 / 2021 installed via modern installer
    try:
        result = _run_connector_command(
            ["reg", "query",
             r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Office\ClickToRun\Configuration",
             "/v", "ProductReleaseIds"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and "word" in result.stdout.lower():
            return True
    except Exception:
        pass

    # 2. MSI / volume-license: 64-bit Office on 64-bit Windows
    try:
        result = _run_connector_command(
            ["reg", "query",
             r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Office\16.0\Word\InstallRoot",
             "/v", "Path"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return True
    except Exception:
        pass

    # 3. MSI / volume-license: 32-bit Office on 64-bit Windows (WOW6432Node redirect)
    try:
        result = _run_connector_command(
            ["reg", "query",
             r"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Office\16.0\Word\InstallRoot",
             "/v", "Path"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return True
    except Exception:
        pass

    # 4. Microsoft Store (AppX) Office — requires PowerShell, no admin needed
    try:
        result = _run_connector_command(
            ["powershell", "-NoProfile", "-Command",
             "Get-AppxPackage -Name 'Microsoft.Office.Desktop*' | "
             "Select-Object -First 1 -ExpandProperty PackageFullName"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            return True
    except Exception:
        pass

    # 5. Filesystem fallback: check known WINWORD.EXE locations for Office 16 (2016/2019/2021/365)
    prog_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    prog_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    winword_candidates = [
        Path(prog_files) / "Microsoft Office" / "root" / "Office16" / "WINWORD.EXE",
        Path(prog_files_x86) / "Microsoft Office" / "root" / "Office16" / "WINWORD.EXE",
        Path(prog_files) / "Microsoft Office" / "Office16" / "WINWORD.EXE",
        Path(prog_files_x86) / "Microsoft Office" / "Office16" / "WINWORD.EXE",
    ]
    for candidate in winword_candidates:
        if candidate.exists():
            return True

    return False


def detect_word_installed() -> bool:
    sys = detect_platform()
    if sys == "macos":
        word_app = Path("/Applications/Microsoft Word.app")
        return word_app.exists()
    if sys == "windows":
        return _detect_word_windows()
    return False


def check_manifest_installed() -> bool:
    sys = detect_platform()
    if sys == "macos":
        for wef in _get_macos_wef_folders():
            if (wef / MANIFEST_FILENAME).exists():
                return True
        return False
    if sys == "windows":
        try:
            result = _run_connector_command(
                ["reg", "query", _get_windows_catalog_path(), "/v", ADDIN_ID],
                capture_output=True, text=True, timeout=5,
            )
            return result.returncode == 0
        except Exception:
            return False
    return False


def _get_installed_manifest_paths() -> List[Path]:
    sys = detect_platform()
    if sys == "macos":
        return [
            wef / MANIFEST_FILENAME
            for wef in _get_macos_wef_folders()
            if (wef / MANIFEST_FILENAME).exists()
        ]
    if sys == "windows":
        wef_dir = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Office" / "wef"
        manifest_path = wef_dir / MANIFEST_FILENAME
        return [manifest_path] if manifest_path.exists() else []
    return []


def _get_installed_manifest_url() -> str:
    for manifest_path in _get_installed_manifest_paths():
        try:
            xml = manifest_path.read_text(encoding="utf-8")
        except OSError:
            continue
        match = re.search(r'<SourceLocation\s+DefaultValue="([^"]+)"', xml)
        if match:
            return match.group(1)
    return ""


def _is_tcp_reachable(host: str, port: int, timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except Exception:
        return False


def _is_url_tcp_reachable(url: str) -> bool:
    parsed = urlparse(url)
    if not parsed.hostname:
        return False
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return _is_tcp_reachable(parsed.hostname, port)


def _certificate_covers_local_hosts(cert_path: Path) -> bool:
    try:
        from cryptography import x509
        from cryptography.x509.oid import ExtensionOID

        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        san = cert.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME).value
        dns_names = set(san.get_values_for_type(x509.DNSName))
        ip_addresses = {str(ip) for ip in san.get_values_for_type(x509.IPAddress)}
        return (
            "localhost" in dns_names
            and "tarcite.workspace" in dns_names
            and "127.0.0.1" in ip_addresses
        )
    except Exception:
        return False


def _ensure_local_https_certificate() -> Dict[str, Any]:
    cert_path, key_path = _local_cert_paths()
    if cert_path.exists() and key_path.exists() and _certificate_covers_local_hosts(cert_path):
        return {"status": "ok", "created": False, "cert_path": str(cert_path)}

    try:
        import datetime as _dt
        import ipaddress
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, LOCAL_CERT_NAME),
        ])
        now = _dt.datetime.now(_dt.timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - _dt.timedelta(days=1))
            .not_valid_after(now + _dt.timedelta(days=825))
            .add_extension(
                x509.SubjectAlternativeName([
                    x509.DNSName("localhost"),
                    x509.DNSName("tarcite.workspace"),
                    x509.DNSName("citation.workingspace"),
                    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                ]),
                critical=False,
            )
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(
                x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
                critical=False,
            )
            .add_extension(
                x509.KeyUsage(
                    digital_signature=True,
                    key_encipherment=True,
                    content_commitment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=True,
                    crl_sign=True,
                    encipher_only=None,
                    decipher_only=None,
                ),
                critical=True,
            )
            .sign(key, hashes.SHA256())
        )

        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL,
                serialization.NoEncryption(),
            )
        )
        return {"status": "ok", "created": True, "cert_path": str(cert_path)}
    except Exception as exc:
        logger.error("Could not create local HTTPS certificate: %s", exc)
        return {"status": "error", "message": f"Could not create local HTTPS certificate: {exc}"}


def _trust_windows_certificate(cert_path: Path) -> Dict[str, Any]:
    if check_certificate_trusted():
        return {"status": "ok", "changed": False}

    commands = [
        ["certutil", "-user", "-addstore", "-f", "Root", str(cert_path)],
        [
            "powershell",
            "-NoProfile",
            "-Command",
            f"Import-Certificate -FilePath '{str(cert_path)}' -CertStoreLocation Cert:\\CurrentUser\\Root",
        ],
    ]
    errors = []
    for command in commands:
        try:
            result = _run_connector_command(command, capture_output=True, text=True, timeout=20)
            if result.returncode == 0 and check_certificate_trusted():
                return {"status": "ok", "changed": True}
            errors.append((result.stderr or result.stdout or "").strip())
        except Exception as exc:
            errors.append(str(exc))

    return {
        "status": "error",
        "message": "Could not trust the local HTTPS certificate in the Windows Current User Root store.",
        "details": "; ".join(e for e in errors if e),
    }


def _ensure_windows_connector_prerequisites() -> Dict[str, Any]:
    from app.config import config

    cert_path, _ = _local_cert_paths()
    cert_result = _ensure_local_https_certificate()
    if cert_result.get("status") != "ok":
        return cert_result

    trust_result = _trust_windows_certificate(cert_path)
    if trust_result.get("status") != "ok":
        return trust_result

    config.reload()
    return {
        "status": "ok",
        "certificate_created": bool(cert_result.get("created")),
        "certificate_trusted": check_certificate_trusted(),
        "restart_required": bool(cert_result.get("created")),
    }


def check_certificate_trusted() -> bool:
    sys = detect_platform()
    cert_names = [LOCAL_CERT_NAME, LEGACY_LOCAL_CERT_NAME]
    if sys == "macos":
        for cert_name in cert_names:
            try:
                result = _run_connector_command(
                    ["security", "find-certificate", "-c", cert_name, "-p"],
                    capture_output=True, text=True, timeout=5,
                )
                if result.returncode == 0:
                    return True
            except Exception:
                continue
        return False
    if sys == "windows":
        for cert_name in cert_names:
            for command in (
                ["certutil", "-user", "-store", "Root", cert_name],
                ["certutil", "-store", "Root", cert_name],
            ):
                try:
                    result = _run_connector_command(command, capture_output=True, text=True, timeout=5)
                    if result.returncode == 0:
                        return True
                except Exception:
                    continue
        return False
    return False


def check_local_server_running(
    host: str = "127.0.0.1",
    port: int = 4443,
    display_host: str = "tarcite.workspace",
    external_port: int = 443,
) -> bool:
    """Check whether the TarCite server is reachable.

    The desktop app listens on the internal port, while Word normally reaches it
    through the public local hostname on 443. Probe both routes so the UI does
    not report "not running" when only the Word-facing route is active.
    """
    import socket
    targets = {
        (host, port),
        (host, 4443),
        (host, external_port),
        ("127.0.0.1", port),
        ("127.0.0.1", 4443),
        ("127.0.0.1", external_port),
        (display_host, external_port),
        (display_host, 443),
    }
    for target_host, target_port in targets:
        try:
            if _is_tcp_reachable(target_host, int(target_port)):
                return True
        except Exception:
            pass
    return False


def get_connector_status(
    host: str = "127.0.0.1",
    port: int = 443,
    display_host: str = "tarcite.workspace",
    external_port: int = 443,
) -> Dict[str, Any]:
    manifest_url = _get_installed_manifest_url()
    word_url = manifest_url or _get_word_base_url()
    word_url_reachable = _is_url_tcp_reachable(word_url)
    return {
        "platform": detect_platform(),
        "status": "installed" if check_manifest_installed() else "not_installed",
        "local_server": "running" if check_local_server_running(host, port, display_host, external_port) else "not_running",
        "word_url": word_url,
        "word_url_reachable": "reachable" if word_url_reachable else "not_reachable",
        "manifest": "installed" if check_manifest_installed() else "not_installed",
        "manifest_url": manifest_url,
        "certificate": "trusted" if check_certificate_trusted() else "not_trusted",
        "word": "detected" if detect_word_installed() else "not_detected",
    }


def install_connector(host: str = "127.0.0.1", port: int = 443) -> Dict[str, Any]:
    sys = detect_platform()

    if sys == "macos":
        manifest_xml = _generate_manifest_xml()
        return _install_macos(manifest_xml)
    if sys == "windows":
        prereq = _ensure_windows_connector_prerequisites()
        if prereq.get("status") != "ok":
            return prereq
        manifest_xml = _generate_manifest_xml()
        result = _install_windows(manifest_xml)
        if result.get("status") == "success":
            result["certificate"] = "trusted" if check_certificate_trusted() else "not_trusted"
            if prereq.get("restart_required"):
                result["message"] += " Restart TarCite Workspace, then restart Word, so the app can serve the connector over HTTPS."
        return result

    return {"status": "error", "message": f"Unsupported platform: {sys}"}


def _install_macos(manifest_xml: str) -> Dict[str, Any]:
    try:
        installed_paths = []
        for wef in _get_macos_wef_folders():
            manifest_path = wef / MANIFEST_FILENAME
            manifest_path.write_text(manifest_xml, encoding="utf-8")
            installed_paths.append(str(manifest_path))
            logger.info("Manifest installed to %s", manifest_path)
        return {
            "status": "success",
            "message": "Word connector manifest installed successfully.",
            "manifest_paths": installed_paths,
        }
    except Exception as exc:
        logger.error("macOS manifest install error: %s", exc)
        return {"status": "error", "message": f"Failed to install manifest: {exc}"}


def _install_windows(manifest_xml: str) -> Dict[str, Any]:
    try:
        wef_dir = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Office" / "wef"
        if not wef_dir.exists():
            wef_dir.mkdir(parents=True, exist_ok=True)

        manifest_path = wef_dir / MANIFEST_FILENAME
        manifest_path.write_text(manifest_xml, encoding="utf-8")

        try:
            _run_connector_command(
                ["reg", "add", _get_windows_catalog_path(), "/v", ADDIN_ID, "/t", "REG_SZ", "/d", str(manifest_path), "/f"],
                capture_output=True, timeout=10,
            )
        except Exception as reg_exc:
            logger.warning("Registry add failed (may need admin): %s", reg_exc)

        return {
            "status": "success",
            "message": "Word connector manifest installed. You may need to restart Word.",
            "manifest_path": str(manifest_path),
        }
    except Exception as exc:
        logger.error("Windows manifest install error: %s", exc)
        return {"status": "error", "message": f"Failed to install manifest: {exc}"}


def uninstall_connector() -> Dict[str, Any]:
    sys = detect_platform()

    if sys == "macos":
        return _uninstall_macos()
    if sys == "windows":
        return _uninstall_windows()

    return {"status": "error", "message": f"Unsupported platform: {sys}"}


def _uninstall_macos() -> Dict[str, Any]:
    try:
        for wef in _get_macos_wef_folders():
            manifest_path = wef / MANIFEST_FILENAME
            if manifest_path.exists():
                manifest_path.unlink()
                logger.info("Manifest removed from %s", manifest_path)
        return {"status": "success", "message": "Word connector uninstalled successfully."}
    except Exception as exc:
        logger.error("macOS uninstall error: %s", exc)
        return {"status": "error", "message": f"Failed to uninstall: {exc}"}


def _uninstall_windows() -> Dict[str, Any]:
    try:
        wef_dir = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Office" / "wef"
        manifest_path = wef_dir / MANIFEST_FILENAME
        if manifest_path.exists():
            manifest_path.unlink()

        try:
            _run_connector_command(
                ["reg", "delete", _get_windows_catalog_path(), "/v", ADDIN_ID, "/f"],
                capture_output=True, timeout=10,
            )
        except Exception:
            pass

        return {"status": "success", "message": "Word connector uninstalled successfully."}
    except Exception as exc:
        logger.error("Windows uninstall error: %s", exc)
        return {"status": "error", "message": f"Failed to uninstall: {exc}"}


def repair_connector(host: str = "127.0.0.1", port: int = 443) -> Dict[str, Any]:
    uninstall_result = uninstall_connector()
    if uninstall_result["status"] != "success":
        return uninstall_result
    return install_connector(host, port)


def open_word() -> Dict[str, Any]:
    sys = detect_platform()
    if sys == "macos":
        try:
            _run_connector_command(["open", "-a", "Microsoft Word"], timeout=10)
            return {"status": "success", "message": "Opening Microsoft Word..."}
        except Exception as exc:
            return {"status": "error", "message": f"Could not open Word: {exc}"}
    if sys == "windows":
        try:
            _run_connector_command(["start", "winword"], shell=True, timeout=10)
            return {"status": "success", "message": "Opening Microsoft Word..."}
        except Exception as exc:
            return {"status": "error", "message": f"Could not open Word: {exc}"}
    return {"status": "error", "message": f"Unsupported platform: {sys}"}
