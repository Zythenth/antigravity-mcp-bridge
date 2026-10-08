#define _WIN32_DCOM
#include <windows.h>
#include <wbemidl.h>
#include <shellapi.h>
#include <oleauto.h>
#include <stdio.h>
#include <string>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "wbemuuid.lib")

static std::wstring quote(const std::wstring& value) { return L"\"" + value + L"\""; }

static void print_hresult(const wchar_t* operation, HRESULT value) {
  wprintf(L"%s hresult=0x%08lX\n", operation, static_cast<unsigned long>(value));
}

static bool is_owned_fixture_process(HANDLE process, const std::wstring& self) {
  wchar_t image[32768];
  DWORD length = static_cast<DWORD>(sizeof(image) / sizeof(image[0]));
  return QueryFullProcessImageNameW(process, 0, image, &length) && _wcsicmp(image, self.c_str()) == 0;
}

static void wait_for_owned_fixture(HANDLE process, const std::wstring& self, const wchar_t* operation, DWORD timeout) {
  const bool owned = is_owned_fixture_process(process, self);
  wprintf(L"%s-owned=%d\n", operation, owned);
  const DWORD result = WaitForSingleObject(process, timeout);
  wprintf(L"%s-wait=%lu\n", operation, result);
  if (result == WAIT_TIMEOUT && owned) {
    const BOOL terminated = TerminateProcess(process, 124);
    wprintf(L"%s-timeout-terminated=%d error=%lu\n", operation, terminated, GetLastError());
  }
}

static bool token_flag(TOKEN_INFORMATION_CLASS kind, BOOL* value) {
  HANDLE token = 0;
  DWORD returned = 0;
  const bool present = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) &&
    GetTokenInformation(token, kind, value, sizeof(*value), &returned) && returned == sizeof(*value);
  if (token) CloseHandle(token);
  return present;
}

static int write_broker_child_markers(const wchar_t* inside_path, const wchar_t* outside_path) {
  BOOL app_container = FALSE, lpac = FALSE, in_job = FALSE;
  const bool app_container_known = token_flag(TokenIsAppContainer, &app_container);
  const bool lpac_known = token_flag(TokenIsLessPrivilegedAppContainer, &lpac);
  const bool in_job_known = IsProcessInJob(GetCurrentProcess(), 0, &in_job) != FALSE;
  HANDLE inside = CreateFileW(inside_path, GENERIC_WRITE, 0, 0, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, 0);
  if (inside == INVALID_HANDLE_VALUE) return 42;
  HANDLE outside = CreateFileW(outside_path, GENERIC_WRITE, 0, 0, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, 0);
  const BOOL outside_created = outside != INVALID_HANDLE_VALUE;
  const DWORD outside_error = outside_created ? ERROR_SUCCESS : GetLastError();
  if (outside_created) {
    DWORD written = 0;
    WriteFile(outside, "outside\n", 8, &written, 0);
    CloseHandle(outside);
  }
  char receipt[256];
  const int length = sprintf_s(receipt, "app-container=%d app-container-query=%d lpac=%d lpac-query=%d in-job=%d in-job-query=%d outside-created=%d outside-error=%lu\n",
    app_container, app_container_known, lpac, lpac_known, in_job, in_job_known, outside_created, outside_error);
  DWORD written = 0;
  const BOOL wrote = length > 0 && WriteFile(inside, receipt, static_cast<DWORD>(length), &written, 0) && written == static_cast<DWORD>(length);
  CloseHandle(inside);
  return wrote ? 0 : 43;
}

static bool read_uint32(IWbemClassObject* object, const wchar_t* name, DWORD* value) {
  VARIANT result;
  VariantInit(&result);
  const HRESULT status = object->Get(name, 0, &result, 0, 0);
  const bool present = SUCCEEDED(status) && (result.vt == VT_I4 || result.vt == VT_UI4);
  if (present) *value = result.vt == VT_I4 ? static_cast<DWORD>(result.lVal) : result.ulVal;
  VariantClear(&result);
  return present;
}

static void attempt_wmi_create(const std::wstring& self, const std::wstring& inside_marker, const std::wstring& outside_marker) {
  HRESULT status = CoInitializeEx(0, COINIT_MULTITHREADED);
  print_hresult(L"wmi-com-initialize", status);
  if (FAILED(status)) return;

  const HRESULT security = CoInitializeSecurity(0, -1, 0, 0, RPC_C_AUTHN_LEVEL_DEFAULT, RPC_C_IMP_LEVEL_IMPERSONATE, 0, EOAC_NONE, 0);
  print_hresult(L"wmi-com-security", security);
  if (FAILED(security) && security != RPC_E_TOO_LATE) { CoUninitialize(); return; }

  IWbemLocator* locator = 0;
  status = CoCreateInstance(CLSID_WbemLocator, 0, CLSCTX_INPROC_SERVER, IID_IWbemLocator, reinterpret_cast<void**>(&locator));
  print_hresult(L"wmi-locator", status);
  if (FAILED(status)) { CoUninitialize(); return; }

  BSTR namespace_name = SysAllocString(L"ROOT\\CIMV2");
  IWbemServices* services = 0;
  status = namespace_name ? locator->ConnectServer(namespace_name, 0, 0, 0, 0, 0, 0, &services) : E_OUTOFMEMORY;
  SysFreeString(namespace_name);
  print_hresult(L"wmi-connect", status);
  if (FAILED(status)) { locator->Release(); CoUninitialize(); return; }

  status = CoSetProxyBlanket(services, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, 0, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, 0, EOAC_NONE);
  print_hresult(L"wmi-proxy", status);
  if (FAILED(status)) { services->Release(); locator->Release(); CoUninitialize(); return; }

  BSTR class_name = SysAllocString(L"Win32_Process");
  BSTR method_name = SysAllocString(L"Create");
  IWbemClassObject* process_class = 0;
  status = class_name && method_name ? services->GetObject(class_name, 0, 0, &process_class, 0) : E_OUTOFMEMORY;
  print_hresult(L"wmi-get-process-class", status);
  IWbemClassObject* input_definition = 0;
  IWbemClassObject* input = 0;
  IWbemClassObject* output = 0;
  if (SUCCEEDED(status)) {
    status = process_class->GetMethod(method_name, 0, &input_definition, 0);
    print_hresult(L"wmi-get-create-method", status);
  }
  if (SUCCEEDED(status)) {
    status = input_definition->SpawnInstance(0, &input);
    print_hresult(L"wmi-create-input", status);
  }
  VARIANT command;
  VariantInit(&command);
  if (SUCCEEDED(status)) {
    const std::wstring command_line = quote(self) + L" --broker-child " + quote(inside_marker) + L" " + quote(outside_marker);
    command.vt = VT_BSTR;
    command.bstrVal = SysAllocString(command_line.c_str());
    status = command.bstrVal ? input->Put(L"CommandLine", 0, &command, 0) : E_OUTOFMEMORY;
    print_hresult(L"wmi-set-command-line", status);
  }
  if (SUCCEEDED(status)) {
    status = services->ExecMethod(class_name, method_name, 0, 0, input, &output, 0);
    print_hresult(L"wmi-exec", status);
  }
  if (SUCCEEDED(status) && output) {
    DWORD return_value = 0, process_id = 0;
    const bool has_return = read_uint32(output, L"ReturnValue", &return_value);
    const bool has_process_id = read_uint32(output, L"ProcessId", &process_id);
    wprintf(L"wmi-return-value=%lu present=%d\n", return_value, has_return);
    wprintf(L"wmi-process-id=%lu present=%d\n", process_id, has_process_id);
    if (has_return && return_value == 0 && has_process_id && process_id != 0) {
      HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, FALSE, process_id);
      wprintf(L"wmi-process-opened=%d error=%lu\n", process != 0, GetLastError());
      if (process) { wait_for_owned_fixture(process, self, L"wmi-process", 2000); CloseHandle(process); }
    }
  }
  VariantClear(&command);
  if (output) output->Release();
  if (input) input->Release();
  if (input_definition) input_definition->Release();
  if (process_class) process_class->Release();
  SysFreeString(method_name);
  SysFreeString(class_name);
  services->Release();
  locator->Release();
  CoUninitialize();
}

static void attempt_shell_execute(const std::wstring& self, const std::wstring& inside_marker, const std::wstring& outside_marker) {
  HRESULT status = CoInitializeEx(0, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  print_hresult(L"shell-com-initialize", status);
  const std::wstring parameters = L"--broker-child " + quote(inside_marker) + L" " + quote(outside_marker);
  SHELLEXECUTEINFOW request = { sizeof(request) };
  request.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
  request.lpFile = self.c_str();
  request.lpParameters = parameters.c_str();
  request.nShow = SW_HIDE;
  const BOOL created = ShellExecuteExW(&request);
  const DWORD error = created ? ERROR_SUCCESS : GetLastError();
  wprintf(L"shell-execute result=%d error=%lu\n", created, error);
  const DWORD process_id = request.hProcess ? GetProcessId(request.hProcess) : 0;
  wprintf(L"shell-process-handle=%d process-id=%lu\n", request.hProcess != 0, process_id);
  if (request.hProcess) {
    wait_for_owned_fixture(request.hProcess, self, L"shell-process", 2000);
    CloseHandle(request.hProcess);
  } else Sleep(2000);
  if (SUCCEEDED(status)) CoUninitialize();
}

static void attempt_direct_children(const std::wstring& self, const std::wstring& base) {
  for (int attempt = 0; attempt < 2; ++attempt) {
    std::wstring marker = base + (attempt ? L".breakaway" : L".normal");
    std::wstring command = quote(self) + L" --child " + quote(marker);
    STARTUPINFOW startup = { sizeof(startup) }; PROCESS_INFORMATION child = {};
    DWORD flags = CREATE_NO_WINDOW | (attempt ? CREATE_BREAKAWAY_FROM_JOB : 0);
    BOOL ok = CreateProcessW(self.c_str(), &command[0], 0, 0, FALSE, flags, 0, 0, &startup, &child);
    wprintf(L"attempt=%d created=%d error=%lu\n", attempt, ok, GetLastError());
    if (ok) { WaitForSingleObject(child.hProcess, 5000); CloseHandle(child.hThread); CloseHandle(child.hProcess); }
  }
}

int wmain(int argc, wchar_t** argv) {
  wprintf(L"main-started\n");
  if (argc == 4 && wcscmp(argv[1], L"--broker-child") == 0) return write_broker_child_markers(argv[2], argv[3]);
  if (argc == 3 && wcscmp(argv[1], L"--child") == 0) {
    HANDLE file = CreateFileW(argv[2], GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (file == INVALID_HANDLE_VALUE) return 41;
    DWORD written; WriteFile(file, "child", 5, &written, 0); CloseHandle(file); wprintf(L"child-started\n"); return 0;
  }
  wchar_t self_path[MAX_PATH]; GetModuleFileNameW(0, self_path, MAX_PATH);
  const std::wstring self = self_path;
  if (argc == 4 && wcscmp(argv[1], L"--broker") == 0) {
    const std::wstring inside = argv[2];
    const std::wstring outside = argv[3];
    attempt_wmi_create(self, inside + L".wmi", outside + L".wmi");
    attempt_shell_execute(self, inside + L".shell", outside + L".shell");
  } else if (argc == 2) {
    attempt_direct_children(self, argv[1]);
  } else {
    return 2;
  }
  wprintf(L"continue-after-attempt\n");
  return 0;
}
