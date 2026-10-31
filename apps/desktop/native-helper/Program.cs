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
    private static ProcessLoopbackEngine? _loopback;

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

                    case "startLoopback":
                    {
                        _loopback?.Stop();
                        _loopback = null;

                        string mode = root.TryGetProperty("mode", out var m) ? m.GetString() ?? "exclude-self" : "exclude-self";
                        uint targetPid = _parentPid;
                        if (mode == "include-process")
                        {
                            if (root.TryGetProperty("targetPid", out var tp) && tp.TryGetUInt32(out var explicitPid) && explicitPid > 0)
                            {
                                targetPid = explicitPid;
                            }
                            else if (root.TryGetProperty("targetHwnd", out var th) && th.TryGetInt64(out var hwndVal) && hwndVal != 0)
                            {
                                Win32Overlay.GetWindowThreadProcessId((IntPtr)hwndVal, out uint resolvedPid);
                                if (resolvedPid > 0) targetPid = resolvedPid;
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
                        _loopback?.Stop();
                        _loopback = null;
                        EmitJson(new { type = "res", reqId, ok = true });
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

        // Check Push-To-Talk (supports single key, modifier combo, or Mouse4/Mouse5 without blocking games!)
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

        // Check Discrete Action Shortcuts on keydown
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
        // Always pass through immediately so games NEVER lose the key press!
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
/// Opts out of Windows Core Audio Communications Ducking (IAudioSessionControl2::SetDuckingPreference(TRUE)).
/// Ensures music, games, movies and live streams NEVER drop in volume when voice starts.
/// </summary>
internal static class AudioAntiDucking
{
    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);

    public static void TryDisableOsDucking()
    {
        try
        {
            CoInitializeEx(IntPtr.Zero, 0); // COINIT_MULTITHREADED
            var clsidEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
            var enumeratorType = Type.GetTypeFromCLSID(clsidEnumerator);
            if (enumeratorType == null) return;

            var enumeratorObj = Activator.CreateInstance(enumeratorType);
            if (enumeratorObj is not IMMDeviceEnumerator enumerator) return;

            // eRender = 0, eConsole = 0, eMultimedia = 1
            for (int role = 0; role <= 1; role++)
            {
                if (enumerator.GetDefaultAudioEndpoint(0, role, out var device) == 0 && device != null)
                {
                    var iidSessionMgr2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
                    if (device.Activate(ref iidSessionMgr2, 0x17, IntPtr.Zero, out var mgrObj) == 0 &&
                        mgrObj is IAudioSessionManager2 mgr)
                    {
                        if (mgr.GetAudioSessionControl(IntPtr.Zero, 0, out var ctrlObj) == 0 &&
                            ctrlObj is IAudioSessionControl2 ctrl2)
                        {
                            ctrl2.SetDuckingPreference(true); // TRUE = opt out of Windows ducking!
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

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, uint dwStateMask, out IntPtr ppDevices);
        [PreserveSig]
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice? ppEndpoint);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig]
        int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object? ppInterface);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2
    {
        [PreserveSig]
        int GetAudioSessionControl(IntPtr AudioSessionGuid, uint StreamFlags, [MarshalAs(UnmanagedType.IUnknown)] out object? SessionControl);
    }

    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2
    {
        int GetState(out int pRetVal);
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
        int GetGroupingParam(out Guid pRetVal);
        int SetGroupingParam(ref Guid Override, ref Guid EventContext);
        int RegisterAudioSessionNotification(IntPtr NewNotifications);
        int UnregisterAudioSessionNotification(IntPtr NewNotifications);
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int GetProcessId(out uint pRetVal);
        int IsSystemSoundsSession();
        [PreserveSig]
        int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }
}

/// <summary>
/// Windows 10 (Build 20348+) / Windows 11 WASAPI Process-Isolated Loopback Audio Engine.
/// Uses ActivateAudioInterfaceAsync("VAD\\Process_Loopback") with AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS:
/// - EXCLUDE_TARGET_PROCESS_TREE (1): Captures ALL desktop audio EXCEPT Aether's voice process tree!
/// - INCLUDE_TARGET_PROCESS_TREE (0): Captures ONLY the target game/window's process tree!
/// Outputs exact 48000 Hz Stereo Float32 PCM frames with zero voice loopback!
/// </summary>
internal sealed unsafe class ProcessLoopbackEngine
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

    private volatile bool _running;
    private Thread? _captureThread;
    private ManualResetEventSlim? _stopSignal;

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
        public ushort vt; // VT_BLOB = 65
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public BLOB blob;
        public long padding;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct WAVEFORMATEX
    {
        public ushort wFormatTag; // WAVE_FORMAT_IEEE_FLOAT = 3
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

    // Agile free-threaded completion handler (implements IAgileObject so WASAPI invokes from MTA worker without proxy marshaling issues)
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
                IAudioClient? audioClient = null;
                try
                {
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
                        vt = 65, // VT_BLOB
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

                    // 48000 Hz, 2 channels (Stereo), 32-bit IEEE Float
                    var fmt = new WAVEFORMATEX
                    {
                        wFormatTag = 3, // WAVE_FORMAT_IEEE_FLOAT
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
                        200_000, // 20ms low-latency buffer
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

                    byte[] scratch = new byte[48000 * 8];
                    while (_running && !(_stopSignal?.IsSet ?? true))
                    {
                        WaitForSingleObject(sampleEvent, 15);
                        while (captureClient.GetNextPacketSize(out uint packetFrames) == 0 && packetFrames > 0)
                        {
                            if (captureClient.GetBuffer(out IntPtr dataPtr, out uint framesRead, out uint bufFlags, out _, out _) == 0)
                            {
                                int byteCount = (int)(framesRead * 8); // 2ch * 4 bytes Float32
                                if (byteCount > 0 && byteCount <= scratch.Length)
                                {
                                    if ((bufFlags & AUDCLNT_BUFFERFLAGS_SILENT) != 0)
                                    {
                                        Array.Clear(scratch, 0, byteCount);
                                    }
                                    else
                                    {
                                        Marshal.Copy(dataPtr, scratch, 0, byteCount);
                                    }
                                    Program.SendPcmPacket(scratch, byteCount);
                                }
                                captureClient.ReleaseBuffer(framesRead);
                            }
                            else
                            {
                                break;
                            }
                        }
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
}

