# Windows side of the leaderboard grabber: find the game window, capture it,
# and send wheel notches to it. Nothing else.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI, so UTF-8
# Chinese here would turn into mojibake and break the parser. Chinese docs live
# in scripts/rank-shot.js.
#
#   -Action list                          -> every visible top-level window + rect
#   -Action rect   -Title '<regex>'       -> "hwnd x y w h" for the client area
#   -Action shot   -Title '<regex>' -Out a.png [-Mode screen|gdi]
#   -Action capture -Title '<regex>' -OutDir d -MaxFrames 20 -Notches 3
#
# Why the client area and not the whole window: the layout coordinates (where
# each column is) get measured from the game content itself, so capturing the
# title bar would add a per-machine offset that changes with the theme.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('list', 'rect', 'shot', 'capture', 'wheel', 'drag', 'click', 'activate', 'info')]
  [string]$Action,
  [int]$X2 = -1,
  [int]$Y2 = -1,
  [int]$Steps = 12,
  [string]$Title = '',
  [string]$Out = '',
  [string]$OutDir = '',
  [ValidateSet('screen', 'gdi')][string]$Mode = 'screen',
  [int]$MaxFrames = 20,
  [int]$Notches = 3,
  [int]$SettleMs = 350,
  # -Watch: inject nothing, just keep shooting. The user scrolls, this keeps the
  # frames that changed. This path does not care about window integrity levels --
  # see the input-blocked block below.
  [switch]$Watch,
  [int]$IntervalMs = 1200,
  [int]$Seconds = 90,
  [int]$X = -1,
  [int]$Y = -1
)

$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class RankWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetFocus(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDC(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr t, int cls, ref int buf, int len, out int ret);
  [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint sid);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);

  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const int SW_RESTORE = 9;

  public static List<string> List() {
    var outp = new List<string>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      int n = GetWindowText(h, sb, sb.Capacity);
      if (n <= 0) return true;
      RECT w; GetWindowRect(h, out w);
      outp.Add(string.Format("{0}\t{1}\t{2},{3},{4},{5}",
        h.ToInt64(), sb.ToString(),
        w.Left, w.Top, w.Right - w.Left, w.Bottom - w.Top));
      return true;
    }, IntPtr.Zero);
    return outp;
  }

  public static IntPtr Find(string pattern) {
    var rx = new System.Text.RegularExpressions.Regex(pattern);
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      if (GetWindowText(h, sb, sb.Capacity) <= 0) return true;
      if (!rx.IsMatch(sb.ToString())) return true;
      found = h;              // keep the last match: the newest window wins
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // client-area rect in physical screen pixels
  public static int[] ClientRect(IntPtr h) {
    RECT c; GetClientRect(h, out c);
    var tl = new POINT(); tl.X = 0; tl.Y = 0;
    ClientToScreen(h, ref tl);
    return new int[] { tl.X, tl.Y, c.Right - c.Left, c.Bottom - c.Top };
  }

  public static bool Foreground(IntPtr h) { return GetForegroundWindow() == h; }

  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  // Elevated? TokenElevation = 20.
  static bool Elevated(IntPtr procToken) {
    int buf = 0, ret = 0;
    if (!GetTokenInformation(procToken, 20, ref buf, 4, out ret)) return false;
    return buf != 0;
  }
  static bool SelfElevated() {
    IntPtr t;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out t)) return false;   // TOKEN_QUERY
    bool e = Elevated(t);
    CloseHandle(t);
    return e;
  }
  static string ProcElevation(uint pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
    if (p == IntPtr.Zero) return "unknown(denied)";
    IntPtr t;
    string r = "unknown";
    if (OpenProcessToken(p, 0x0008, out t)) {
      r = Elevated(t) ? "elevated" : "normal";
      CloseHandle(t);
    }
    CloseHandle(p);
    return r;
  }

  // The thing that decides whether synthetic input reaches the game at all:
  // Windows UIPI drops injected input aimed at a window of a *higher* integrity
  // level. A game running as administrator therefore ignores mouse_event from a
  // normal terminal, silently: the window still focuses, nothing scrolls.
  public static string Info(IntPtr h) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    string name = "";
    try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { name = "?"; }
    return string.Format("pid={0} process={1} game={2} self={3}",
      pid, name, ProcElevation(pid), SelfElevated() ? "elevated" : "normal");
  }

  // Bring the game to the front *and* give it focus.
  //
  // SetForegroundWindow alone is refused by Windows unless the caller already
  // owns the foreground, which is exactly the case when this runs from a
  // terminal or from a chat window: the call silently does nothing, the screen
  // grab then captures whatever was in front (a video player, a chat), and the
  // wheel notches scroll *that* window instead of the game.
  // AttachThreadInput to the foreground thread is the documented way around it;
  // the topmost round-trip covers the rest (z-order without focus change).
  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint tid = GetWindowThreadProcessId(h, IntPtr.Zero);
    bool attached = fg != tid && AttachThreadInput(fg, tid, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    SetFocus(h);
    if (attached) AttachThreadInput(fg, tid, false);
    // Foreground lock: Windows lets a process take the foreground only if it
    // "has received input recently". Faking an ALT press counts as input and is
    // the standard way around the refusal (it is also why every remote-control
    // tool does this). Without it the grab below silently captures whatever the
    // user is looking at -- an SSH terminal, a video, a chat window.
    if (GetForegroundWindow() != h) {
      keybd_event(0x12, 0, 0, UIntPtr.Zero);          // ALT down
      SetForegroundWindow(h);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);          // ALT up
    }
    SetWindowPos(h, (IntPtr)(-1), 0, 0, 0, 0, 0x0001 | 0x0002);   // HWND_TOPMOST + NOSIZE/NOMOVE
    SetWindowPos(h, (IntPtr)(-2), 0, 0, 0, 0, 0x0001 | 0x0002);   // HWND_NOTOPMOST
    return GetForegroundWindow() == h;
  }

  public static void Shot(string path, IntPtr h, bool gdi) {
    int[] r = ClientRect(h);
    int w = r[2], hh = r[3];
    if (w <= 0 || hh <= 0) throw new Exception("client area is empty; is the window minimized?");
    using (var bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb)) {
      if (gdi) {
        // GetDC(h) is the *client* DC (GetWindowDC would start at the frame).
        // It survives being covered only when the game paints through GDI;
        // a D3D surface usually comes back as whatever is on screen, so the
        // window still has to be in front. -Mode screen is the honest default.
        IntPtr wdc = GetDC(h);
        using (var g = Graphics.FromImage(bmp)) {
          IntPtr ddc = g.GetHdc();
          BitBlt(ddc, 0, 0, w, hh, wdc, 0, 0, 0x00CC0020);
          g.ReleaseHdc(ddc);
        }
        ReleaseDC(h, wdc);
      } else {
        using (var g = Graphics.FromImage(bmp)) {
          // +8/+31: client rect origin already points inside the frame, so
          // CopyFromScreen at that origin grabs the client content directly.
          g.CopyFromScreen(r[0], r[1], 0, 0, new Size(w, hh), CopyPixelOperation.SourceCopy);
        }
      }
      bmp.Save(path, ImageFormat.Png);
    }
  }

  public static void Wheel(IntPtr h, int x, int y, int notches) {
    int[] r = ClientRect(h);
    int px = x >= 0 ? x : r[0] + r[2] / 2;
    int py = y >= 0 ? y : r[1] + r[3] / 2;
    SetCursorPos(px, py);
    System.Threading.Thread.Sleep(60);
    // positive notches scroll up; down = negative delta
    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, -120 * notches, UIntPtr.Zero);
  }

  // Drag the list: press, move in small steps, release. A wheel event is not
  // reliable on this client (measured 2026-10-18: 4 wheel notches moved 0 rows,
  // 12 moved 1, 36 and 90 moved nothing -- the game seems to clamp/throttle the
  // wheel delta). A drag is what the mobile-derived list actually expects.
  public static void Drag(IntPtr h, int x1, int y1, int x2, int y2, int steps) {
    int[] r = ClientRect(h);
    SetCursorPos(r[0] + x1, r[1] + y1);
    System.Threading.Thread.Sleep(90);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(70);
    for (int i = 1; i <= steps; i++) {
      SetCursorPos(r[0] + x1 + (x2 - x1) * i / steps, r[1] + y1 + (y2 - y1) * i / steps);
      System.Threading.Thread.Sleep(26);
    }
    System.Threading.Thread.Sleep(90);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }

  // x,y are CLIENT-relative pixels -- same space as the OCR boxes, so a button
  // found in a capture can be clicked with the coordinates it reported.
  public static void Click(IntPtr h, int x, int y) {
    int[] r = ClientRect(h);
    SetCursorPos(r[0] + x, r[1] + y);
    System.Threading.Thread.Sleep(80);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(50);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }
}
'@

[RankWin]::SetProcessDPIAware() | Out-Null

function Get-Target {
  $h = [RankWin]::Find($Title)
  if ($h -eq [IntPtr]::Zero) { throw "no visible window matches '$Title' (try -Action list)" }
  return $h
}

switch ($Action) {
  'list' {
    foreach ($line in [RankWin]::List()) { Write-Output $line }
  }
  'rect' {
    $h = Get-Target
    $r = [RankWin]::ClientRect($h)
    Write-Output ("{0} {1} {2} {3} {4}" -f $h.ToInt64(), $r[0], $r[1], $r[2], $r[3])
  }
  'info' {
    $h = Get-Target
    $line = [RankWin]::Info($h)
    if ($Out) { [System.IO.File]::WriteAllLines($Out, @($line), (New-Object System.Text.UTF8Encoding($false))) }
    else { Write-Output $line }
  }
  'click' {
    if ($X -lt 0 -or $Y -lt 0) { throw '-X and -Y are required (client-relative pixels)' }
    $h = Get-Target
    [RankWin]::Click($h, $X, $Y)
    Write-Output 'ok'
  }
  'drag' {
    if ($X -lt 0 -or $Y -lt 0 -or $X2 -lt 0 -or $Y2 -lt 0) { throw '-X -Y -X2 -Y2 are required (client-relative pixels)' }
    $h = Get-Target
    [RankWin]::Drag($h, $X, $Y, $X2, $Y2, $Steps)
    Write-Output 'ok'
  }
  'activate' {
    $h = Get-Target
    [RankWin]::Focus($h)
    Write-Output "ok"
  }
  'shot' {
    if (-not $Out) { throw '-Out <file.png> is required' }
    $h = Get-Target
    # Raise it first: this is a screen grab, so a covered window is captured as
    # whatever covers it. Fail instead of returning someone else's window as the
    # leaderboard.
    if (-not [RankWin]::Focus($h)) { throw 'can not bring the window to the foreground' }
    Start-Sleep -Milliseconds 180
    [RankWin]::Shot($Out, $h, ($Mode -eq 'gdi'))
    Write-Output $Out
  }
  'wheel' {
    $h = Get-Target
    [RankWin]::Wheel($h, $X, $Y, $Notches)
    Write-Output "ok"
  }
  'capture' {
    if (-not $OutDir) { throw '-OutDir <dir> is required' }
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $h = Get-Target
    $log = Join-Path $OutDir 'capture.log'
    $lines = New-Object System.Collections.Generic.List[string]
    $ok = [RankWin]::Focus($h)
    $lines.Add("focus=$(if ($ok) { 'ok' } else { 'refused' })")
    $lines.Add("target " + [RankWin]::Info($h))
    Start-Sleep -Milliseconds 250

    if ($Watch) {
      # Shoot only, inject nothing. The user scrolls; keep each frame that differs
      # from the previous one (identical frames are the same list position).
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $prev = ''
      $kept = 0
      while ($kept -lt $MaxFrames -and $sw.Elapsed.TotalSeconds -lt $Seconds) {
        $tmp = Join-Path $OutDir '_tmp.png'
        [RankWin]::Shot($tmp, $h, ($Mode -eq 'gdi'))
        $hash = (Get-FileHash $tmp -Algorithm SHA1).Hash
        if ($hash -eq $prev) { Remove-Item $tmp -Force; Start-Sleep -Milliseconds $IntervalMs; continue }
        $prev = $hash
        $kept++
        Move-Item $tmp (Join-Path $OutDir ('frame-{0:d2}.png' -f $kept)) -Force
        $lines.Add("frame $kept")
        Start-Sleep -Milliseconds $IntervalMs
      }
      $lines.Add("watch stop: kept=$kept")
      [System.IO.File]::WriteAllLines($log, $lines, (New-Object System.Text.UTF8Encoding($false)))
      Write-Output $log
      exit 0
    }

    # Whether injected input reaches the window depends on the *integrity level of
    # both sides*: Windows UIPI silently drops synthetic input sent to a window of
    # a higher integrity level. The window still comes to the front, the wheel
    # moves nothing, and nothing is reported. That is exactly this machine: the
    # game (com.bilibili.nslg) runs elevated, this tool does not. So ask first
    # instead of pretending to scroll.
    $info = [RankWin]::Info($h)
    $blocked = $MaxFrames -gt 1 -and ($info -match 'game=elevated') -and ($info -match 'self=normal')
    if ($blocked) {
      $lines.Add('input-blocked: game is elevated, this shell is not')
      [System.IO.File]::WriteAllLines($log, $lines, (New-Object System.Text.UTF8Encoding($false)))
      Write-Output $log
      exit 0
    }

    $prev = ''
    for ($i = 1; $i -le $MaxFrames; $i++) {
      # The capture is the screen and the wheel goes to the *focused* window:
      # if focus is lost, stop at once instead of scrolling something else.
      if (-not [RankWin]::Foreground($h)) { $lines.Add("lost-foreground at frame $i"); break }
      $f = Join-Path $OutDir ('frame-{0:d2}.png' -f $i)
      [RankWin]::Shot($f, $h, ($Mode -eq 'gdi'))
      $hash = (Get-FileHash $f -Algorithm SHA1).Hash
      $lines.Add("frame $i")
      if ($hash -eq $prev) { $lines.Add('stopped: identical frame'); break }
      $prev = $hash
      if ($i -lt $MaxFrames) {
        [RankWin]::Wheel($h, $X, $Y, $Notches)
        Start-Sleep -Milliseconds $SettleMs
      }
    }
    [System.IO.File]::WriteAllLines($log, $lines, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output $log
  }
}
