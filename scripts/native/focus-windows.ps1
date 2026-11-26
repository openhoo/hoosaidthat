param([Parameter(Mandatory=$true)][int]$BrowserProcessId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$session = (Get-Process -Id $PID).SessionId
$readers = @(Get-Process -Name jfw -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session)
if ($readers.Count -ne 1) { throw 'Exactly one running JAWS process is required in the interactive desktop' }
if (Get-Process -Name nvda -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session) { throw 'Stop NVDA before capturing JAWS speech' }
$info = $readers[0].MainModule.FileVersionInfo
$version = '{0}.{1}.{2}.{3}' -f $info.ProductMajorPart, $info.ProductMinorPart, $info.ProductBuildPart, $info.ProductPrivatePart
if ([string]::IsNullOrWhiteSpace($version)) { throw 'Could not identify the running JAWS version' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HstNativeWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
[uint32]$foregroundProcessId = 0
[void][HstNativeWindow]::GetWindowThreadProcessId([HstNativeWindow]::GetForegroundWindow(), [ref]$foregroundProcessId)
$active = $foregroundProcessId -eq $BrowserProcessId
$element = if ($active) { [System.Windows.Automation.AutomationElement]::FocusedElement } else { $null }
$document = $null
for ($depth = 0; $null -ne $element -and $depth -lt 64; $depth++) {
  if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { $document = $element; break }
  $element = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($element)
}
$title = $null
$url = $null
if ($null -ne $document) {
  $title = $document.Current.Name
  $pattern = $null
  if ($document.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
    $value = $pattern.Current.Value
    if ($value -match '^(https?|file|about):') { $url = $value }
  }
}
@{
  screenReader = 'jaws'; version = $version;
  browserWindowActive = $active; webContentFocused = ($null -ne $document);
  documentTitle = $title; documentURL = $url
} | ConvertTo-Json -Compress
