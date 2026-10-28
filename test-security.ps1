# =============================================================================
#  Script kiem thu tu dong 4 lop bao ve cua BE-1 (Security Tests)
#  Cach chay: .\test-security.ps1
# =============================================================================

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "   KIEM THU CAC LOP BAO VE CONG KHAI CUA BE-1    " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

# ── TEST 1: Gia mao ma QR Token bua bai ────────────────────────
Write-Host "`n[TEST 1] Thu quet ma QR gia mao..." -ForegroundColor Yellow
$h1 = @{ "X-Request-Id" = [Guid]::NewGuid().ToString(); "X-Timestamp" = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString() }
$b1 = @{ tableCode = "T1-01"; qrToken = "1111111111111111111111111111111111111111111111111111111111111111" } | ConvertTo-Json
try {
    Invoke-RestMethod -Uri "http://127.0.0.1:5000/public-api/session/init" -Method Post -Headers $h1 -ContentType "application/json" -Body $b1
} catch {
    $statusCode = [int]$_.Exception.Response.StatusCode
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $body = $reader.ReadToEnd()
    Write-Host "-> KET QUA: Ma $statusCode (Expected: 403 Forbidden hoac 429 neu dang bi rate-limit)" -ForegroundColor Green
    Write-Host "-> Server tra ve: $body"
}

# ── TEST 2: Tan cong phat lai (Replay Attack) ───────────────────
Write-Host "`n[TEST 2] Thu tan cong phat lai (Replay Attack)..." -ForegroundColor Yellow
$sec = (docker exec -i restomanager-postgres psql -U postgres -d restaurant_db -t -A -c "SELECT qr_secret FROM table_qr_configs WHERE table_code='T1-01';").Trim()
$key = [System.Text.Encoding]::UTF8.GetBytes($sec)
$data = [System.Text.Encoding]::UTF8.GetBytes("T1-01")
$hmac = New-Object System.Security.Cryptography.HMACSHA256(,$key)
$validQrToken = ([System.BitConverter]::ToString($hmac.ComputeHash($data)) -replace "-","").ToLowerInvariant()

$fixedId = [Guid]::NewGuid().ToString()
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
$h2 = @{ "X-Request-Id" = $fixedId; "X-Timestamp" = $ts }
$b2 = @{ tableCode = "T1-01"; qrToken = $validQrToken } | ConvertTo-Json

# Lan 1: Gui request hop le
try {
    $res1 = Invoke-RestMethod -Uri "http://127.0.0.1:5000/public-api/session/init" -Method Post -Headers $h2 -ContentType "application/json" -Body $b2
    Write-Host "-> Lan 1 gui goi tin: Thanh cong (Token: $($res1.sessionToken.Substring(0,16))...)" -ForegroundColor Cyan

    # Lan 2: Gui lai dung X-Request-Id do -> Anti-Replay phai chan
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:5000/public-api/session/init" -Method Post -Headers $h2 -ContentType "application/json" -Body $b2
    } catch {
        $statusCode = [int]$_.Exception.Response.StatusCode
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $body = $reader.ReadToEnd()
        Write-Host "-> Lan 2 gui lai cung Request-Id: BI CHAN! Ma $statusCode" -ForegroundColor Green
        Write-Host "-> Server tra ve: $body"
    }
} catch {
    $statusCode = [int]$_.Exception.Response.StatusCode
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    Write-Host "-> Lan 1 bi rate limit (Ma $statusCode). Hay doi 1 phut roi chay lai." -ForegroundColor DarkYellow
}

# ── TEST 3: Giả mạo Timestamp (Lech gio > 30s) ───────────────────
Write-Host "`n[TEST 3] Thu gui timestamp qua cu (lech 60 giay)..." -ForegroundColor Yellow
$oldTs = ([DateTimeOffset]::UtcNow.AddSeconds(-60)).ToUnixTimeSeconds().ToString()
$h3 = @{ "X-Request-Id" = [Guid]::NewGuid().ToString(); "X-Timestamp" = $oldTs }
try {
    Invoke-RestMethod -Uri "http://127.0.0.1:5000/public-api/session/init" -Method Post -Headers $h3 -ContentType "application/json" -Body $b2
} catch {
    $statusCode = [int]$_.Exception.Response.StatusCode
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $body = $reader.ReadToEnd()
    Write-Host "-> KET QUA: BI CHAN! Ma $statusCode" -ForegroundColor Green
    Write-Host "-> Server tra ve: $body"
}

# ── TEST 4: Dat mon ma khong co Session Token ──────────────────
Write-Host "`n[TEST 4] Thu dat mon khi khong truyen X-Session-Token..." -ForegroundColor Yellow
$h4 = @{ "X-Request-Id" = [Guid]::NewGuid().ToString(); "X-Timestamp" = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString() }
$b4 = @{ notes = "test"; items = @(@{ menuItemId = [Guid]::NewGuid().ToString(); quantity = 1 }) } | ConvertTo-Json
try {
    Invoke-RestMethod -Uri "http://127.0.0.1:5000/public-api/orders" -Method Post -Headers $h4 -ContentType "application/json" -Body $b4
} catch {
    $statusCode = [int]$_.Exception.Response.StatusCode
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $body = $reader.ReadToEnd()
    Write-Host "-> KET QUA: BI CHAN! Ma $statusCode Unauthorized" -ForegroundColor Green
    Write-Host "-> Server tra ve: $body"
}

Write-Host "`n=================================================" -ForegroundColor Cyan
Write-Host "   HOAN TAT KIEM THU BAO VE CUA BE-1!            " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
