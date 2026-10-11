export const WINDOWS_PATHEXT_FALLBACK = '.COM;.EXE;.BAT;.CMD';

export const DEFAULT_ALLOWED_ENV_VAR_RATIONALES: Readonly<Record<string, string>> = {
  // System and Executable Resolution
  PATH: 'System executable search path required by the OS and child processes',
  PATHEXT: 'Windows executable file extensions list for executable resolution',
  SystemRoot: 'Windows system directory (e.g. C:\\Windows); required for core OS binaries and DLL resolution',
  SystemDrive: 'Windows system drive root (e.g. C:); required by Windows subsystem tools',
  ComSpec: 'Windows command processor executable path (cmd.exe)',
  WINDIR: 'Windows directory path; required by legacy Windows binaries and tools',
  SHELL: 'User default shell executable path on Unix systems',
  TERM: 'Terminal emulation capability descriptor',
  COLORTERM: 'Terminal truecolor and color capability indicator',

  // User Home and Profile Directories
  HOME: 'User home directory on Unix/macOS; required for user configurations and keyring storage',
  USERPROFILE: 'User profile directory on Windows; required for user configuration and credentials',
  APPDATA: 'Windows roaming application data directory; required for Antigravity and tool configs',
  LOCALAPPDATA: 'Windows local application data directory; required for local caches and data stores',
  HOMEDRIVE: 'Windows home directory drive letter',
  HOMEPATH: 'Windows home directory path component',
  USER: 'Current logged-in user name on Unix systems',
  LOGNAME: 'Current login name on Unix systems',
  USERNAME: 'Current user name on Windows systems',

  // Temporary Directories
  TEMP: 'Standard temporary directory path (Windows and Unix)',
  TMP: 'Standard temporary directory path fallback (Windows and Unix)',
  TMPDIR: 'Standard temporary directory path on POSIX/Unix systems',

  // Locale, Language, and Timezone
  LANG: 'Primary system locale setting for character encoding and language',
  LC_ALL: 'POSIX locale override setting',
  LC_CTYPE: 'POSIX character classification and encoding setting',
  LC_MESSAGES: 'POSIX system messages language setting',
  TZ: 'System timezone configuration',

  // XDG Base Directories & Session / Native Keyring Auth
  XDG_CONFIG_HOME: 'XDG user-specific configuration directory',
  XDG_DATA_HOME: 'XDG user-specific data directory',
  XDG_CACHE_HOME: 'XDG user-specific non-essential cache directory',
  XDG_RUNTIME_DIR: 'XDG user runtime directory; required for runtime sockets including D-Bus',
  XDG_DATA_DIRS: 'XDG system-wide data directories preference search list',
  XDG_CONFIG_DIRS: 'XDG system-wide configuration directories preference search list',
  DBUS_SESSION_BUS_ADDRESS: 'D-Bus session bus address; required for Linux Secret Service, GNOME Keyring, and KWallet',
  GNOME_KEYRING_CONTROL: 'GNOME Keyring daemon socket control directory',
  GNOME_KEYRING_PID: 'GNOME Keyring daemon process ID',
  SECURITYSESSIONID: 'macOS security session identifier required for Keychain access in GUI/terminal sessions',

  // Remote SSH session context (non-credential environment detection)
  SSH_CONNECTION: 'Remote SSH connection client/server address and port context',
  SSH_CLIENT: 'Remote SSH client address and port context',
  SSH_TTY: 'Remote SSH terminal device path context',

  // Network and Proxy Settings
  HTTP_PROXY: 'HTTP proxy server URL for outbound network requests',
  HTTPS_PROXY: 'HTTPS proxy server URL for secure outbound network requests',
  ALL_PROXY: 'General proxy server URL for all outbound traffic',
  NO_PROXY: 'Comma-separated list of hostnames or domains exempt from proxying',
  http_proxy: 'Lowercase HTTP proxy server URL for standard Unix tools',
  https_proxy: 'Lowercase HTTPS proxy server URL for standard Unix tools',
  all_proxy: 'Lowercase general proxy server URL for standard Unix tools',
  no_proxy: 'Lowercase proxy bypass host list for standard Unix tools',

  // SSL/TLS Certificates (Enterprise and Custom Roots)
  SSL_CERT_FILE: 'Path to custom or enterprise CA certificate bundle file (OpenSSL, Python)',
  SSL_CERT_DIR: 'Path to directory containing trusted CA certificates (OpenSSL)',
  REQUESTS_CA_BUNDLE: 'Path to custom CA bundle file for Python requests library',
  CURL_CA_BUNDLE: 'Path to custom CA bundle file for curl',
  NODE_EXTRA_CA_CERTS: 'Path to additional root CA certificates bundle for Node.js runtimes',

  // Official Google / Gemini Auth & Custom Endpoints
  GEMINI_API_KEY: 'Official Gemini API key authentication for Antigravity CLI when modelProvider is gemini',
  GOOGLE_GEMINI_BASE_URL: 'Official custom endpoint base URL for Gemini API requests',
  GOOGLE_APPLICATION_CREDENTIALS: 'Path to Google Application Default Credentials (ADC) service account key JSON file',
  GOOGLE_CLOUD_PROJECT: 'Google Cloud project ID for ADC enterprise resource quota, billing, and project context',
  GCLOUD_PROJECT: 'Common Google Cloud project ID fallback for gcloud SDK and ADC client libraries',
  GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'Google Cloud Universe / Sovereign Cloud domain for enterprise deployments',

  // Windows OS, Architecture, and Enterprise Domain Context
  OS: 'Windows operating system family identifier (e.g. Windows_NT)',
  PROCESSOR_ARCHITECTURE: 'Windows CPU architecture identifier (e.g. AMD64, ARM64)',
  PROCESSOR_ARCHITEW6432: 'Windows architecture of the native processor for 32-bit processes on 64-bit Windows',
  NUMBER_OF_PROCESSORS: 'Windows logical processor count for parallel execution',
  ProgramData: 'Windows system-wide shared application data directory',
  ProgramFiles: 'Windows 64-bit Program Files directory',
  'ProgramFiles(x86)': 'Windows 32-bit Program Files directory',
  CommonProgramFiles: 'Windows common files directory',
  'CommonProgramFiles(x86)': 'Windows 32-bit common files directory',
  USERDOMAIN: 'Windows domain or workstation name of the current user account',
  USERDNSDOMAIN: 'Windows Active Directory fully-qualified DNS domain name for enterprise authentication',
  COMPUTERNAME: 'Windows computer NetBIOS hostname',
};

export const DEFAULT_ALLOWED_ENV_VARS: readonly string[] = Object.freeze(
  Object.keys(DEFAULT_ALLOWED_ENV_VAR_RATIONALES)
);

export function cliEnvironment(
  allowedEnvVars: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const isWindows = platform === 'win32';

  if (isWindows) {
    const allowedUpper = new Set<string>();
    for (const name of DEFAULT_ALLOWED_ENV_VARS) {
      allowedUpper.add(name.toUpperCase());
    }
    for (const name of allowedEnvVars) {
      const trimmed = name.trim();
      if (trimmed) {
        allowedUpper.add(trimmed.toUpperCase());
      }
    }

    const seenUpper = new Set<string>();
    for (const [key, value] of Object.entries(source)) {
      if (key === '__proto__' || typeof value !== 'string') continue;
      const upperKey = key.toUpperCase();
      if (!allowedUpper.has(upperKey)) continue;
      if (seenUpper.has(upperKey)) continue;
      seenUpper.add(upperKey);
      result[key] = value;
    }

    if (!seenUpper.has('PATHEXT')) {
      result.PATHEXT = WINDOWS_PATHEXT_FALLBACK;
    }
  } else {
    const allowedExact = new Set<string>();
    for (const name of DEFAULT_ALLOWED_ENV_VARS) {
      allowedExact.add(name);
    }
    for (const name of allowedEnvVars) {
      const trimmed = name.trim();
      if (trimmed) {
        allowedExact.add(trimmed);
      }
    }

    for (const [key, value] of Object.entries(source)) {
      if (key === '__proto__' || typeof value !== 'string') continue;
      if (!allowedExact.has(key)) continue;
      result[key] = value;
    }
  }

  return result;
}
