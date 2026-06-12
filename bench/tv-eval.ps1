# Evaluate JavaScript inside the Android TV WebView via the Chrome DevTools protocol.
# Usage: powershell -File tv-eval.ps1 -Expr "1+1" [-Ws ws://localhost:9222/devtools/page/<id>]
param(
  [Parameter(Mandatory = $true)][string]$Expr,
  [string]$Ws = ""
)
$ErrorActionPreference = 'Stop'
if (-not $Ws) {
  $pages = (Invoke-WebRequest -Uri "http://localhost:9222/json" -UseBasicParsing).Content | ConvertFrom-Json
  $Ws = ($pages | Where-Object { $_.type -eq 'page' } | Select-Object -First 1).webSocketDebuggerUrl
}
$client = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [System.Threading.CancellationToken]::None
$client.ConnectAsync([Uri]$Ws, $ct).Wait()

$msg = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $Expr; returnByValue = $true; awaitPromise = $true } } | ConvertTo-Json -Depth 6 -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($msg)
$client.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, $ct).Wait()

$buf = New-Object byte[] 262144
$sb = New-Object Text.StringBuilder
do {
  $res = $client.ReceiveAsync([ArraySegment[byte]]::new($buf), $ct).Result
  [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $res.Count))
} while (-not $res.EndOfMessage)
$client.CloseAsync('NormalClosure', '', $ct).Wait()
$sb.ToString()
