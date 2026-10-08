[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string]$WorkspaceDirectory,

  [string]$OutputDirectory,

  [switch]$ValidateOnly,

  [switch]$PrepareOnly,

  [switch]$PrepareNasmOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$selectedModes = @(@($ValidateOnly, $PrepareOnly, $PrepareNasmOnly) | Where-Object { $_ })
if ($selectedModes.Count -gt 1) {
  throw 'Use somente ValidateOnly, PrepareOnly ou PrepareNasmOnly.'
}

function Get-AbsolutePath {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Description,
    [switch]$MustExist
  )

  if (-not [System.IO.Path]::IsPathRooted($Path)) {
    throw "$Description deve usar um caminho absoluto: $Path"
  }
  if ($MustExist -and -not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Description não existe ou não é um diretório: $Path"
  }

  return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path)
}

function Assert-ChildPath {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][string]$Description
  )

  $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $normalizedCandidate = [System.IO.Path]::GetFullPath($Candidate)
  if (-not $normalizedCandidate.StartsWith($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Description saiu do diretório autorizado. Raiz: $Root; caminho: $Candidate"
  }
}

function New-OwnedDirectory {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Name
  )

  $candidate = Join-Path $Root $Name
  Assert-ChildPath -Root $Root -Candidate $candidate -Description 'Diretório de trabalho'
  if (Test-Path -LiteralPath $candidate) {
    throw "O diretório de saída já existe e não será removido: $candidate"
  }
  [System.IO.Directory]::CreateDirectory($candidate) | Out-Null
  return [System.IO.Path]::GetFullPath($candidate)
}

function Get-Sha256 {
  param([Parameter(Mandatory)][string]$Path)
  Write-Host "Iniciando SHA-256: $Path"
  $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Host "SHA-256 concluído: $hash"
  return $hash
}

function Require-Command {
  param([Parameter(Mandatory)][string]$Name)
  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) {
    throw "Ferramenta obrigatória não encontrada: $Name"
  }
  return $command.Path
}

function Invoke-Native {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [Parameter(Mandatory)][string[]]$Arguments,
    [Parameter(Mandatory)][string]$Description,
    [ValidateRange(0, 86400)][int]$TimeoutSeconds = 1200,
    [switch]$CaptureOutput
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.WorkingDirectory = (Get-Location).Path
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $CaptureOutput
  foreach ($argument in $Arguments) {
    [void]$startInfo.ArgumentList.Add($argument)
  }
  $process = [System.Diagnostics.Process]::new()
  $started = $false
  $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
  $nextProgressSeconds = 15
  Write-Host "Iniciando: $Description; executável: $FilePath"
  try {
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $started = $true
    Write-Host "Processo iniciado: $Description; PID $($process.Id)"
    if ($CaptureOutput) {
      $outputTask = $process.StandardOutput.ReadToEndAsync()
      Write-Host "Captura de stdout iniciada: $Description; estado $($outputTask.Status)"
    }
    if ($TimeoutSeconds -eq 0) {
      $process.WaitForExit()
    }
    else {
      while (-not $process.WaitForExit([int][Math]::Min(1000, [Math]::Max(1, $TimeoutSeconds * 1000 - $elapsed.ElapsedMilliseconds)))) {
        if ($elapsed.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
          throw "$Description excedeu o limite de $TimeoutSeconds segundos."
        }
        if ($elapsed.Elapsed.TotalSeconds -ge $nextProgressSeconds) {
          $cpuSeconds = 'indisponível'
          try { $cpuSeconds = $process.TotalProcessorTime.TotalSeconds.ToString('F1', [System.Globalization.CultureInfo]::InvariantCulture) }
          catch [System.InvalidOperationException] { $cpuSeconds = 'indisponível' }
          catch [System.ComponentModel.Win32Exception] { $cpuSeconds = 'indisponível' }
          $captureStatus = if ($CaptureOutput) { $outputTask.Status } else { 'não redirecionado' }
          Write-Host ("Processo em andamento: {0}; PID {1}; {2:N1}s; CPU {3}s; encerrado {4}; stdout {5}" -f $Description, $process.Id, $elapsed.Elapsed.TotalSeconds, $cpuSeconds, $process.HasExited, $captureStatus)
          $nextProgressSeconds += 15
        }
      }
    }
    if ($process.ExitCode -ne 0) {
      throw "$Description falhou com código $($process.ExitCode)."
    }
    if ($CaptureOutput) {
      $captureWaitMilliseconds = 30000
      if ($TimeoutSeconds -gt 0) {
        $captureWaitMilliseconds = [int][Math]::Min($captureWaitMilliseconds, [Math]::Max(0, $TimeoutSeconds * 1000 - $elapsed.ElapsedMilliseconds))
      }
      Write-Host "Processo encerrado: $Description; aguardando stdout por até $captureWaitMilliseconds ms; estado $($outputTask.Status)"
      if (-not $outputTask.Wait($captureWaitMilliseconds)) {
        throw "$Description encerrou, mas a captura de stdout excedeu o limite de $captureWaitMilliseconds ms."
      }
      $capturedOutput = $outputTask.GetAwaiter().GetResult()
    }
    Write-Host ("Concluído: {0} ({1:N1}s)" -f $Description, $elapsed.Elapsed.TotalSeconds)
    if ($CaptureOutput) { return $capturedOutput.TrimEnd("`r", "`n") -split '\r?\n' }
  }
  finally {
    if ($started -and -not $process.HasExited) {
      $process.Kill($true)
      [void]$process.WaitForExit(5000)
    }
    $process.Dispose()
  }
}

function Invoke-GitWithoutRepository {
  param(
    [Parameter(Mandatory)][string]$GitPath,
    [Parameter(Mandatory)][string]$SourceDirectory,
    [Parameter(Mandatory)][string[]]$Arguments,
    [Parameter(Mandatory)][string]$Description
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $GitPath
  $startInfo.WorkingDirectory = $SourceDirectory
  $startInfo.UseShellExecute = $false
  foreach ($environmentName in @('GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES')) {
    [void]$startInfo.Environment.Remove($environmentName)
  }
  $startInfo.Environment['GIT_CEILING_DIRECTORIES'] = $SourceDirectory
  [void]$startInfo.ArgumentList.Add('--git-dir=NUL')
  foreach ($argument in $Arguments) {
    [void]$startInfo.ArgumentList.Add($argument)
  }

  $process = [System.Diagnostics.Process]::new()
  $started = $false
  $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
  Write-Host "Iniciando: $Description"
  try {
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $started = $true
    if (-not $process.WaitForExit(120000)) {
      throw "$Description excedeu o limite de 120 segundos."
    }
    if ($process.ExitCode -ne 0) {
      throw "$Description falhou com código $($process.ExitCode)."
    }
    Write-Host ("Concluído: {0} ({1:N1}s)" -f $Description, $elapsed.Elapsed.TotalSeconds)
  }
  finally {
    if ($started -and -not $process.HasExited) {
      $process.Kill($true)
      [void]$process.WaitForExit(5000)
    }
    $process.Dispose()
  }
}

function Invoke-BoundedDownload {
  param(
    [Parameter(Mandatory)][string]$Url,
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][ValidateRange(1, [Int64]::MaxValue)][Int64]$MaximumBytes
  )

  if ($Url -cne $expectedSourceUrl -and $Url -cne $expectedNasmUrl) {
    throw "URL fora dos inputs oficiais fixados: $Url"
  }
  if (Test-Path -LiteralPath $Destination) {
    throw "O destino do download já existe e não será sobrescrito: $Destination"
  }
  $curlPath = Require-Command -Name 'curl.exe'
  $curlVersion = @(Invoke-Native -FilePath $curlPath -Arguments @('--disable', '--version') -Description 'A verificação do curl' -TimeoutSeconds 30 -CaptureOutput)[0]
  if ($curlVersion -notmatch '^curl (\d+\.\d+\.\d+)' -or [version]$Matches[1] -lt [version]'8.4.0') {
    throw "curl >= 8.4.0 é necessário para limitar transferências sem Content-Length: $curlVersion"
  }
  Write-Host "Ferramenta de transferência: $curlVersion"
  $partialPath = "$Destination.$([guid]::NewGuid().ToString('N')).download"
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $curlPath
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  foreach ($argument in @(
    '--disable', '--silent', '--show-error', '--fail', '--proto', '=https',
    '--connect-timeout', '30', '--max-time', '1200',
    '--max-filesize', $MaximumBytes.ToString([System.Globalization.CultureInfo]::InvariantCulture),
    '--no-clobber', '--output', $partialPath, '--write-out', '%{http_code}', '--url', $Url
  )) {
    [void]$startInfo.ArgumentList.Add($argument)
  }
  $process = [System.Diagnostics.Process]::new()
  $started = $false
  $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
  $nextProgressSeconds = 15
  Write-Host "Iniciando transferência: $Url; 0 bytes; conexão 30s; transferência 1200s; limite $MaximumBytes bytes."
  try {
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $started = $true
    $statusTask = $process.StandardOutput.ReadToEndAsync()
    while (-not $process.WaitForExit(1000)) {
      if ($elapsed.Elapsed.TotalSeconds -ge 1220) {
        throw 'A transferência excedeu o watchdog externo de 1220 segundos.'
      }
      [Int64]$receivedBytes = if (Test-Path -LiteralPath $partialPath -PathType Leaf) { (Get-Item -LiteralPath $partialPath).Length } else { 0 }
      if ($receivedBytes -gt $MaximumBytes) {
        throw "O download excedeu o limite de $MaximumBytes bytes."
      }
      if ($elapsed.Elapsed.TotalSeconds -ge $nextProgressSeconds) {
        Write-Host ("Transferência em andamento: {0} bytes; {1:N1}s; {2}" -f $receivedBytes, $elapsed.Elapsed.TotalSeconds, $Url)
        $nextProgressSeconds += 15
      }
    }
    if ($process.ExitCode -ne 0) {
      throw "O download oficial falhou com código curl $($process.ExitCode): $Url"
    }
    $httpStatus = $statusTask.GetAwaiter().GetResult()
    if ($httpStatus -notmatch '^2\d\d$') {
      throw "Download oficial retornou HTTP $httpStatus; redirecionamentos não são permitidos: $Url"
    }
    $receivedBytes = (Get-Item -LiteralPath $partialPath).Length
    if ($receivedBytes -le 0 -or $receivedBytes -gt $MaximumBytes) {
      throw "O download possui tamanho inválido: $receivedBytes bytes; limite $MaximumBytes."
    }
    [System.IO.File]::Move($partialPath, $Destination)
    Write-Host ("Transferência concluída: {0} bytes; HTTP {1}; {2:N1}s; {3}" -f $receivedBytes, $httpStatus, $elapsed.Elapsed.TotalSeconds, $Destination)
  }
  finally {
    if ($started -and -not $process.HasExited) {
      $process.Kill($true)
      [void]$process.WaitForExit(5000)
    }
    $process.Dispose()
    if (Test-Path -LiteralPath $partialPath -PathType Leaf) {
      Remove-Item -LiteralPath $partialPath
    }
  }
}

function Test-SourceArchive {
  param(
    [Parameter(Mandatory)][string]$TarPath,
    [Parameter(Mandatory)][string]$TarExecutable,
    [Parameter(Mandatory)][string]$ExpectedRoot
  )

  $entries = @(Invoke-Native -FilePath $TarExecutable -Arguments @('-tf', $TarPath) -Description 'A listagem do tarball oficial do Node' -CaptureOutput)
  if ($entries.Count -eq 0) {
    throw 'Não foi possível listar o tarball oficial do Node.'
  }
  foreach ($entry in $entries) {
    if ($entry -notlike "$ExpectedRoot/*" -or $entry -match '(^|[\\/])\.\.([\\/]|$)' -or $entry -match '^[\\/]') {
      throw "O tarball contém uma entrada fora da raiz esperada: $entry"
    }
  }
}

function Test-NasmArchive {
  param(
    [Parameter(Mandatory)][string]$ArchivePath,
    [Parameter(Mandatory)][string]$TarExecutable,
    [Parameter(Mandatory)][string]$ExpectedRoot,
    [Parameter(Mandatory)][string]$ExpectedExecutable
  )

  $entries = @(Invoke-Native -FilePath $TarExecutable -Arguments @('-tf', $ArchivePath) -Description 'A listagem do arquivo oficial do NASM' -CaptureOutput)
  if ($entries.Count -eq 0) {
    throw 'Não foi possível listar o arquivo oficial do NASM.'
  }
  foreach ($entry in $entries) {
    if ($entry -notlike "$ExpectedRoot/*" -or $entry -match '(^|[\\/])\.\.([\\/]|$)' -or $entry -match '^[\\/]') {
      throw "O arquivo do NASM contém uma entrada fora da raiz esperada: $entry"
    }
  }
  if ($entries -notcontains "$ExpectedRoot/$ExpectedExecutable") {
    throw "O arquivo oficial do NASM não contém $ExpectedRoot/$ExpectedExecutable."
  }
}

function Assert-PatchInput {
  param(
    [Parameter(Mandatory)][string]$PatchPath,
    [Parameter(Mandatory)][string]$ExpectedHash,
    [Parameter(Mandatory)][string]$ExpectedTarget
  )

  $actualHash = Get-Sha256 -Path $PatchPath
  if ($actualHash -ne $ExpectedHash.ToLowerInvariant()) {
    throw "O hash do patch local não corresponde ao manifesto. Esperado: $ExpectedHash; encontrado: $actualHash"
  }

  $patchText = [System.IO.File]::ReadAllText($PatchPath, [System.Text.UTF8Encoding]::new($false))
  $requiredHeader = "diff --git a/$ExpectedTarget b/$ExpectedTarget`n--- a/$ExpectedTarget`n+++ b/$ExpectedTarget"
  if (-not $patchText.Replace("`r`n", "`n").StartsWith($requiredHeader, [System.StringComparison]::Ordinal)) {
    throw 'O patch não possui o cabeçalho do único alvo permitido.'
  }
  if (([regex]::Matches($patchText, '(?m)^diff --git ')).Count -ne 1) {
    throw 'O patch deve alterar exatamente um arquivo.'
  }
  if ($patchText -notmatch 'TokenIsAppContainer' -or $patchText -notmatch 'uv_once\(' -or $patchText -notmatch '"LOCAL\\\\"') {
    throw 'O patch não contém todos os elementos esperados da correção oficial LPAC.'
  }
}

function Get-VisualStudioInstallation {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw 'Visual Studio 2022 não encontrado: vswhere.exe está ausente.'
  }
  $installation = (Invoke-Native -FilePath $vswhere -Arguments @('-latest', '-products', '*', '-version', '[17.0,18.0)', '-property', 'installationPath') -Description 'A localização do Visual Studio 2022' -TimeoutSeconds 30 -CaptureOutput | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($installation) -or -not (Test-Path -LiteralPath $installation -PathType Container)) {
    throw 'Visual Studio 2022 não encontrado. Use o runner windows-2022 com ferramentas C++.'
  }
  return $installation
}

function Get-DumpbinPath {
  param([Parameter(Mandatory)][string]$VisualStudioPath)

  $onPath = Get-Command dumpbin.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $onPath) {
    return $onPath.Path
  }

  $msvcBase = Join-Path $VisualStudioPath 'VC\Tools\MSVC'
  $versions = Get-ChildItem -LiteralPath $msvcBase -Directory -ErrorAction Stop | Sort-Object Name -Descending
  foreach ($version in $versions) {
    $candidate = Join-Path $version.FullName 'bin\Hostx64\x64\dumpbin.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  throw 'dumpbin.exe não foi encontrado no Visual Studio 2022; não é possível verificar as dependências PE.'
}

function Prepare-Nasm {
  param(
    [Parameter(Mandatory)][string]$WorkspaceRoot,
    [Parameter(Mandatory)]$NasmManifest
  )

  $toolDirectory = New-OwnedDirectory -Root $WorkspaceRoot -Name "portable-nasm-$($NasmManifest.version)-$([guid]::NewGuid().ToString('N'))"
  $archivePath = Join-Path $toolDirectory 'nasm-win64.zip'
  Assert-ChildPath -Root $WorkspaceRoot -Candidate $archivePath -Description 'Arquivo do NASM'
  Write-Host 'Baixando o NASM oficial fixado por SHA-256.'
  Invoke-BoundedDownload -Url $NasmManifest.url -Destination $archivePath -MaximumBytes ([Int64]$NasmManifest.maximumArchiveBytes)
  if ((Get-Sha256 -Path $archivePath) -ne $NasmManifest.sha256) {
    throw 'O SHA-256 do arquivo oficial do NASM não corresponde ao manifesto.'
  }

  $tarPath = Require-Command -Name 'tar.exe'
  $tarVersion = (Invoke-Native -FilePath $tarPath -Arguments @('--version') -Description 'A verificação do tar' -TimeoutSeconds 30 -CaptureOutput | Out-String).Trim()
  Write-Host "Ferramenta de arquivo: $tarPath; $tarVersion"
  Test-NasmArchive -ArchivePath $archivePath -TarExecutable $tarPath -ExpectedRoot $NasmManifest.directory -ExpectedExecutable $NasmManifest.executable
  Invoke-Native -FilePath $tarPath -Arguments @('-xf', $archivePath, '-C', $toolDirectory) -Description 'A extração do arquivo do NASM'
  $nasmDirectory = Join-Path $toolDirectory $NasmManifest.directory
  $nasmPath = Join-Path $nasmDirectory $NasmManifest.executable
  Assert-ChildPath -Root $WorkspaceRoot -Candidate $nasmPath -Description 'Executável do NASM'
  if (-not (Test-Path -LiteralPath $nasmPath -PathType Leaf)) {
    throw "O executável NASM esperado está ausente: $nasmPath"
  }
  $nasmVersion = (Invoke-Native -FilePath $nasmPath -Arguments @('--version') -Description 'A verificação do NASM preparado' -TimeoutSeconds 30 -CaptureOutput | Out-String).Trim()
  if ($nasmVersion -notmatch "^NASM version $([regex]::Escape($NasmManifest.version))(\s|$)") {
    throw "A execução de verificação do NASM retornou versão inválida: $nasmVersion"
  }
  return [ordered]@{
    directory = $nasmDirectory
    path = $nasmPath
    version = $nasmVersion
  }
}

function Add-WorkflowPath {
  param([Parameter(Mandatory)][string]$Directory)

  $pathFile = [Environment]::GetEnvironmentVariable('GITHUB_PATH')
  if (-not [string]::IsNullOrWhiteSpace($pathFile)) {
    [System.IO.File]::AppendAllText($pathFile, "$Directory`n", [System.Text.UTF8Encoding]::new($false))
  }
}

function Test-Toolchain {
  param([Parameter(Mandatory)][string]$ExpectedNasmVersion)

  Write-Host 'Iniciando verificação das ferramentas de compilação.'
  $visualStudioPath = Get-VisualStudioInstallation
  $clangPath = Join-Path $visualStudioPath 'VC\Tools\Llvm\x64\bin\clang.exe'
  if (-not (Test-Path -LiteralPath $clangPath -PathType Leaf)) {
    throw 'O componente C++ Clang Compiler for Windows está ausente no Visual Studio 2022.'
  }
  $clangToolset = Join-Path $visualStudioPath 'MSBuild\Microsoft\VC\v170\Microsoft.Cpp.Default.props'
  if (-not (Test-Path -LiteralPath $clangToolset -PathType Leaf)) {
    throw 'Os alvos C++ do Visual Studio 2022 estão ausentes.'
  }
  $nasmPath = Require-Command -Name 'nasm.exe'
  $nasmVersion = (Invoke-Native -FilePath $nasmPath -Arguments @('--version') -Description 'A verificação do NASM no PATH' -TimeoutSeconds 30 -CaptureOutput | Out-String).Trim()
  if ($nasmVersion -notmatch "^NASM version $([regex]::Escape($ExpectedNasmVersion))(\s|$)") {
    throw "A execução de verificação do NASM retornou versão inválida: $nasmVersion"
  }
  $toolchain = [ordered]@{
    visualStudioPath = $visualStudioPath
    clangPath = $clangPath
    dumpbinPath = Get-DumpbinPath -VisualStudioPath $visualStudioPath
    nasmVersion = $nasmVersion
  }
  Write-Host "Verificação das ferramentas concluída: $visualStudioPath; $nasmVersion"
  return $toolchain
}

function Get-PeDependencies {
  param(
    [Parameter(Mandatory)][string]$DumpbinPath,
    [Parameter(Mandatory)][string]$NodePath
  )

  $dumpbinOutput = & $DumpbinPath /dependents $NodePath 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "dumpbin /dependents falhou com código $LASTEXITCODE."
  }
  $dependencies = @(
    $dumpbinOutput |
      ForEach-Object { $_.ToString().Trim() } |
      Where-Object { $_ -match '^[A-Za-z0-9._-]+\.dll$' } |
      ForEach-Object { $_.ToLowerInvariant() } |
      Sort-Object -Unique
  )
  $compilerRuntime = @($dependencies | Where-Object { $_ -match '^(vcruntime|msvcp|concrt|clang_rt|libc\+\+|libunwind)' })
  if ($compilerRuntime.Count -gt 0) {
    throw "node.exe depende de runtimes do compilador que não fazem parte do payload: $($compilerRuntime -join ', ')"
  }
  return $dependencies
}

function Write-WorkflowOutput {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Value
  )

  $outputFile = [Environment]::GetEnvironmentVariable('GITHUB_OUTPUT')
  if (-not [string]::IsNullOrWhiteSpace($outputFile)) {
    [System.IO.File]::AppendAllText($outputFile, "$Name=$Value`n", [System.Text.UTF8Encoding]::new($false))
  }
}

$buildId = 'node-v24.21.0-lpac1-win-x64'
$expectedSourceUrl = 'https://nodejs.org/dist/v24.21.0/node-v24.21.0.tar.gz'
$expectedSourceCommit = '955266bfdd854cd280dffd47548673914484e4c0'
$expectedPatchCommit = 'f46e4246b5277fe1c5888b88b24d8b78020dd4f8'
$expectedPatchTarget = 'deps/uv/src/win/pipe.c'
$expectedNasmVersion = '3.02'
$expectedNasmUrl = 'https://www.nasm.us/pub/nasm/releasebuilds/3.02/win64/nasm-3.02-win64.zip'
$expectedNasmDirectory = 'nasm-3.02'
$expectedNasmExecutable = 'nasm.exe'
$expectedVcbuildArguments = @('x64', 'vs2022', 'clang-cl', 'nonpm', 'nocorepack', 'no-cctest')
$scriptDirectory = Split-Path -Parent $PSCommandPath
$repositoryDirectory = Split-Path -Parent $scriptDirectory
$manifestPath = Join-Path $repositoryDirectory 'runtime\node24-source.json'

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Manifesto de fonte ausente: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.buildId -ne $buildId -or $manifest.source.url -ne $expectedSourceUrl -or $manifest.source.gitCommit -ne $expectedSourceCommit -or $manifest.patch.upstreamCommit -ne $expectedPatchCommit -or $manifest.patch.target -ne $expectedPatchTarget -or $manifest.tools.nasm.version -ne $expectedNasmVersion -or $manifest.tools.nasm.url -ne $expectedNasmUrl -or $manifest.tools.nasm.directory -ne $expectedNasmDirectory -or $manifest.tools.nasm.executable -ne $expectedNasmExecutable) {
  throw 'O manifesto não corresponde aos inputs fixados para este build.'
}
if ((@($manifest.build.vcbuildArguments) -join '|') -ne ($expectedVcbuildArguments -join '|')) {
  throw 'Os argumentos de compilação do manifesto não correspondem ao build fixado.'
}
if ($manifest.source.sha256 -notmatch '^[a-f0-9]{64}$' -or $manifest.patch.sha256 -notmatch '^[a-f0-9]{64}$' -or $manifest.patch.targetBeforeSha256 -notmatch '^[a-f0-9]{64}$' -or $manifest.patch.targetAfterSha256 -notmatch '^[a-f0-9]{64}$' -or $manifest.tools.nasm.sha256 -notmatch '^[a-f0-9]{64}$') {
  throw 'O manifesto contém um SHA-256 inválido.'
}
if ([Int64]$manifest.tools.nasm.maximumArchiveBytes -le 0 -or [Int64]$manifest.source.maximumArchiveBytes -le 0) {
  throw 'O manifesto contém um limite de tamanho inválido para download.'
}
if ($manifest.patch.targetBeforeSha256 -eq $manifest.patch.targetAfterSha256) {
  throw 'O manifesto deve fixar imagens pré e pós-patch distintas para o alvo.'
}

$patchPath = Join-Path (Split-Path -Parent $manifestPath) $manifest.patch.file
if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
  throw "Patch local ausente: $patchPath"
}
Assert-PatchInput -PatchPath $patchPath -ExpectedHash $manifest.patch.sha256 -ExpectedTarget $expectedPatchTarget

if ($ValidateOnly) {
  Write-Host 'Validação dos inputs fixados concluída.'
  exit 0
}

$workspaceRoot = Get-AbsolutePath -Path $WorkspaceDirectory -Description 'WorkspaceDirectory' -MustExist
if ($workspaceRoot -match '\s') {
  throw 'WorkspaceDirectory não pode conter espaços porque o build do Node exige um caminho sem espaços.'
}

if ($PrepareNasmOnly) {
  $nasm = Prepare-Nasm -WorkspaceRoot $workspaceRoot -NasmManifest $manifest.tools.nasm
  Add-WorkflowPath -Directory $nasm.directory
  Write-WorkflowOutput -Name 'nasm-path' -Value $nasm.path
  Write-WorkflowOutput -Name 'nasm-directory' -Value $nasm.directory
  Write-Host "NASM preparado: $($nasm.path)"
  exit 0
}

$workName = "portable-node-source-$([guid]::NewGuid().ToString('N'))"
$workDirectory = New-OwnedDirectory -Root $workspaceRoot -Name $workName
$archivePath = Join-Path $workDirectory 'node-v24.21.0.tar.gz'
Assert-ChildPath -Root $workspaceRoot -Candidate $archivePath -Description 'Arquivo fonte'
Write-Host 'Baixando a fonte oficial do Node fixada por SHA-256.'
Invoke-BoundedDownload -Url $manifest.source.url -Destination $archivePath -MaximumBytes ([Int64]$manifest.source.maximumArchiveBytes)
if ((Get-Sha256 -Path $archivePath) -ne $manifest.source.sha256) {
  throw 'O SHA-256 do tarball oficial não corresponde ao manifesto.'
}

$tarPath = Require-Command -Name 'tar.exe'
$tarVersion = (Invoke-Native -FilePath $tarPath -Arguments @('--version') -Description 'A verificação do tar' -TimeoutSeconds 30 -CaptureOutput | Out-String).Trim()
Write-Host "Ferramenta de arquivo: $tarPath; $tarVersion"
Test-SourceArchive -TarPath $archivePath -TarExecutable $tarPath -ExpectedRoot $manifest.source.directory
Invoke-Native -FilePath $tarPath -Arguments @('-xf', $archivePath, '-C', $workDirectory) -Description 'A extração do tarball oficial'
$sourceDirectory = Join-Path $workDirectory $manifest.source.directory
Assert-ChildPath -Root $workspaceRoot -Candidate $sourceDirectory -Description 'Fonte extraída'
if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
  throw "A raiz extraída esperada está ausente: $sourceDirectory"
}

$patchTargetPath = Join-Path $sourceDirectory $expectedPatchTarget
if (-not (Test-Path -LiteralPath $patchTargetPath -PathType Leaf)) {
  throw "O alvo do patch não existe na fonte extraída: $patchTargetPath"
}
$prePatchHash = Get-Sha256 -Path $patchTargetPath
if ($prePatchHash -ne $manifest.patch.targetBeforeSha256) {
  throw "O SHA-256 pré-patch do alvo não corresponde ao manifesto. Esperado: $($manifest.patch.targetBeforeSha256); encontrado: $prePatchHash"
}
$prePatchText = [System.IO.File]::ReadAllText($patchTargetPath)
if ($prePatchText -notmatch 'snprintf\(name, size, "\\\\\\\\\?\\\\pipe\\\\uv\\\\%llu-%lu", ptr, GetCurrentProcessId\(\)\);' -or $prePatchText -match 'uv_is_app_container_') {
  throw 'O alvo do patch não corresponde ao contexto esperado do Node 24.21.0.'
}

$gitPath = Require-Command -Name 'git.exe'
Invoke-GitWithoutRepository -GitPath $gitPath -SourceDirectory $sourceDirectory -Arguments @('apply', '--no-index', '--check', '--whitespace=error', $patchPath) -Description 'A validação contextual do patch'
Invoke-GitWithoutRepository -GitPath $gitPath -SourceDirectory $sourceDirectory -Arguments @('apply', '--no-index', '--whitespace=error', $patchPath) -Description 'A aplicação do patch'
Invoke-GitWithoutRepository -GitPath $gitPath -SourceDirectory $sourceDirectory -Arguments @('apply', '--no-index', '--reverse', '--check', '--whitespace=error', $patchPath) -Description 'A validação reversa do patch'
$postPatchHash = Get-Sha256 -Path $patchTargetPath
if ($postPatchHash -ne $manifest.patch.targetAfterSha256) {
  throw "O SHA-256 pós-patch do alvo não corresponde ao manifesto. Esperado: $($manifest.patch.targetAfterSha256); encontrado: $postPatchHash"
}
$postPatchText = [System.IO.File]::ReadAllText($patchTargetPath)
if ($postPatchText -notmatch 'TokenIsAppContainer' -or $postPatchText -notmatch 'uv_once\(&uv_is_app_container_guard_' -or $postPatchText -notmatch '"LOCAL\\\\"') {
  throw 'A fonte corrigida não contém a implementação oficial LPAC esperada.'
}

if ($PrepareOnly) {
  Write-Host "Preparação concluída: $sourceDirectory"
  exit 0
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $runnerTemp = [Environment]::GetEnvironmentVariable('RUNNER_TEMP')
  if ([string]::IsNullOrWhiteSpace($runnerTemp)) {
    $runnerTemp = $workspaceRoot
  }
  $OutputDirectory = Join-Path $runnerTemp "portable-node-output-$([guid]::NewGuid().ToString('N'))"
}
if (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
  throw "OutputDirectory deve usar um caminho absoluto: $OutputDirectory"
}
if (-not (Test-Path -LiteralPath $OutputDirectory)) {
  [System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
}
$outputRoot = Get-AbsolutePath -Path $OutputDirectory -Description 'OutputDirectory' -MustExist
$payloadDirectory = New-OwnedDirectory -Root $outputRoot -Name $buildId

$toolchain = Test-Toolchain -ExpectedNasmVersion $manifest.tools.nasm.version
Write-Host 'Compilando Node 24.21.0 com ClangCL e os recursos padrão habilitados.'
Push-Location $sourceDirectory
try {
  Invoke-Native -FilePath $env:ComSpec -Arguments @('/d', '/s', '/c', 'call vcbuild.bat x64 vs2022 clang-cl nonpm nocorepack no-cctest') -Description 'A compilação do Node' -TimeoutSeconds 0
}
finally {
  Pop-Location
}

$nodePath = Join-Path $sourceDirectory 'Release\node.exe'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "node.exe não foi produzido em $nodePath"
}
$nodeVersion = (& $nodePath --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne $manifest.source.version) {
  throw "A execução de verificação retornou versão inválida: $nodeVersion"
}
$moduleAbi = (& $nodePath -p 'process.versions.modules' | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $moduleAbi -ne $manifest.build.expectedModuleAbi) {
  throw "A execução de verificação retornou ABI inválido: $moduleAbi"
}
$runtimeFactsJson = (& $nodePath -p 'JSON.stringify({ libuv: process.versions.uv, arch: process.arch, platform: process.platform })' | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw 'A execução de verificação das propriedades do runtime falhou.'
}
$runtimeFacts = $runtimeFactsJson | ConvertFrom-Json
if ($runtimeFacts.libuv -ne $manifest.build.libuvBaseVersion -or $runtimeFacts.arch -ne $manifest.build.architecture -or $runtimeFacts.platform -ne $manifest.build.platform) {
  throw "A execução de verificação retornou propriedades inválidas: $runtimeFactsJson"
}
$peDependencies = Get-PeDependencies -DumpbinPath $toolchain.dumpbinPath -NodePath $nodePath

$payloadNodePath = Join-Path $payloadDirectory 'node.exe'
$payloadLicensePath = Join-Path $payloadDirectory 'LICENSE'
$buildJsonPath = Join-Path $payloadDirectory 'build.json'
$sumsPath = Join-Path $payloadDirectory 'SHA256SUMS'
Copy-Item -LiteralPath $nodePath -Destination $payloadNodePath -ErrorAction Stop
Copy-Item -LiteralPath (Join-Path $sourceDirectory 'LICENSE') -Destination $payloadLicensePath -ErrorAction Stop
$nodeHash = Get-Sha256 -Path $payloadNodePath
$licenseHash = Get-Sha256 -Path $payloadLicensePath
$clangVersion = ((& $toolchain.clangPath --version | Select-Object -First 1) | Out-String).Trim()

$metadata = [ordered]@{
  buildId = $buildId
  node = [ordered]@{
    version = $nodeVersion
    moduleAbi = $moduleAbi
    platform = $runtimeFacts.platform
    architecture = $runtimeFacts.arch
    libuvVersion = $runtimeFacts.libuv
    executableSha256 = $nodeHash
    executablePeDependencies = $peDependencies
  }
  source = [ordered]@{
    url = $manifest.source.url
    sha256 = $manifest.source.sha256
    gitCommit = $manifest.source.gitCommit
    libuvBaseVersion = $manifest.build.libuvBaseVersion
  }
  patch = [ordered]@{
    file = $manifest.patch.file
    sha256 = $manifest.patch.sha256
    upstreamCommit = $manifest.patch.upstreamCommit
    upstreamPullRequest = $manifest.patch.upstreamPullRequest
    target = $manifest.patch.target
  }
  build = [ordered]@{
    vcbuildArguments = @($manifest.build.vcbuildArguments)
    compiler = $clangVersion
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    provenance = [ordered]@{
      repository = [Environment]::GetEnvironmentVariable('GITHUB_REPOSITORY')
      commit = [Environment]::GetEnvironmentVariable('GITHUB_SHA')
      workflow = [Environment]::GetEnvironmentVariable('GITHUB_WORKFLOW')
      runId = [Environment]::GetEnvironmentVariable('GITHUB_RUN_ID')
      runAttempt = [Environment]::GetEnvironmentVariable('GITHUB_RUN_ATTEMPT')
    }
  }
}
[System.IO.File]::WriteAllText($buildJsonPath, ($metadata | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
$buildJsonHash = Get-Sha256 -Path $buildJsonPath
$checksumLines = @(
  "$nodeHash *node.exe",
  "$licenseHash *LICENSE",
  "$buildJsonHash *build.json"
)
[System.IO.File]::WriteAllText($sumsPath, (($checksumLines -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))

Write-WorkflowOutput -Name 'payload-path' -Value $payloadDirectory
Write-WorkflowOutput -Name 'node-exe-path' -Value $payloadNodePath
Write-WorkflowOutput -Name 'license-path' -Value $payloadLicensePath
Write-WorkflowOutput -Name 'build-json-path' -Value $buildJsonPath
Write-WorkflowOutput -Name 'sha256sums-path' -Value $sumsPath

Write-Host "Build concluído: $payloadDirectory"
