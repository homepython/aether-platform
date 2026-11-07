using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace AetherNativeHelper;

internal static class Program
{
    private static uint _parentPid;
    private static readonly object StdoutLock = new();
    private static TcpListener? _pcmServer;
    private static TcpClient? _pcmClient;
    private static NetworkStream? _pcmStream;
    private static IDisposable? _loopback;

    // Shortcut & PTT configuration
    private static volatile bool _pttEnabled;
    private static string _pttKey = "KeyV";
    private static Dictionary<string, string> _shortcuts = new();
    private static readonly HashSet<int> PressedVKeys = new();
    private static volatile bool _pttCurrentlyDown;

    public static void Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;

        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--parent-pid" && uint.TryParse(args[i + 1], out var pid))
            {
                _parentPid = pid;
            }
        }

        // Watch parent process lifetime so helper never orphans
        if (_parentPid != 0)
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    using var proc = Process.GetProcessById((int)_parentPid);
                    await proc.WaitForExitAsync();
                    Environment.Exit(0);
                }
                catch
                {
                    Environment.Exit(0);
                }
            });
        }

        // Disable Windows OS Communications Audio Ducking
        AudioAntiDucking.TryDisableOsDucking();

        // Immediately shield helper & Electron main process from Windows 11 EcoQoS / background timer throttling
        ProcessPriorityShield.DisablePowerAndTimerThrottling((uint)Environment.ProcessId);
        if (_parentPid != 0)
        {
            ProcessPriorityShield.DisablePowerAndTimerThrottling(_parentPid);
        }

        // Start dedicated localhost TCP binary stream for 48kHz Stereo Float32 PCM
        _pcmServer = new TcpListener(IPAddress.Loopback, 0);
        _pcmServer.Start();
        int pcmPort = ((IPEndPoint)_pcmServer.LocalEndpoint).Port;
        _ = Task.Run(AcceptPcmClientsLoop);

        // Start stdin JSON-RPC reader thread
        _ = Task.Run(ReadStdinLoop);

        EmitJson(new { type = "ready", pcmPort, parentPid = _parentPid });

        // Run Win32 Low-Level Input Hook Message Pump on main thread
        GlobalInputPump.Run(OnKeyOrMouseTransition);
    }

    private static async Task AcceptPcmClientsLoop()
    {
        while (_pcmServer != null)
        {
            try
            {
                var client = await _pcmServer.AcceptTcpClientAsync();
                client.NoDelay = true;
                _pcmClient?.Close();
                _pcmClient = client;
                _pcmStream = client.GetStream();
            }
            catch
            {
                break;
            }
        }
    }

    public static void SendPcmPacket(byte[] float32Bytes, int count)
    {
        var stream = _pcmStream;
        if (stream == null || count <= 0) return;
        try
        {
            Span<byte> header = stackalloc byte[4];
            BitConverter.TryWriteBytes(header, count);
            stream.Write(header);
            stream.Write(float32Bytes, 0, count);
        }
        catch
        {
            // Ignore broken client pipe
        }
    }

    public static void EmitJson(object payload)
    {
        string line = JsonSerializer.Serialize(payload);
        lock (StdoutLock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    private static async Task ReadStdinLoop()
    {
        string? line;
        while ((line = await Console.In.ReadLineAsync()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                string cmd = root.TryGetProperty("cmd", out var cmdEl) ? cmdEl.GetString() ?? "" : "";
                string reqId = root.TryGetProperty("reqId", out var idEl) ? idEl.GetString() ?? "" : "";

                switch (cmd)
                {
                    case "resolveHwndPid":
                    {
                        long hwnd = root.GetProperty("hwnd").GetInt64();
                        Win32Overlay.GetWindowThreadProcessId((IntPtr)hwnd, out uint pid);
                        EmitJson(new { type = "res", reqId, ok = true, pid });
                        break;
                    }

                    case "applyOverlayShield":
                    {
                        long hwnd = root.GetProperty("hwnd").GetInt64();
                        bool clickThrough = !root.TryGetProperty("clickThrough", out var ct) || ct.GetBoolean();
                        Win32Overlay.ApplyFocuslessOverlayStyles((IntPtr)hwnd, clickThrough);
                        EmitJson(new { type = "res", reqId, ok = true });
                        break;
                    }

                    case "configureShortcuts":
                    {
                        _pttEnabled = root.TryGetProperty("pttEnabled", out var pe) && pe.GetBoolean();
                        _pttKey = root.TryGetProperty("pttKey", out var pk) ? pk.GetString() ?? "KeyV" : "KeyV";
                        var nextMap = new Dictionary<string, string>();
                        if (root.TryGetProperty("shortcuts", out var sc) && sc.ValueKind == JsonValueKind.Object)
                        {
                            foreach (var prop in sc.EnumerateObject())
                            {
                                nextMap[prop.Name] = prop.Value.GetString() ?? "";
                            }
                        }
                        _shortcuts = nextMap;
                        EmitJson(new { type = "res", reqId, ok = true });
                        break;
                    }

                    case "listAudioSessions":
                    {
                        var sessions = AudioSessionInspector.ListActiveAudioApps(_parentPid);
                        EmitJson(new { type = "res", reqId, ok = true, sessions });
                        break;
                    }

                    case "startLoopback":
                    {
                        _loopback?.Dispose();
                        _loopback = null;

                        string mode = root.TryGetProperty("mode", out var m) ? m.GetString() ?? "exclude-self" : "exclude-self";

                        if (mode == "include-multi" &&
                            root.TryGetProperty("targetPids", out var pidsArr) &&
                            pidsArr.ValueKind == JsonValueKind.Array)
                        {
                            var selectedPids = new List<uint>();
                            foreach (var item in pidsArr.EnumerateArray())
                            {
                                if (item.TryGetUInt32(out uint p) && p > 0 && p != _parentPid && p != (uint)Environment.ProcessId && !selectedPids.Contains(p))
                                {
                                    selectedPids.Add(p);
                                }
                            }

                            if (selectedPids.Count == 1)
                            {
                                var single = new ProcessLoopbackEngine();
                                if (single.Start(selectedPids[0], true, out string? sErr))
                                {
                                    _loopback = single;
                                    EmitJson(new { type = "res", reqId, ok = true, mode = "include-process", effectivePid = selectedPids[0] });
                                }
                                else
                                {
                                    EmitJson(new { type = "res", reqId, ok = false, error = sErr ?? "Falha ao capturar áudio do aplicativo selecionado" });
                                }
                                break;
                            }
                            else if (selectedPids.Count >= 2)
                            {
                                var mixer = new MultiProcessLoopbackMixer();
                                if (mixer.Start(selectedPids.Take(8).ToList(), out string? mErr))
                                {
                                    _loopback = mixer;
                                    EmitJson(new { type = "res", reqId, ok = true, mode = "include-multi", count = selectedPids.Count });
                                }
                                else
                                {
                                    EmitJson(new { type = "res", reqId, ok = false, error = mErr ?? "Falha ao mixar múltiplos aplicativos" });
                                }
                                break;
                            }
                        }

                        uint targetPid = _parentPid;
                        if (mode == "include-process")
                        {
                            if (root.TryGetProperty("targetPid", out var tp) && tp.TryGetUInt32(out var explicitPid) && explicitPid > 0)
                            {
                                targetPid = ProcessTreeResolver.ResolveRootAppPid(explicitPid, _parentPid);
                            }
                            else if (root.TryGetProperty("targetHwnd", out var th) && th.TryGetInt64(out var hwndVal) && hwndVal != 0)
                            {
                                Win32Overlay.GetWindowThreadProcessId((IntPtr)hwndVal, out uint resolvedPid);
                                if (resolvedPid > 0) targetPid = ProcessTreeResolver.ResolveRootAppPid(resolvedPid, _parentPid);
                            }
                        }

                        bool includeOnlyTarget = mode == "include-process" && targetPid != 0 && targetPid != _parentPid;
                        uint effectivePid = includeOnlyTarget ? targetPid : (_parentPid != 0 ? _parentPid : (uint)Environment.ProcessId);

                        var engine = new ProcessLoopbackEngine();
                        bool started = engine.Start(effectivePid, includeOnlyTarget, out string? error);
                        if (started)
                        {
                            _loopback = engine;
                            EmitJson(new
                            {
                                type = "res",
                                reqId,
                                ok = true,
                                mode = includeOnlyTarget ? "include-process" : "exclude-self",
                                effectivePid
                            });
                        }
                        else
                        {
                            EmitJson(new { type = "res", reqId, ok = false, error = error ?? "WASAPI Process Loopback indisponível" });
                        }
                        break;
                    }

                    case "stopLoopback":
                    {
                        _loopback?.Dispose();
                        _loopback = null;
                        EmitJson(new { type = "res", reqId, ok = true });
                        break;
                    }

                    case "setBroadcastBoost":
                    {
                        bool active = root.TryGetProperty("active", out var actEl) && actEl.GetBoolean();
                        var normalPids = new List<uint> { (uint)Environment.ProcessId };
                        if (_parentPid != 0) normalPids.Add(_parentPid);
                        if (root.TryGetProperty("pids", out var pidsEl) && pidsEl.ValueKind == JsonValueKind.Array)
                        {
                            foreach (var item in pidsEl.EnumerateArray())
                            {
                                if (item.TryGetUInt32(out uint p) && p > 0 && !normalPids.Contains(p))
                                {
                                    normalPids.Add(p);
                                }
                            }
                        }

                        var highPriorityPids = new HashSet<uint> { (uint)Environment.ProcessId };
                        if (root.TryGetProperty("highPriorityPids", out var hpEl) && hpEl.ValueKind == JsonValueKind.Array)
                        {
                            foreach (var item in hpEl.EnumerateArray())
                            {
                                if (item.TryGetUInt32(out uint hp) && hp > 0)
                                {
                                    highPriorityPids.Add(hp);
                                    if (!normalPids.Contains(hp)) normalPids.Add(hp);
                                }
                            }
                        }

                        int boostedCount = ProcessPriorityShield.ApplyBroadcastBoost(active, normalPids, highPriorityPids);
                        EmitJson(new { type = "res", reqId, ok = true, active, boostedCount });
                        break;
                    }
                }
            }
            catch (Exception ex)
            {
                EmitJson(new { type = "log", level = "warn", message = ex.Message });
            }
        }
        Environment.Exit(0);
    }

    private static void OnKeyOrMouseTransition(string keyToken, int vkCode, bool isDown)
    {
        if (vkCode > 0)
        {
            if (isDown) PressedVKeys.Add(vkCode);
            else PressedVKeys.Remove(vkCode);
        }

        if (_pttEnabled && MatchesComboToken(keyToken, _pttKey, isDown))
        {
            if (isDown && !_pttCurrentlyDown)
            {
                _pttCurrentlyDown = true;
                EmitJson(new { type = "ptt", pressed = true });
            }
            else if (!isDown && _pttCurrentlyDown)
            {
                _pttCurrentlyDown = false;
                EmitJson(new { type = "ptt", pressed = false });
            }
        }
        else if (!isDown && _pttCurrentlyDown && ComboUsesToken(_pttKey, keyToken))
        {
            _pttCurrentlyDown = false;
            EmitJson(new { type = "ptt", pressed = false });
        }

        if (isDown)
        {
            foreach (var kv in _shortcuts)
            {
                if (kv.Key == "pushToTalk") continue;
                if (!string.IsNullOrEmpty(kv.Value) && MatchesComboToken(keyToken, kv.Value, true))
                {
                    EmitJson(new { type = "shortcut", action = kv.Key });
                }
            }
        }
    }

    private static bool ComboUsesToken(string combo, string token)
    {
        var parts = combo.Split('+', StringSplitOptions.RemoveEmptyEntries);
        foreach (var p in parts)
        {
            if (string.Equals(p, token, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static bool MatchesComboToken(string mainToken, string combo, bool isDown)
    {
        if (string.IsNullOrWhiteSpace(combo)) return false;
        var parts = combo.Split('+', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return false;
        string expectedMain = parts[^1];
        if (!string.Equals(expectedMain, mainToken, StringComparison.OrdinalIgnoreCase)) return false;

        if (!isDown) return true;

        bool needCtrl = Array.Exists(parts, p => p.Equals("Control", StringComparison.OrdinalIgnoreCase));
        bool needShift = Array.Exists(parts, p => p.Equals("Shift", StringComparison.OrdinalIgnoreCase));
        bool needAlt = Array.Exists(parts, p => p.Equals("Alt", StringComparison.OrdinalIgnoreCase));

        bool hasCtrl = PressedVKeys.Contains(0x11) || PressedVKeys.Contains(0xA2) || PressedVKeys.Contains(0xA3);
        bool hasShift = PressedVKeys.Contains(0x10) || PressedVKeys.Contains(0xA0) || PressedVKeys.Contains(0xA1);
        bool hasAlt = PressedVKeys.Contains(0x12) || PressedVKeys.Contains(0xA4) || PressedVKeys.Contains(0xA5);

        return needCtrl == hasCtrl && needShift == hasShift && needAlt == hasAlt;
    }
}

internal static class ProcessTreeResolver
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr hObject);

    public static Dictionary<uint, (uint ParentPid, string ExeName)> SnapshotProcesses()
    {
        var map = new Dictionary<uint, (uint, string)>();
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == INVALID_HANDLE_VALUE || snap == IntPtr.Zero) return map;
        try
        {
            var entry = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
            if (Process32FirstW(snap, ref entry))
            {
                do
                {
                    map[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile ?? "");
                } while (Process32NextW(snap, ref entry));
            }
        }
        finally
        {
            CloseHandle(snap);
        }
        return map;
    }

    public static bool BelongsToProcessTree(uint pid, uint rootTreePid, Dictionary<uint, (uint ParentPid, string ExeName)> map)
    {
        if (rootTreePid == 0) return false;
        uint cur = pid;
        int guard = 0;
        while (cur != 0 && guard++ < 24)
        {
            if (cur == rootTreePid) return true;
            if (!map.TryGetValue(cur, out var info) || info.ParentPid == cur) break;
            cur = info.ParentPid;
        }
        return false;
    }

    public static uint ResolveRootPidFromMap(uint pid, Dictionary<uint, (uint ParentPid, string ExeName)> map)
    {
        if (!map.TryGetValue(pid, out var startInfo)) return pid;
        string targetExe = startInfo.ExeName;
        uint root = pid;
        uint cur = pid;
        int guard = 0;
        while (guard++ < 16 && map.TryGetValue(cur, out var info))
        {
            if (info.ParentPid == 0 || info.ParentPid == cur) break;
            if (!map.TryGetValue(info.ParentPid, out var parentInfo)) break;
            if (string.Equals(parentInfo.ExeName, targetExe, StringComparison.OrdinalIgnoreCase))
            {
                root = info.ParentPid;
                cur = info.ParentPid;
            }
            else
            {
                break;
            }
        }
        return root;
    }

    public static uint ResolveRootAppPid(uint pid, uint aetherParentPid)
    {
        var map = SnapshotProcesses();
        if (BelongsToProcessTree(pid, aetherParentPid, map)) return aetherParentPid;
        return ResolveRootPidFromMap(pid, map);
    }
}

internal static class ProcessPriorityShield
{
    private const uint PROCESS_SET_INFORMATION = 0x0200;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const int ProcessPowerThrottling = 4;

    private const uint PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1;
    private const uint PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1;
    private const uint PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION = 0x4;

    private const uint NORMAL_PRIORITY_CLASS = 0x00000020;
    private const uint ABOVE_NORMAL_PRIORITY_CLASS = 0x00008000;
    private const uint HIGH_PRIORITY_CLASS = 0x00000080;

    private static volatile bool _timerPeriodActive;

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_POWER_THROTTLING_STATE
    {
        public uint Version;
        public uint ControlMask;
        public uint StateMask;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetProcessInformation(
        IntPtr hProcess,
        int ProcessInformationClass,
        ref PROCESS_POWER_THROTTLING_STATE ProcessInformation,
        int ProcessInformationSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetPriorityClass(IntPtr hProcess, uint dwPriorityClass);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("winmm.dll")]
    private static extern uint timeBeginPeriod(uint uPeriod);

    [DllImport("winmm.dll")]
    private static extern uint timeEndPeriod(uint uPeriod);

    public static bool DisablePowerAndTimerThrottling(uint pid)
    {
        if (pid == 0) return false;
        IntPtr hProc = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (hProc == IntPtr.Zero) return false;
        try
        {
            var state = new PROCESS_POWER_THROTTLING_STATE
            {
                Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION,
                ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION,
                StateMask = 0
            };
            bool ok1 = SetProcessInformation(
                hProc,
                ProcessPowerThrottling,
                ref state,
                Marshal.SizeOf<PROCESS_POWER_THROTTLING_STATE>());

            if (!ok1)
            {
                state.ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
                ok1 = SetProcessInformation(
                    hProc,
                    ProcessPowerThrottling,
                    ref state,
                    Marshal.SizeOf<PROCESS_POWER_THROTTLING_STATE>());
            }
            return ok1;
        }
        finally
        {
            CloseHandle(hProc);
        }
    }

    public static int ApplyBroadcastBoost(bool active, IReadOnlyList<uint> pids, HashSet<uint> highPriorityPids)
    {
        if (active && !_timerPeriodActive)
        {
            timeBeginPeriod(1);
            _timerPeriodActive = true;
        }
        else if (!active && _timerPeriodActive)
        {
            timeEndPeriod(1);
            _timerPeriodActive = false;
        }

        int count = 0;
        foreach (uint pid in pids)
        {
            if (pid == 0) continue;
            DisablePowerAndTimerThrottling(pid);
            uint targetPriority = !active
                ? NORMAL_PRIORITY_CLASS
                : (highPriorityPids.Contains(pid) ? HIGH_PRIORITY_CLASS : ABOVE_NORMAL_PRIORITY_CLASS);

            IntPtr hProc = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (hProc != IntPtr.Zero)
            {
                try
                {
                    if (SetPriorityClass(hProc, targetPriority)) count++;
                }
                finally
                {
                    CloseHandle(hProc);
                }
            }
        }
        return count;
    }
}

internal static class Win32Overlay
{
    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_LAYERED = 0x00080000L;
    private const long WS_EX_TRANSPARENT = 0x00000020L;
    private const long WS_EX_TOPMOST = 0x00000008L;
    private const long WS_EX_TOOLWINDOW = 0x00000080L;
    private const long WS_EX_NOACTIVATE = 0x08000000L;

    private static readonly IntPtr HWND_TOPMOST = new(-1);
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_FRAMECHANGED = 0x0020;

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public static void ApplyFocuslessOverlayStyles(IntPtr hwnd, bool clickThrough)
    {
        if (hwnd == IntPtr.Zero) return;
        long style = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        style |= WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
        if (clickThrough) style |= WS_EX_TRANSPARENT;
        else style &= ~WS_EX_TRANSPARENT;

        SetWindowLongPtr(hwnd, GWL_EXSTYLE, (IntPtr)style);
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }
}

internal static class GlobalInputPump
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const int WM_XBUTTONDOWN = 0x020B;
    private const int WM_XBUTTONUP = 0x020C;

    private delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);
    private static LowLevelProc? _kbProc;
    private static LowLevelProc? _mouseProc;
    private static Action<string, int, bool>? _callback;

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public int ptX;
        public int ptY;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int pt_x;
        public int pt_y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    public static void Run(Action<string, int, bool> onTransition)
    {
        _callback = onTransition;
        _kbProc = KeyboardHookCallback;
        _mouseProc = MouseHookCallback;

        IntPtr hMod = GetModuleHandle(null);
        SetWindowsHookEx(WH_KEYBOARD_LL, _kbProc, hMod, 0);
        SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, hMod, 0);

        while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }

    private static IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = wParam.ToInt32();
            bool isDown = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            bool isUp = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if (isDown || isUp)
            {
                var info = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
                string token = VkToDomCode((int)info.vkCode);
                if (!string.IsNullOrEmpty(token))
                {
                    _callback?.Invoke(token, (int)info.vkCode, isDown);
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = wParam.ToInt32();
            if (msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP)
            {
                var info = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
                uint xButton = (info.mouseData >> 16) & 0xFFFF;
                string token = xButton == 1 ? "Mouse4" : xButton == 2 ? "Mouse5" : "";
                if (!string.IsNullOrEmpty(token))
                {
                    _callback?.Invoke(token, 0, msg == WM_XBUTTONDOWN);
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static string VkToDomCode(int vk)
    {
        if (vk >= 'A' && vk <= 'Z') return $"Key{(char)vk}";
        if (vk >= '0' && vk <= '9') return $"Digit{(char)vk}";
        if (vk >= 0x70 && vk <= 0x7B) return $"F{vk - 0x6F}";
        return vk switch
        {
            0x20 => "Space",
            0x09 => "Tab",
            0x14 => "CapsLock",
            0xC0 => "Backquote",
            0x10 or 0xA0 or 0xA1 => "Shift",
            0x11 or 0xA2 or 0xA3 => "Control",
            0x12 or 0xA4 or 0xA5 => "Alt",
            _ => ""
        };
    }
}

/// <summary>
/// Enumerates real Windows WASAPI Audio Render Sessions (Spotify, Chrome, Fortnite, VLC, etc.)
/// with live peak meter level, resolving child utility PIDs to their root application PID and excluding Aether.
/// </summary>
internal static class AudioSessionInspector
{
    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);

    public sealed class AudioAppSessionDto
    {
        public uint pid { get; set; }
        public string processName { get; set; } = "";
        public string displayName { get; set; } = "";
        public float peak { get; set; }
        public bool isPlaying { get; set; }
    }

    public static List<AudioAppSessionDto> ListActiveAudioApps(uint aetherParentPid)
    {
        var resultsByRootPid = new Dictionary<uint, AudioAppSessionDto>();
        try
        {
            CoInitializeEx(IntPtr.Zero, 0);
            var procMap = ProcessTreeResolver.SnapshotProcesses();

            var clsidEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
            var enumeratorType = Type.GetTypeFromCLSID(clsidEnumerator);
            if (enumeratorType == null) return new List<AudioAppSessionDto>();

            if (Activator.CreateInstance(enumeratorType) is not AudioComInterfaces.IMMDeviceEnumerator devEnum)
                return new List<AudioAppSessionDto>();

            if (devEnum.GetDefaultAudioEndpoint(0, 1, out var device) != 0 || device == null)
            {
                if (devEnum.GetDefaultAudioEndpoint(0, 0, out device) != 0 || device == null)
                    return new List<AudioAppSessionDto>();
            }

            var iidMgr2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
            if (device.Activate(ref iidMgr2, 0x17, IntPtr.Zero, out var mgrObj) != 0 ||
                mgrObj is not AudioComInterfaces.IAudioSessionManager2 mgr2)
            {
                return new List<AudioAppSessionDto>();
            }

            if (mgr2.GetSessionEnumerator(out var sessionEnum) != 0 || sessionEnum == null)
                return new List<AudioAppSessionDto>();

            if (sessionEnum.GetCount(out int sessionCount) != 0 || sessionCount <= 0)
                return new List<AudioAppSessionDto>();

            for (int i = 0; i < sessionCount; i++)
            {
                if (sessionEnum.GetSession(i, out var sessionObj) != 0 || sessionObj == null)
                    continue;

                if (sessionObj is not AudioComInterfaces.IAudioSessionControl2 ctrl2)
                    continue;

                // Skip Windows system ding sounds session
                if (ctrl2.IsSystemSoundsSession() == 0)
                    continue;

                if (ctrl2.GetProcessId(out uint rawPid) != 0 || rawPid == 0)
                    continue;

                if (rawPid == (uint)Environment.ProcessId ||
                    ProcessTreeResolver.BelongsToProcessTree(rawPid, aetherParentPid, procMap))
                {
                    continue;
                }

                // State: 0 = Inactive, 1 = Active, 2 = Expired
                ctrl2.GetState(out int state);
                if (state == 2) continue;

                float peak = 0f;
                if (sessionObj is AudioComInterfaces.IAudioMeterInformation meter)
                {
                    meter.GetPeakValue(out peak);
                }

                uint rootPid = ProcessTreeResolver.ResolveRootPidFromMap(rawPid, procMap);
                if (rootPid == 0 || rootPid == aetherParentPid) continue;

                string procName = "";
                string friendlyTitle = "";
                try
                {
                    using var rootProc = Process.GetProcessById((int)rootPid);
                    procName = rootProc.ProcessName;
                    friendlyTitle = rootProc.MainWindowTitle ?? "";
                }
                catch
                {
                    if (procMap.TryGetValue(rootPid, out var pInfo))
                    {
                        procName = Path.GetFileNameWithoutExtension(pInfo.ExeName);
                    }
                }

                if (string.IsNullOrWhiteSpace(procName)) continue;

                ctrl2.GetDisplayName(out string sessionLabel);
                string bestLabel = !string.IsNullOrWhiteSpace(friendlyTitle)
                    ? friendlyTitle.Trim()
                    : (!string.IsNullOrWhiteSpace(sessionLabel) && !sessionLabel.StartsWith("@%")
                        ? sessionLabel.Trim()
                        : FormatProcessDisplayName(procName));

                bool isPlaying = state == 1 || peak > 0.0005f;

                if (resultsByRootPid.TryGetValue(rootPid, out var existing))
                {
                    if (peak > existing.peak) existing.peak = peak;
                    if (isPlaying) existing.isPlaying = true;
                }
                else
                {
                    resultsByRootPid[rootPid] = new AudioAppSessionDto
                    {
                        pid = rootPid,
                        processName = procName,
                        displayName = bestLabel,
                        peak = MathF.Round(peak, 4),
                        isPlaying = isPlaying
                    };
                }
            }
        }
        catch
        {
            // Ignore transient WASAPI session enumeration errors
        }

        return resultsByRootPid.Values
            .OrderByDescending(s => s.isPlaying)
            .ThenByDescending(s => s.peak)
            .ThenBy(s => s.displayName, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static string FormatProcessDisplayName(string rawName)
    {
        if (string.IsNullOrWhiteSpace(rawName)) return "Aplicativo";
        return char.ToUpperInvariant(rawName[0]) + rawName[1..];
    }
}

internal static class AudioAntiDucking
{
    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);

    public static void TryDisableOsDucking()
    {
        try
        {
            CoInitializeEx(IntPtr.Zero, 0);
            var clsidEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
            var enumeratorType = Type.GetTypeFromCLSID(clsidEnumerator);
            if (enumeratorType == null) return;

            var enumeratorObj = Activator.CreateInstance(enumeratorType);
            if (enumeratorObj is not AudioComInterfaces.IMMDeviceEnumerator enumerator) return;

            for (int role = 0; role <= 1; role++)
            {
                if (enumerator.GetDefaultAudioEndpoint(0, role, out var device) == 0 && device != null)
                {
                    var iidSessionMgr2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
                    if (device.Activate(ref iidSessionMgr2, 0x17, IntPtr.Zero, out var mgrObj) == 0 &&
                        mgrObj is AudioComInterfaces.IAudioSessionManager2 mgr)
                    {
                        if (mgr.GetAudioSessionControl(IntPtr.Zero, 0, out var ctrlObj) == 0 &&
                            ctrlObj is AudioComInterfaces.IAudioSessionControl2 ctrl2)
                        {
                            ctrl2.SetDuckingPreference(true);
                        }
                    }
                }
            }
        }
        catch
        {
            // Non-fatal on headless/virtual audio systems
        }
    }
}

internal static class AudioComInterfaces
{
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, uint dwStateMask, out IntPtr ppDevices);
        [PreserveSig]
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice? ppEndpoint);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        [PreserveSig]
        int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object? ppInterface);
    }

    // Exact Windows SDK IAudioSessionManager2 vtable layout (inherits IAudioSessionManager)
    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionManager2
    {
        [PreserveSig]
        int GetAudioSessionControl(IntPtr AudioSessionGuid, uint StreamFlags, [MarshalAs(UnmanagedType.IUnknown)] out object? SessionControl);
        [PreserveSig]
        int GetSimpleAudioVolume(IntPtr AudioSessionGuid, uint StreamFlags, [MarshalAs(UnmanagedType.IUnknown)] out object? AudioVolume);
        [PreserveSig]
        int GetSessionEnumerator(out IAudioSessionEnumerator? SessionEnum);
        [PreserveSig]
        int RegisterSessionNotification(IntPtr SessionNotification);
        [PreserveSig]
        int UnregisterSessionNotification(IntPtr SessionNotification);
        [PreserveSig]
        int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionID, IntPtr duckNotification);
        [PreserveSig]
        int UnregisterDuckNotification(IntPtr duckNotification);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionEnumerator
    {
        [PreserveSig]
        int GetCount(out int SessionCount);
        [PreserveSig]
        int GetSession(int SessionCount, [MarshalAs(UnmanagedType.IUnknown)] out object? Session);
    }

    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionControl2
    {
        [PreserveSig]
        int GetState(out int pRetVal);
        [PreserveSig]
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig]
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
        [PreserveSig]
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig]
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
        [PreserveSig]
        int GetGroupingParam(out Guid pRetVal);
        [PreserveSig]
        int SetGroupingParam(ref Guid Override, ref Guid EventContext);
        [PreserveSig]
        int RegisterAudioSessionNotification(IntPtr NewNotifications);
        [PreserveSig]
        int UnregisterAudioSessionNotification(IntPtr NewNotifications);
        [PreserveSig]
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig]
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig]
        int GetProcessId(out uint pRetVal);
        [PreserveSig]
        int IsSystemSoundsSession();
        [PreserveSig]
        int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioMeterInformation
    {
        [PreserveSig]
        int GetPeakValue(out float pfPeak);
    }
}

/// <summary>
/// Mixes 2..8 simultaneous WASAPI Process-Isolated Loopback streams (e.g., Spotify + Fortnite)
/// into a single 48000 Hz Stereo Float32 broadcast stream with soft-knee headroom protection.
/// Local user audio remains 100% untouched while stream viewers hear ONLY the selected apps!
/// </summary>
internal sealed class MultiProcessLoopbackMixer : IDisposable
{
    private const int BatchFloats = 960 * 2; // 20ms @ 48kHz Stereo = 1920 floats = 7680 bytes
    private readonly List<ProcessLoopbackEngine> _channels = new();
    private readonly List<ChannelFloatRing> _rings = new();
    private volatile bool _running;
    private Thread? _mixThread;

    private sealed class ChannelFloatRing
    {
        private readonly float[] _buf = new float[48000 * 2]; // 1s stereo ring
        private int _readIdx;
        private int _writeIdx;
        private int _count;
        private readonly object _gate = new();

        public void WriteBytes(byte[] bytes, int byteCount)
        {
            int floatCount = byteCount / 4;
            if (floatCount <= 0) return;
            Span<float> src = MemoryMarshal.Cast<byte, float>(bytes.AsSpan(0, floatCount * 4));
            lock (_gate)
            {
                for (int i = 0; i < src.Length; i++)
                {
                    _buf[_writeIdx] = src[i];
                    _writeIdx = (_writeIdx + 1) % _buf.Length;
                    if (_count < _buf.Length)
                    {
                        _count++;
                    }
                    else
                    {
                        _readIdx = (_readIdx + 1) % _buf.Length;
                    }
                }
            }
        }

        public int ReadAndAddInto(Span<float> mixAccum)
        {
            lock (_gate)
            {
                int avail = Math.Min(_count, mixAccum.Length);
                for (int i = 0; i < avail; i++)
                {
                    mixAccum[i] += _buf[_readIdx];
                    _readIdx = (_readIdx + 1) % _buf.Length;
                }
                _count -= avail;
                return avail;
            }
        }
    }

    public bool Start(IReadOnlyList<uint> targetPids, out string? error)
    {
        error = null;
        int startedCount = 0;

        foreach (uint pid in targetPids)
        {
            var ring = new ChannelFloatRing();
            var ch = new ProcessLoopbackEngine(ring.WriteBytes);
            if (ch.Start(pid, true, out string? chErr))
            {
                _rings.Add(ring);
                _channels.Add(ch);
                startedCount++;
            }
            else
            {
                error = chErr;
                ch.Dispose();
            }
        }

        if (startedCount == 0)
        {
            Dispose();
            return false;
        }

        _running = true;
        _mixThread = new Thread(MixLoop)
        {
            IsBackground = true,
            Priority = ThreadPriority.Highest
        };
        _mixThread.Start();
        return true;
    }

    private void MixLoop()
    {
        float[] mixFloats = new float[BatchFloats];
        byte[] outBytes = new byte[BatchFloats * 4];
        var sw = Stopwatch.StartNew();
        long nextTickMs = 20;

        while (_running)
        {
            long nowMs = sw.ElapsedMilliseconds;
            if (nowMs < nextTickMs)
            {
                int waitMs = (int)(nextTickMs - nowMs);
                if (waitMs > 1) Thread.Sleep(waitMs - 1);
                while (_running && sw.ElapsedMilliseconds < nextTickMs)
                {
                    Thread.SpinWait(64);
                }
            }
            nextTickMs += 20;
            if (sw.ElapsedMilliseconds - nextTickMs > 80)
            {
                nextTickMs = sw.ElapsedMilliseconds + 20;
            }

            Array.Clear(mixFloats, 0, mixFloats.Length);
            int maxRead = 0;
            for (int c = 0; c < _rings.Count; c++)
            {
                int r = _rings[c].ReadAndAddInto(mixFloats);
                if (r > maxRead) maxRead = r;
            }

            if (maxRead > 0)
            {
                // Transparent soft-limiter above -0.5 dBFS prevents multi-app sum clipping
                for (int i = 0; i < BatchFloats; i++)
                {
                    float v = mixFloats[i];
                    if (v > 0.94f || v < -0.94f)
                    {
                        mixFloats[i] = MathF.Tanh(v);
                    }
                }
                Buffer.BlockCopy(mixFloats, 0, outBytes, 0, outBytes.Length);
                Program.SendPcmPacket(outBytes, outBytes.Length);
            }
        }
    }

    public void Dispose()
    {
        _running = false;
        if (_mixThread != null && _mixThread.IsAlive)
        {
            _mixThread.Join(300);
        }
        _mixThread = null;
        foreach (var ch in _channels)
        {
            ch.Dispose();
        }
        _channels.Clear();
        _rings.Clear();
    }
}

/// <summary>
/// Windows 10 (Build 20348+) / Windows 11 WASAPI Process-Isolated Loopback Audio Engine.
/// </summary>
internal sealed unsafe class ProcessLoopbackEngine : IDisposable
{
    private const string VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback";
    private const uint AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
    private const uint PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0;
    private const uint PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1;

    private const uint AUDCLNT_SHAREMODE_SHARED = 0;
    private const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    private const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    private const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
    private const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
    private const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

    private readonly Action<byte[], int> _sink;
    private volatile bool _running;
    private Thread? _captureThread;
    private ManualResetEventSlim? _stopSignal;

    public ProcessLoopbackEngine(Action<byte[], int>? customSink = null)
    {
        _sink = customSink ?? Program.SendPcmPacket;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
    {
        public uint TargetProcessId;
        public uint ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AUDIOCLIENT_ACTIVATION_PARAMS
    {
        public uint ActivationType;
        public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BLOB
    {
        public uint cbSize;
        public IntPtr pBlobData;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROPVARIANT_BLOB
    {
        public ushort vt;
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public BLOB blob;
        public long padding;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [DllImport("mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
    private static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid riid,
        ref PROPVARIANT_BLOB activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IntPtr activationOperation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateEventW(IntPtr lpEventAttributes, bool bManualReset, bool bInitialState, IntPtr lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("avrt.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr AvSetMmThreadCharacteristicsW(string TaskName, out uint TaskIndex);

    [DllImport("avrt.dll")]
    private static extern bool AvRevertMmThreadCharacteristics(IntPtr AvrtHandle);

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig]
        int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig]
        int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object? activatedInterface);
    }

    [ComVisible(true)]
    private sealed class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly TaskCompletionSource<object?> Tcs = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation)
        {
            int hr = activateOperation.GetActivateResult(out int activateHr, out object? iface);
            if (hr < 0) Tcs.TrySetException(Marshal.GetExceptionForHR(hr)!);
            else if (activateHr < 0) Tcs.TrySetException(Marshal.GetExceptionForHR(activateHr)!);
            else Tcs.TrySetResult(iface);
            return 0;
        }
    }

    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAgileObject { }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig]
        int Initialize(uint ShareMode, uint StreamFlags, long hnsBufferDuration, long hnsPeriodicity, ref WAVEFORMATEX pFormat, IntPtr AudioSessionGuid);
        [PreserveSig]
        int GetBufferSize(out uint pNumBufferFrames);
        [PreserveSig]
        int GetStreamLatency(out long phnsLatency);
        [PreserveSig]
        int GetCurrentPadding(out uint pNumPaddingFrames);
        [PreserveSig]
        int IsFormatSupported(uint ShareMode, ref WAVEFORMATEX pFormat, IntPtr ppClosestMatch);
        [PreserveSig]
        int GetMixFormat(out IntPtr ppDeviceFormat);
        [PreserveSig]
        int GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);
        [PreserveSig]
        int Start();
        [PreserveSig]
        int Stop();
        [PreserveSig]
        int Reset();
        [PreserveSig]
        int SetEventHandle(IntPtr eventHandle);
        [PreserveSig]
        int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object? ppv);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig]
        int GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);
        [PreserveSig]
        int ReleaseBuffer(uint NumFramesRead);
        [PreserveSig]
        int GetNextPacketSize(out uint pNumFramesInNextPacket);
    }

    public bool Start(uint targetPid, bool includeOnlyTarget, out string? error)
    {
        error = null;
        try
        {
            var readySignal = new ManualResetEventSlim(false);
            string? threadErr = null;
            bool ok = false;

            _stopSignal = new ManualResetEventSlim(false);
            _running = true;

            _captureThread = new Thread(() =>
            {
                IntPtr sampleEvent = IntPtr.Zero;
                IntPtr paramsMem = IntPtr.Zero;
                IntPtr mmcssHandle = IntPtr.Zero;
                IAudioClient? audioClient = null;
                try
                {
                    mmcssHandle = AvSetMmThreadCharacteristicsW("Pro Audio", out _);
                    var activationParams = new AUDIOCLIENT_ACTIVATION_PARAMS
                    {
                        ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                        ProcessLoopbackParams = new AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
                        {
                            TargetProcessId = targetPid,
                            ProcessLoopbackMode = includeOnlyTarget
                                ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                                : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                        }
                    };

                    int size = Marshal.SizeOf<AUDIOCLIENT_ACTIVATION_PARAMS>();
                    paramsMem = Marshal.AllocCoTaskMem(size);
                    Marshal.StructureToPtr(activationParams, paramsMem, false);

                    var propVar = new PROPVARIANT_BLOB
                    {
                        vt = 65,
                        blob = new BLOB { cbSize = (uint)size, pBlobData = paramsMem }
                    };

                    var iidAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
                    var handler = new CompletionHandler();

                    int hr = ActivateAudioInterfaceAsync(
                        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                        ref iidAudioClient,
                        ref propVar,
                        handler,
                        out _);

                    if (hr < 0) Marshal.ThrowExceptionForHR(hr);

                    if (!handler.Tcs.Task.Wait(3000))
                    {
                        throw new TimeoutException("Tempo limite na ativação WASAPI Process Loopback");
                    }

                    audioClient = (IAudioClient?)handler.Tcs.Task.Result
                        ?? throw new InvalidOperationException("IAudioClient nulo");

                    var fmt = new WAVEFORMATEX
                    {
                        wFormatTag = 3,
                        nChannels = 2,
                        nSamplesPerSec = 48000,
                        wBitsPerSample = 32,
                        nBlockAlign = 8,
                        nAvgBytesPerSec = 48000 * 8,
                        cbSize = 0
                    };

                    uint flags = AUDCLNT_STREAMFLAGS_LOOPBACK |
                                 AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                 AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                                 AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

                    int initHr = audioClient.Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        flags,
                        200_000,
                        0,
                        ref fmt,
                        IntPtr.Zero);

                    if (initHr < 0) Marshal.ThrowExceptionForHR(initHr);

                    sampleEvent = CreateEventW(IntPtr.Zero, false, false, IntPtr.Zero);
                    audioClient.SetEventHandle(sampleEvent);

                    var iidCapture = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
                    int svcHr = audioClient.GetService(ref iidCapture, out var capObj);
                    if (svcHr < 0 || capObj is not IAudioCaptureClient captureClient)
                    {
                        throw new InvalidOperationException("Falha ao obter IAudioCaptureClient");
                    }

                    int startHr = audioClient.Start();
                    if (startHr < 0) Marshal.ThrowExceptionForHR(startHr);

                    ok = true;
                    readySignal.Set();

                    const int TargetBatchBytes = 960 * 8;
                    byte[] batchBuffer = new byte[TargetBatchBytes * 4];
                    int batchFilled = 0;

                    while (_running && !(_stopSignal?.IsSet ?? true))
                    {
                        uint waitRes = WaitForSingleObject(sampleEvent, 20);
                        bool readAny = false;

                        while (captureClient.GetNextPacketSize(out uint packetFrames) == 0 && packetFrames > 0)
                        {
                            if (captureClient.GetBuffer(out IntPtr dataPtr, out uint framesRead, out uint bufFlags, out _, out _) == 0)
                            {
                                readAny = true;
                                int byteCount = (int)(framesRead * 8);
                                int srcOffset = 0;
                                bool isSilent = (bufFlags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;

                                while (byteCount > 0)
                                {
                                    int space = batchBuffer.Length - batchFilled;
                                    if (space <= 0)
                                    {
                                        _sink(batchBuffer, batchFilled);
                                        batchFilled = 0;
                                        space = batchBuffer.Length;
                                    }

                                    int toCopy = Math.Min(byteCount, space);
                                    if (isSilent)
                                    {
                                        Array.Clear(batchBuffer, batchFilled, toCopy);
                                    }
                                    else
                                    {
                                        Marshal.Copy(IntPtr.Add(dataPtr, srcOffset), batchBuffer, batchFilled, toCopy);
                                    }

                                    batchFilled += toCopy;
                                    srcOffset += toCopy;
                                    byteCount -= toCopy;

                                    while (batchFilled >= TargetBatchBytes)
                                    {
                                        _sink(batchBuffer, TargetBatchBytes);
                                        int remaining = batchFilled - TargetBatchBytes;
                                        if (remaining > 0)
                                        {
                                            Buffer.BlockCopy(batchBuffer, TargetBatchBytes, batchBuffer, 0, remaining);
                                        }
                                        batchFilled = remaining;
                                    }
                                }
                                captureClient.ReleaseBuffer(framesRead);
                            }
                            else
                            {
                                break;
                            }
                        }

                        if (!readAny && waitRes != 0 && batchFilled > 0)
                        {
                            _sink(batchBuffer, batchFilled);
                            batchFilled = 0;
                        }
                    }

                    if (batchFilled > 0)
                    {
                        _sink(batchBuffer, batchFilled);
                    }

                    audioClient.Stop();
                }
                catch (Exception ex)
                {
                    threadErr = ex.Message;
                    readySignal.Set();
                }
                finally
                {
                    if (mmcssHandle != IntPtr.Zero) AvRevertMmThreadCharacteristics(mmcssHandle);
                    if (paramsMem != IntPtr.Zero) Marshal.FreeCoTaskMem(paramsMem);
                    if (sampleEvent != IntPtr.Zero) CloseHandle(sampleEvent);
                }
            })
            {
                IsBackground = true,
                Priority = ThreadPriority.Highest
            };
            _captureThread.SetApartmentState(ApartmentState.MTA);
            _captureThread.Start();

            readySignal.Wait(4000);
            if (!ok)
            {
                error = threadErr ?? "Falha ao iniciar captura isolada WASAPI";
                Stop();
                return false;
            }
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    public void Stop()
    {
        _running = false;
        _stopSignal?.Set();
        if (_captureThread != null && _captureThread.IsAlive)
        {
            _captureThread.Join(500);
        }
        _captureThread = null;
    }

    public void Dispose()
    {
        Stop();
    }
}
