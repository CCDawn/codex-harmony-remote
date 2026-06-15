import { execFile } from 'node:child_process';

export async function capturePrimaryDesktopScreenshot() {
  if (process.platform !== 'win32') {
    const error = new Error('桌面截图目前只支持 Windows 主显示器。');
    error.statusCode = 501;
    throw error;
  }

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CodexDpiAwareness {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

  [DllImport("shcore.dll")]
  public static extern int SetProcessDpiAwareness(int awareness);

  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
}
"@

try {
  # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4. This must run before
  # querying Screen bounds, otherwise Windows returns scaled logical pixels.
  [CodexDpiAwareness]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
} catch {
  try {
    # PROCESS_PER_MONITOR_DPI_AWARE = 2
    [CodexDpiAwareness]::SetProcessDpiAwareness(2) | Out-Null
  } catch {
    [CodexDpiAwareness]::SetProcessDPIAware() | Out-Null
  }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

function Write-CaptureResult {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [System.Drawing.Rectangle]$CaptureBounds
  )
  $memory = New-Object System.IO.MemoryStream
  try {
    $Bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $memory.ToArray()
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::WriteLine(($CaptureBounds.Width.ToString() + 'x' + $CaptureBounds.Height.ToString()))
    [Console]::Write([Convert]::ToBase64String($bytes))
  } finally {
    $memory.Dispose()
  }
}

function Capture-WithCopyFromScreen {
  param([System.Drawing.Rectangle]$CaptureBounds)
  $bitmap = New-Object System.Drawing.Bitmap $CaptureBounds.Width, $CaptureBounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($CaptureBounds.Location, [System.Drawing.Point]::Empty, $CaptureBounds.Size)
    Write-CaptureResult -Bitmap $bitmap -CaptureBounds $CaptureBounds
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Capture-WithGdiBitBlt {
  param([System.Drawing.Rectangle]$CaptureBounds)
  Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CodexGdiCapture {
  public const int SRCCOPY = 0x00CC0020;
  public const int CAPTUREBLT = 0x40000000;

  [DllImport("user32.dll")]
  public static extern IntPtr GetDesktopWindow();

  [DllImport("user32.dll")]
  public static extern IntPtr GetWindowDC(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

  [DllImport("gdi32.dll")]
  public static extern IntPtr CreateCompatibleDC(IntPtr hdc);

  [DllImport("gdi32.dll")]
  public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int nWidth, int nHeight);

  [DllImport("gdi32.dll")]
  public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);

  [DllImport("gdi32.dll")]
  public static extern bool BitBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, int dwRop);

  [DllImport("gdi32.dll")]
  public static extern bool DeleteObject(IntPtr hObject);

  [DllImport("gdi32.dll")]
  public static extern bool DeleteDC(IntPtr hdc);
}
"@

  $desktopWindow = [CodexGdiCapture]::GetDesktopWindow()
  $sourceDc = [CodexGdiCapture]::GetWindowDC($desktopWindow)
  if ($sourceDc -eq [IntPtr]::Zero) {
    throw 'GDI 获取桌面 DC 失败。'
  }

  $memoryDc = [IntPtr]::Zero
  $bitmapHandle = [IntPtr]::Zero
  $oldObject = [IntPtr]::Zero
  try {
    $memoryDc = [CodexGdiCapture]::CreateCompatibleDC($sourceDc)
    if ($memoryDc -eq [IntPtr]::Zero) {
      throw 'GDI 创建兼容 DC 失败。'
    }
    $bitmapHandle = [CodexGdiCapture]::CreateCompatibleBitmap($sourceDc, $CaptureBounds.Width, $CaptureBounds.Height)
    if ($bitmapHandle -eq [IntPtr]::Zero) {
      throw 'GDI 创建兼容位图失败。'
    }
    $oldObject = [CodexGdiCapture]::SelectObject($memoryDc, $bitmapHandle)
    $ok = [CodexGdiCapture]::BitBlt($memoryDc, 0, 0, $CaptureBounds.Width, $CaptureBounds.Height, $sourceDc, $CaptureBounds.X, $CaptureBounds.Y, [CodexGdiCapture]::SRCCOPY -bor [CodexGdiCapture]::CAPTUREBLT)
    if (-not $ok) {
      throw 'GDI BitBlt 截图失败。'
    }
    $bitmap = [System.Drawing.Image]::FromHbitmap($bitmapHandle)
    try {
      Write-CaptureResult -Bitmap $bitmap -CaptureBounds $CaptureBounds
    } finally {
      $bitmap.Dispose()
    }
  } finally {
    if ($oldObject -ne [IntPtr]::Zero -and $memoryDc -ne [IntPtr]::Zero) {
      [CodexGdiCapture]::SelectObject($memoryDc, $oldObject) | Out-Null
    }
    if ($bitmapHandle -ne [IntPtr]::Zero) {
      [CodexGdiCapture]::DeleteObject($bitmapHandle) | Out-Null
    }
    if ($memoryDc -ne [IntPtr]::Zero) {
      [CodexGdiCapture]::DeleteDC($memoryDc) | Out-Null
    }
    [CodexGdiCapture]::ReleaseDC($desktopWindow, $sourceDc) | Out-Null
  }
}

try {
  Capture-WithCopyFromScreen -CaptureBounds $bounds
} catch {
  $copyError = $_.Exception.Message
  try {
    Capture-WithGdiBitBlt -CaptureBounds $bounds
  } catch {
    throw "桌面截图失败。CopyFromScreen: $copyError; GDI: $($_.Exception.Message)"
  }
}
`;

  const startedAt = Date.now();
  const stdout = await runPowerShell(script);
  const lineBreak = stdout.indexOf('\n');
  if (lineBreak < 0) {
    throw new Error('桌面截图返回格式异常。');
  }
  const sizeLine = stdout.slice(0, lineBreak).trim();
  const base64 = stdout.slice(lineBreak + 1).trim();
  if (base64.length === 0) {
    throw new Error('桌面截图内容为空。');
  }
  const match = sizeLine.match(/^(\d+)x(\d+)$/);
  const bytes = Buffer.from(base64, 'base64').length;

  return {
    mimeType: 'image/png',
    base64,
    bytes,
    width: match ? Number(match[1]) : null,
    height: match ? Number(match[2]) : null,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt
  };
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 32 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || '桌面截图失败').trim()));
          return;
        }
        resolve(stdout);
      }
    );
  });
}
