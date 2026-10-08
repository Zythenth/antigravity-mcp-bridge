#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <string>
#include <vector>

#pragma comment(lib, "advapi32.lib")

struct Snapshot {
  BOOL ok;
  DWORD error;
  DWORD characters;
  std::vector<wchar_t> data;
};

static Snapshot query_dos_device(const wchar_t* name) {
  Snapshot snapshot = { FALSE, ERROR_SUCCESS, 0, std::vector<wchar_t>(256) };
  for (;;) {
    SetLastError(ERROR_SUCCESS);
    snapshot.characters = QueryDosDeviceW(name, snapshot.data.data(), static_cast<DWORD>(snapshot.data.size()));
    if (snapshot.characters != 0) {
      snapshot.ok = TRUE;
      snapshot.error = ERROR_SUCCESS;
      return snapshot;
    }
    snapshot.error = GetLastError();
    if (snapshot.error != ERROR_INSUFFICIENT_BUFFER || snapshot.data.size() >= 1024 * 1024) return snapshot;
    snapshot.data.resize(snapshot.data.size() * 2);
  }
}

static bool write_all(HANDLE file, const void* data, DWORD size) {
  const unsigned char* cursor = static_cast<const unsigned char*>(data);
  while (size != 0) {
    DWORD written = 0;
    if (!WriteFile(file, cursor, size, &written, 0) || written == 0) return false;
    cursor += written;
    size -= written;
  }
  return true;
}

static bool write_snapshot(const wchar_t* file_name, const Snapshot& snapshot) {
  HANDLE file = CreateFileW(file_name, GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
  if (file == INVALID_HANDLE_VALUE) return false;
  const DWORD header[] = { 0x44534E50, snapshot.ok ? 1u : 0u, snapshot.error, snapshot.characters };
  const DWORD payload = snapshot.characters * static_cast<DWORD>(sizeof(wchar_t));
  const bool written = write_all(file, header, sizeof(header)) &&
    (payload == 0 || write_all(file, snapshot.data.data(), payload));
  const DWORD error = written ? ERROR_SUCCESS : GetLastError();
  CloseHandle(file);
  SetLastError(error);
  return written;
}

static bool write_marker(const wchar_t* file_name, const char* contents) {
  HANDLE file = CreateFileW(file_name, GENERIC_WRITE, 0, 0, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, 0);
  if (file == INVALID_HANDLE_VALUE) return false;
  const DWORD size = static_cast<DWORD>(strlen(contents));
  const bool written = write_all(file, contents, size);
  const DWORD error = written ? ERROR_SUCCESS : GetLastError();
  CloseHandle(file);
  SetLastError(error);
  return written;
}

static bool wait_for_file(const wchar_t* file_name, DWORD timeout_ms) {
  const ULONGLONG deadline = GetTickCount64() + timeout_ms;
  do {
    if (GetFileAttributesW(file_name) != INVALID_FILE_ATTRIBUTES) return true;
    const DWORD error = GetLastError();
    if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) return false;
    Sleep(25);
  } while (GetTickCount64() < deadline);
  SetLastError(ERROR_TIMEOUT);
  return false;
}

static bool read_utf16_file(const wchar_t* file_name, std::wstring* contents) {
  HANDLE file = CreateFileW(file_name, GENERIC_READ, FILE_SHARE_READ, 0, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, 0);
  if (file == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size = {};
  if (!GetFileSizeEx(file, &size) || size.QuadPart < 0 || size.QuadPart > 32768 || (size.QuadPart % sizeof(wchar_t)) != 0) {
    const DWORD error = GetLastError() ? GetLastError() : ERROR_BAD_LENGTH;
    CloseHandle(file);
    SetLastError(error);
    return false;
  }
  std::vector<wchar_t> data(static_cast<size_t>(size.QuadPart / sizeof(wchar_t)));
  DWORD read = 0;
  const bool complete = data.empty() || (ReadFile(file, data.data(), static_cast<DWORD>(size.QuadPart), &read, 0) && read == static_cast<DWORD>(size.QuadPart));
  const DWORD error = complete ? ERROR_SUCCESS : GetLastError();
  CloseHandle(file);
  if (!complete) {
    SetLastError(error);
    return false;
  }
  contents->assign(data.begin(), data.end());
  return true;
}

static bool plan_value(const std::wstring& plan, const wchar_t* key, std::wstring* value) {
  const std::wstring prefix = std::wstring(key) + L"=";
  size_t start = 0;
  while (start < plan.size()) {
    const size_t end = plan.find(L'\n', start);
    const std::wstring line = plan.substr(start, end == std::wstring::npos ? std::wstring::npos : end - start);
    if (line.compare(0, prefix.size(), prefix) == 0) {
      *value = line.substr(prefix.size());
      return !value->empty();
    }
    if (end == std::wstring::npos) break;
    start = end + 1;
  }
  return false;
}

static bool token_flag(TOKEN_INFORMATION_CLASS information_class, BOOL* value) {
  HANDLE token = 0;
  DWORD returned = 0;
  const bool known = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) &&
    GetTokenInformation(token, information_class, value, sizeof(*value), &returned) && returned == sizeof(*value);
  if (token) CloseHandle(token);
  return known;
}

static void print_token_state() {
  BOOL app_container = FALSE, lpac = FALSE;
  const bool app_container_known = token_flag(TokenIsAppContainer, &app_container);
  const bool lpac_known = token_flag(TokenIsLessPrivilegedAppContainer, &lpac);
  wprintf(L"token app-container=%d known=%d lpac=%d known=%d\n", app_container, app_container_known, lpac, lpac_known);
}

static void print_query(const wchar_t* id, const wchar_t* name) {
  const Snapshot snapshot = query_dos_device(name);
  wprintf(L"query id=%s name=%s result=%d error=%lu chars=%lu\n", id, name ? name : L"@", snapshot.ok, snapshot.error, snapshot.characters);
}

static void attempt_mutation(const wchar_t* id, const wchar_t* name, const wchar_t* target, DWORD flags) {
  SetLastError(ERROR_SUCCESS);
  const BOOL changed = DefineDosDeviceW(flags, name, target);
  const DWORD error = changed ? ERROR_SUCCESS : GetLastError();
  wprintf(L"mutate id=%s name=%s result=%d error=%lu\n", id, name, changed, error);
  const std::wstring query_id = std::wstring(L"after-") + id;
  print_query(query_id.c_str(), name);
}

static int run_host_snapshot(const wchar_t* output, const wchar_t* name) {
  const Snapshot snapshot = query_dos_device(wcscmp(name, L"@") == 0 ? 0 : name);
  const bool written = write_snapshot(output, snapshot);
  const DWORD error = written ? ERROR_SUCCESS : GetLastError();
  wprintf(L"host-snapshot result=%d error=%lu chars=%lu\n", written, error, snapshot.characters);
  return written ? 0 : 40;
}

static DWORD host_flags(const wchar_t* operation, const wchar_t** target) {
  const DWORD base = DDD_RAW_TARGET_PATH | DDD_NO_BROADCAST_SYSTEM;
  if (wcscmp(operation, L"create") == 0 || wcscmp(operation, L"redefine") == 0) return base;
  if (wcscmp(operation, L"remove-exact") == 0) return base | DDD_REMOVE_DEFINITION | DDD_EXACT_MATCH_ON_REMOVE;
  if (wcscmp(operation, L"remove-prefix") == 0 || wcscmp(operation, L"remove-nonexact") == 0) return base | DDD_REMOVE_DEFINITION;
  if (wcscmp(operation, L"remove-null") == 0) { *target = 0; return base | DDD_REMOVE_DEFINITION; }
  return 0;
}

static int run_host_mutation(const wchar_t* operation, const wchar_t* name, const wchar_t* target) {
  const wchar_t* effective_target = wcscmp(target, L"@") == 0 ? 0 : target;
  const DWORD flags = host_flags(operation, &effective_target);
  if (!flags) return 2;
  SetLastError(ERROR_SUCCESS);
  const BOOL changed = DefineDosDeviceW(flags, name, effective_target);
  const DWORD error = changed ? ERROR_SUCCESS : GetLastError();
  wprintf(L"host-mutate operation=%s name=%s result=%d error=%lu\n", operation, name, changed, error);
  return 0;
}

static int run_low_token(const wchar_t* ready, const wchar_t* release, const wchar_t* complete, const wchar_t* finish, const wchar_t* plan_file) {
  print_token_state();
  if (!write_marker(ready, "ready")) {
    wprintf(L"ready result=0 error=%lu\n", GetLastError());
    return 70;
  }
  if (!wait_for_file(release, 15000)) {
    wprintf(L"release result=0 error=%lu\n", GetLastError());
    return 71;
  }
  std::wstring plan, custom_name, custom_target, drive_name, drive_target, fresh_custom_name, fresh_custom_target, fresh_drive_name, fresh_drive_target;
  if (!read_utf16_file(plan_file, &plan) ||
      !plan_value(plan, L"custom-name", &custom_name) || !plan_value(plan, L"custom-target", &custom_target) ||
      !plan_value(plan, L"drive-name", &drive_name) || !plan_value(plan, L"drive-target", &drive_target) ||
      !plan_value(plan, L"fresh-custom-name", &fresh_custom_name) || !plan_value(plan, L"fresh-custom-target", &fresh_custom_target) ||
      !plan_value(plan, L"fresh-drive-name", &fresh_drive_name) || !plan_value(plan, L"fresh-drive-target", &fresh_drive_target) ||
      custom_target.size() < 2 || drive_target.size() < 2) {
    wprintf(L"plan result=0 error=%lu\n", GetLastError());
    return 72;
  }

  const DWORD define = DDD_RAW_TARGET_PATH | DDD_NO_BROADCAST_SYSTEM;
  const DWORD remove = define | DDD_REMOVE_DEFINITION;
  const DWORD exact_remove = remove | DDD_EXACT_MATCH_ON_REMOVE;
  print_query(L"full-before", 0);
  print_query(L"custom-before", custom_name.c_str());
  print_query(L"drive-before", drive_name.c_str());
  attempt_mutation(L"custom-redefine", custom_name.c_str(), custom_target.c_str(), define);
  attempt_mutation(L"custom-remove-exact", custom_name.c_str(), custom_target.c_str(), exact_remove);
  attempt_mutation(L"custom-remove-prefix", custom_name.c_str(), custom_target.substr(0, custom_target.size() - 1).c_str(), remove);
  attempt_mutation(L"custom-remove-null", custom_name.c_str(), 0, remove);
  attempt_mutation(L"custom-remove-nonexact", custom_name.c_str(), custom_target.c_str(), remove);
  attempt_mutation(L"drive-redefine", drive_name.c_str(), drive_target.c_str(), define);
  attempt_mutation(L"drive-remove-exact", drive_name.c_str(), drive_target.c_str(), exact_remove);
  attempt_mutation(L"drive-remove-prefix", drive_name.c_str(), drive_target.substr(0, drive_target.size() - 1).c_str(), remove);
  attempt_mutation(L"drive-remove-null", drive_name.c_str(), 0, remove);
  attempt_mutation(L"drive-remove-nonexact", drive_name.c_str(), drive_target.c_str(), remove);
  attempt_mutation(L"fresh-custom-create", fresh_custom_name.c_str(), fresh_custom_target.c_str(), define);
  attempt_mutation(L"fresh-drive-create", fresh_drive_name.c_str(), fresh_drive_target.c_str(), define);
  print_query(L"full-after", 0);
  print_query(L"custom-after", custom_name.c_str());
  print_query(L"drive-after", drive_name.c_str());
  if (!write_marker(complete, "complete")) {
    wprintf(L"complete result=0 error=%lu\n", GetLastError());
    return 73;
  }
  if (!wait_for_file(finish, 15000)) {
    wprintf(L"finish result=0 error=%lu\n", GetLastError());
    return 74;
  }
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  if (argc == 4 && wcscmp(argv[1], L"--host-snapshot") == 0) return run_host_snapshot(argv[2], argv[3]);
  if (argc == 5 && wcscmp(argv[1], L"--host-mutate") == 0) return run_host_mutation(argv[2], argv[3], argv[4]);
  if (argc == 7 && wcscmp(argv[1], L"--low") == 0) return run_low_token(argv[2], argv[3], argv[4], argv[5], argv[6]);
  return 2;
}
