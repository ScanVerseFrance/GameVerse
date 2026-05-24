// Nexus Input bridge helper — Phase 2.
//
// Standalone helper executable spawned by the Electron main process
// when the user toggles "Activer Nexus Input" on a game. Réplique
// du core de Steam Input sur Windows :
//
//   1. Connecte au driver ViGEmBus (doit être installé par l'user,
//      l'installer est bundlé et auto-lancé en UAC par Nexus).
//   2. Crée un virtual Xbox 360 controller (XInput) → exposé au jeu
//      qui pense voir une manette Xbox standard.
//   3. Ouvre la DualSense/DS4 en HID EXCLUSIF → bloque l'accès
//      direct du jeu à la manette physique. Plus de double-pad.
//   4. Boucle read HID → parse boutons/sticks/triggers/gyro →
//      applique remap+deadzones+invertY+gyro → emit sur virtual pad.
//   5. Écoute les rumble feedback du Xbox virtuel et forward sur le
//      DualSense via Output Report HID.
//
// Protocole stdin/stdout (JSON-lines, UTF-8) :
//
//   Côté Electron envoie :
//     {"cmd":"start"}
//     {"cmd":"stop"}
//     {"cmd":"config", "config": <ControllerConfig>}
//     {"cmd":"ping"}
//
//   Côté helper émet :
//     {"event":"ready"}
//     {"event":"connected","name":"DualSense..."}
//     {"event":"disconnected"}
//     {"event":"error","code":"VIGEM_MISSING|HID_BUSY|NO_PAD|..."}
//     {"event":"log","level":"info","msg":"..."}

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using HidSharp;
using Nefarius.Drivers.HidHide;
using Nefarius.ViGEm.Client;
using Nefarius.ViGEm.Client.Targets;
using Nefarius.ViGEm.Client.Targets.Xbox360;

namespace NexusInput;

internal static class Program
{
    private const ushort SONY_VENDOR_ID = 0x054C;
    private static readonly ushort[] DUALSENSE_PIDS = { 0x0CE6, 0x0DF2 };
    private static readonly ushort[] DS4_PIDS = { 0x05C4, 0x09CC };

    private static ViGEmClient? _vigem;
    private static IXbox360Controller? _vpad;
    private static HidStream? _hidStream;
    private static HidDevice? _hidDevice;
    private static CancellationTokenSource _cts = new();
    private static readonly object _emitLock = new();
    private static HidHideControlService? _hidHide;
    private static string? _cloakedInstancePath;
    /// Toutes les instance IDs blacklistées dans HidHide pour cette
    /// session — peut contenir le main HID interface + les siblings
    /// (audio interface, touchpad interface, etc.) de la même manette.
    /// On les unblock TOUS au stop pour rendre la manette visible
    /// proprement (sinon elle reste partiellement cachée jusqu'au
    /// reboot Windows).
    private static readonly List<string> _allCloakedInstanceIds = new();
    /// True quand la DualSense est en Bluetooth (Report ID 0x31, 78
    /// bytes input). Influence le parsing input ET le format du
    /// rumble output report.
    private static bool _isBluetooth;

    // Current bridge configuration (remap + deadzones + invertY + gyro
    // + rumble). Updated via `{cmd:"config"}` from Electron — applied
    // live in the hot HID loop. Initialisé à un default permissif.
    private static BridgeConfig _config = BridgeConfig.Default();

    // Remote Play mode — quand l'arg --remote-play est passé, le helper
    // saute toute la partie HID (pas de manette physique à lire) et se
    // contente d'attendre des reports JSON sur stdin qu'il pousse au
    // virtual pad ViGEm. C'est ce mode qui est utilisé par le pipeline
    // P2P streaming Phase B : la manette du guest est lue côté guest
    // via navigator.getGamepads(), les reports sont envoyés au host par
    // RTCDataChannel, le host les forward via IPC à ce helper qui les
    // injecte dans un virtual Xbox 360 pad — le jeu host pense voir
    // une vraie 2e manette branchée.
    private static bool _remotePlayMode;

    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        _remotePlayMode = args.Any(a => a == "--remote-play");
        if (_remotePlayMode)
        {
            // En remote-play, on auto-start le virtual pad au lancement
            // (pas d'attente de cmd "start" — le helper est spawn quand
            // une session est déjà décidée, pas besoin d'étape config).
            StartRemotePlayVpad();
        }
        Emit("ready", new { remotePlay = _remotePlayMode });

        try { await ReadStdinLoop(); }
        catch (Exception ex)
        {
            Emit("error", new { code = "FATAL", msg = ex.Message });
            return 1;
        }
        Shutdown();
        return 0;
    }

    // Init ViGEm uniquement (pas de HID, pas de HidHide). Le report sera
    // poussé par chaque cmd "input" reçue sur stdin.
    private static void StartRemotePlayVpad()
    {
        try { _vigem = new ViGEmClient(); }
        catch (Exception ex)
        {
            Emit("error", new
            {
                code = "VIGEM_MISSING",
                msg = "Driver ViGEmBus introuvable.",
                detail = ex.Message,
            });
            return;
        }
        try
        {
            _vpad = _vigem.CreateXbox360Controller();
            _vpad.Connect();
            Emit("log", new { level = "info", msg = "remote-play virtual pad connected" });
        }
        catch (Exception ex)
        {
            Emit("error", new { code = "VIGEM_VPAD_FAILED", msg = ex.Message });
        }
    }

    private static async Task ReadStdinLoop()
    {
        using var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string? line;
        while ((line = await reader.ReadLineAsync()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                if (!doc.RootElement.TryGetProperty("cmd", out var cmdProp)) continue;
                var cmd = cmdProp.GetString() ?? "";
                switch (cmd)
                {
                    case "start": HandleStart(); break;
                    case "stop":
                        Shutdown();
                        Emit("stopped", new { });
                        break;
                    case "config":
                        if (doc.RootElement.TryGetProperty("config", out var cfgEl))
                            ApplyConfig(cfgEl);
                        break;
                    case "ping": Emit("pong", new { }); break;
                    // Remote Play — un report XInput compact arrive depuis
                    // le host renderer (qui le reçoit du guest via WebRTC
                    // data channel). On unpack le bit-mask buttons + les
                    // axes/triggers et on pousse au virtual pad.
                    case "input":
                        if (doc.RootElement.TryGetProperty("report", out var repEl))
                            HandleRemotePlayInput(repEl);
                        break;
                }
            }
            catch (JsonException)
            {
                Emit("log", new { level = "warn", msg = $"malformed json: {line}" });
            }
        }
    }

    private static void ApplyConfig(JsonElement el)
    {
        try
        {
            var next = BridgeConfig.FromJson(el);
            _config = next;
            Emit("log", new { level = "info", msg = "config applied" });
        }
        catch (Exception ex)
        {
            Emit("log", new { level = "warn", msg = $"config parse failed: {ex.Message}" });
        }
    }

    // Remote Play input — décode le report compact reçu sur stdin et
    // pousse au virtual pad. Format attendu (cf src/remote-play/RemotePlayGuest.tsx
    // function gamepadToReport) :
    //   {
    //     buttons: number  (14-bit mask, ordre Xbox 360 + DPad bits 10-13)
    //     lt: number       (0..255, trigger gauche)
    //     rt: number       (0..255, trigger droit)
    //     lx, ly, rx, ry: number  (-32768..32767, axes signed short Xbox)
    //   }
    private static long _remotePlayReportCount;
    private static void HandleRemotePlayInput(JsonElement el)
    {
        if (_vpad == null) return;
        try
        {
            int buttons = el.TryGetProperty("buttons", out var bp) ? bp.GetInt32() : 0;
            int lt = el.TryGetProperty("lt", out var ltp) ? ltp.GetInt32() : 0;
            int rt = el.TryGetProperty("rt", out var rtp) ? rtp.GetInt32() : 0;
            int lx = el.TryGetProperty("lx", out var lxp) ? lxp.GetInt32() : 0;
            int ly = el.TryGetProperty("ly", out var lyp) ? lyp.GetInt32() : 0;
            int rx = el.TryGetProperty("rx", out var rxp) ? rxp.GetInt32() : 0;
            int ry = el.TryGetProperty("ry", out var ryp) ? ryp.GetInt32() : 0;

            var r = new Xbox360Report
            {
                A         = (buttons & (1 << 0))  != 0,
                B         = (buttons & (1 << 1))  != 0,
                X         = (buttons & (1 << 2))  != 0,
                Y         = (buttons & (1 << 3))  != 0,
                LB        = (buttons & (1 << 4))  != 0,
                RB        = (buttons & (1 << 5))  != 0,
                Back      = (buttons & (1 << 6))  != 0,
                Start     = (buttons & (1 << 7))  != 0,
                LStick    = (buttons & (1 << 8))  != 0,
                RStick    = (buttons & (1 << 9))  != 0,
                DpadUp    = (buttons & (1 << 10)) != 0,
                DpadDown  = (buttons & (1 << 11)) != 0,
                DpadLeft  = (buttons & (1 << 12)) != 0,
                DpadRight = (buttons & (1 << 13)) != 0,
                LT = (byte)Math.Clamp(lt, 0, 255),
                RT = (byte)Math.Clamp(rt, 0, 255),
                LX = (short)Math.Clamp(lx, -32768, 32767),
                LY = (short)Math.Clamp(ly, -32768, 32767),
                RX = (short)Math.Clamp(rx, -32768, 32767),
                RY = (short)Math.Clamp(ry, -32768, 32767),
            };
            EmitToVpad(r);

            // Log les 5 premiers reports pour confirmer le pipeline,
            // puis tous les 600 (≈ 10s à 60Hz) pour heartbeat.
            var n = Interlocked.Increment(ref _remotePlayReportCount);
            if (n <= 5 || n % 600 == 0)
            {
                Emit("log", new {
                    level = "info",
                    msg = $"remote-play report #{n} buttons=0x{buttons:X4} LT={lt} RT={rt} L=({lx},{ly}) R=({rx},{ry})",
                });
            }
        }
        catch (Exception ex)
        {
            Emit("log", new { level = "warn", msg = $"remote-play input parse failed: {ex.Message}" });
        }
    }

    private static void HandleStart()
    {
        Shutdown();

        try { _vigem = new ViGEmClient(); }
        catch (Exception ex)
        {
            Emit("error", new
            {
                code = "VIGEM_MISSING",
                msg = "Driver ViGEmBus introuvable. Installe-le depuis https://github.com/nefarius/ViGEmBus/releases puis réessaye.",
                detail = ex.Message,
            });
            return;
        }

        try
        {
            _vpad = _vigem.CreateXbox360Controller();
            // Rumble forwarding — quand le jeu vibre le virtual pad,
            // l'event arrive ici et on le pousse sur le DualSense via
            // Output Report HID (handlé dans WriteRumble).
            _vpad.FeedbackReceived += OnRumbleFeedback;
            _vpad.Connect();
        }
        catch (Exception ex)
        {
            Emit("error", new { code = "VIGEM_VPAD_FAILED", msg = ex.Message });
            return;
        }

        _hidDevice = FindFirstSonyController();
        if (_hidDevice == null)
        {
            Emit("error", new { code = "NO_PAD", msg = "Aucune manette PlayStation détectée." });
            return;
        }

        try
        {
            var openConfig = new OpenConfiguration();
            openConfig.SetOption(OpenOption.Exclusive, true);
            _hidStream = _hidDevice.Open(openConfig);
            _hidStream.ReadTimeout = Timeout.Infinite;
        }
        catch (Exception ex)
        {
            Emit("error", new
            {
                code = "HID_BUSY",
                msg = "Une autre app utilise déjà la manette (Steam, DS4Windows, etc.). Ferme-la puis réessaye.",
                detail = ex.Message,
            });
            return;
        }

        // HidHide cloak — cache la manette physique aux jeux.
        // Sans ça, le jeu peut encore voir la DualSense via
        // Windows.Gaming.Input même si on a le HID exclusif lock.
        // C'est ce qui résout vraiment le bug "2 joueurs".
        TryActivateHidHide(_hidDevice);

        // Détecte le transport (USB vs Bluetooth) via la taille du
        // max input report. USB DualSense = 64 octets, BT = 78 octets.
        // On l'envoie au renderer pour info debug + on l'utilise pour
        // le rumble (BT a un layout d'output report différent).
        int maxReport = 64;
        try { maxReport = _hidDevice.GetMaxInputReportLength(); } catch { }
        _isBluetooth = maxReport >= 70;

        Emit("connected", new
        {
            name = _hidDevice.GetFriendlyName(),
            vendorId = _hidDevice.VendorID,
            productId = _hidDevice.ProductID,
            isDualSense = DUALSENSE_PIDS.Contains((ushort)_hidDevice.ProductID),
            isDS4 = DS4_PIDS.Contains((ushort)_hidDevice.ProductID),
            hidHideActive = _cloakedInstancePath != null,
            transport = _isBluetooth ? "bluetooth" : "usb",
            reportSize = maxReport,
        });

        _cts = new CancellationTokenSource();
        Task.Run(() => HidLoop(_cts.Token));
    }

    /// Active HidHide kernel filter pour cacher la manette physique
    /// aux apps autres que le helper. C'est l'équivalent exact du
    /// "Hide from games" de Steam Input.
    ///
    /// Steps :
    ///   1. Whitelist le path de NexusInput.exe → seul lui pourra
    ///      lire le HID (ViGEmBus virtual pad lui reste accessible
    ///      depuis le jeu via XInput, c'est le but).
    ///   2. Ajoute l'instance path du HID DualSense à la blacklist.
    ///   3. Active le cloak global.
    ///
    /// Best-effort : si HidHide n'est pas installé OU si l'activation
    /// échoue (permissions, etc.), on continue sans → fallback sur
    /// le HID exclusif open qui marche pour la plupart des jeux.
    private static void TryActivateHidHide(HidDevice hidDevice)
    {
        try
        {
            _hidHide = new HidHideControlService();
            if (!_hidHide.IsInstalled)
            {
                Emit("log", new { level = "warn", msg = "HidHide non installé, skip cloak" });
                _hidHide = null;
                return;
            }
            // Whitelist NexusInput.exe lui-même pour qu'il puisse
            // continuer à lire le HID après le cloak.
            var ourExe = Environment.ProcessPath ??
                System.Reflection.Assembly.GetExecutingAssembly().Location;
            if (!string.IsNullOrEmpty(ourExe))
            {
                try
                {
                    _hidHide.AddApplicationPath(ourExe);
                }
                catch (Exception ex)
                {
                    Emit("log", new { level = "warn", msg = $"HidHide whitelist failed: {ex.Message}" });
                }
            }
            // Convertit le DevicePath HidSharp → instance ID Windows.
            //
            // HidSharp expose le SymbolicLink :
            //   \\?\HID#VID_054C&PID_0CE6&MI_03#9&abc&0&0000#{GUID}
            //
            // HidHide attend l'instance ID Windows :
            //   HID\VID_054C&PID_0CE6&MI_03\9&abc&0&0000
            //
            // Transformation :
            //   1. Strip "\\?\" préfixe
            //   2. Strip "#{GUID...}" suffixe (= class interface guid)
            //   3. Remplace les '#' restants par '\'
            //
            // SANS cette conversion, AddBlockedInstanceId() reçoit un
            // path bidon, ne match aucun device dans le store HidHide,
            // et le cloak no-op silencieusement → la manette physique
            // reste visible aux jeux → bug "2 joueurs" sur Lego Marvel.
            var rawPath = hidDevice.DevicePath;
            if (!string.IsNullOrEmpty(rawPath))
            {
                try
                {
                    var instanceId = ConvertDevicePathToInstanceId(rawPath);
                    Emit("log", new { level = "info", msg = $"HidHide blocking: {instanceId}" });
                    _hidHide.AddBlockedInstanceId(instanceId);
                    _cloakedInstancePath = instanceId;
                    _allCloakedInstanceIds.Add(instanceId);

                    // Ajoute aussi les autres interfaces de la même
                    // manette (audio, touchpad, etc.). On enumère tous
                    // les HID devices Sony et on blacklist ceux qui
                    // partagent le même PID, même s'ils sont sur un
                    // MI_xx (collection number) différent. Sans ça,
                    // certains jeux qui scannent toutes les interfaces
                    // HID voient encore le pad via l'interface audio.
                    BlockSiblingInterfaces(hidDevice);
                }
                catch (Exception ex)
                {
                    Emit("log", new { level = "warn", msg = $"HidHide blacklist failed: {ex.Message}" });
                }
            }
            _hidHide.IsActive = true;
            Emit("log", new { level = "info", msg = "HidHide cloak activé" });
        }
        catch (Exception ex)
        {
            Emit("log", new { level = "warn", msg = $"HidHide init failed: {ex.Message}" });
            _hidHide = null;
        }
    }

    /// Convertit un SymbolicLink HidSharp en instance ID Windows
    /// accepté par HidHide.
    ///
    /// In  : `\\?\HID#VID_054C&PID_0CE6&MI_03#9&abc&0&0000#{4d1e55b2-...}`
    /// Out : `HID\VID_054C&PID_0CE6&MI_03\9&abc&0&0000`
    ///
    /// 1. Strip `\\?\` préfixe (NT object manager namespace marker)
    /// 2. Strip `#{...}` suffixe (class interface GUID)
    /// 3. Remplace tous les `#` restants par `\` (delimiter Windows)
    private static string ConvertDevicePathToInstanceId(string devicePath)
    {
        if (string.IsNullOrEmpty(devicePath)) return devicePath;
        var s = devicePath;
        if (s.StartsWith(@"\\?\")) s = s.Substring(4);
        // Strip ClassGuid suffix : "...#0000#{guid}" → "...#0000"
        var braceIdx = s.IndexOf("#{", StringComparison.Ordinal);
        if (braceIdx > 0) s = s.Substring(0, braceIdx);
        // Sometimes the suffix is "#{guid}" with no extra delimiter,
        // sometimes "{guid}" directly. Handle both.
        var braceIdx2 = s.IndexOf('{');
        if (braceIdx2 > 0) s = s.Substring(0, braceIdx2).TrimEnd('#');
        return s.Replace('#', '\\');
    }

    /// Bloque aussi les "sibling" HID interfaces de la même manette
    /// (audio interface, touchpad interface, etc.). On enumère TOUS les
    /// HID devices Sony et on blacklist ceux qui partagent le même PID
    /// que le device principal, peu importe leur MI_xx (collection
    /// number). Sans ça, certains jeux qui scannent toutes les
    /// interfaces HID Sony peuvent encore voir le pad via une
    /// interface secondaire → bug 2-joueurs persiste partiellement.
    private static void BlockSiblingInterfaces(HidDevice mainDevice)
    {
        if (_hidHide == null) return;
        try
        {
            ushort vendorId = (ushort)mainDevice.VendorID;
            ushort productId = (ushort)mainDevice.ProductID;
            var mainInstance = ConvertDevicePathToInstanceId(mainDevice.DevicePath);
            foreach (var dev in DeviceList.Local.GetHidDevices(vendorId, productId))
            {
                try
                {
                    var sibInstance = ConvertDevicePathToInstanceId(dev.DevicePath);
                    if (string.IsNullOrEmpty(sibInstance)) continue;
                    if (string.Equals(sibInstance, mainInstance, StringComparison.OrdinalIgnoreCase))
                        continue; // déjà blacklisté
                    Emit("log", new { level = "info", msg = $"HidHide blocking sibling: {sibInstance}" });
                    _hidHide.AddBlockedInstanceId(sibInstance);
                    _allCloakedInstanceIds.Add(sibInstance);
                }
                catch { /* skip — best-effort */ }
            }
        }
        catch (Exception ex)
        {
            Emit("log", new { level = "warn", msg = $"sibling block failed: {ex.Message}" });
        }
    }

    /// Désactive le HidHide cloak proprement au stop du bridge.
    /// Sans ça, la manette resterait invisible aux autres apps
    /// jusqu'au reboot ou jusqu'à ouverture manuelle de HidHide
    /// CLI pour cleanup.
    private static void DeactivateHidHide()
    {
        if (_hidHide == null) return;
        try
        {
            // Cleanup all blocked instances we added — pas que le main,
            // aussi les siblings (audio interface, touchpad interface,
            // etc.) sinon la manette reste partiellement cachée
            // après stop du bridge.
            foreach (var id in _allCloakedInstanceIds)
            {
                try { _hidHide.RemoveBlockedInstanceId(id); }
                catch { /* swallow */ }
            }
            _allCloakedInstanceIds.Clear();
            _cloakedInstancePath = null;
            _hidHide.IsActive = false;
        }
        catch { /* swallow — best-effort cleanup */ }
        _hidHide = null;
    }

    private static HidDevice? FindFirstSonyController()
    {
        var list = DeviceList.Local.GetHidDevices(SONY_VENDOR_ID).ToList();
        foreach (var pid in DUALSENSE_PIDS.Concat(DS4_PIDS))
        {
            var hit = list.FirstOrDefault(d => d.ProductID == pid);
            if (hit != null) return hit;
        }
        return list.FirstOrDefault();
    }

    private static void HidLoop(CancellationToken ct)
    {
        if (_hidStream == null || _vpad == null || _hidDevice == null) return;
        int reportLen = 64;
        try { reportLen = _hidDevice.GetMaxInputReportLength(); } catch { }
        if (reportLen < 16) reportLen = 64;
        var buf = new byte[reportLen];
        var isDualSense = DUALSENSE_PIDS.Contains((ushort)_hidDevice.ProductID);

        try
        {
            while (!ct.IsCancellationRequested)
            {
                int read;
                try { read = _hidStream.Read(buf); }
                catch (IOException)
                {
                    Emit("disconnected", new { });
                    return;
                }
                if (read <= 0) continue;

                var raw = isDualSense ? ParseDualSense(buf, read) : ParseDualShock4(buf, read);

                // Apply user config transforms in this order :
                //   1. Deadzones sur sticks    (zone morte → 0)
                //   2. Trigger thresholds       (en dessous du seuil → 0)
                //   3. Invert Y                 (flip stick droit Y)
                //   4. Gyro mix sur stick droit (additif, clampé)
                //   5. Remap boutons            (mapping physique → virtuel)
                var cfg = _config; // snapshot, the config can mutate live
                var final = ApplyTransforms(raw, cfg);
                var mapped = ApplyRemap(final, cfg.Remap);

                lock (_emitLock)
                {
                    EmitToVpad(mapped);
                }
            }
        }
        catch (Exception ex)
        {
            Emit("error", new { code = "HID_LOOP", msg = ex.Message });
        }
    }

    private static void EmitToVpad(Xbox360Report r)
    {
        if (_vpad == null) return;
        _vpad.SetButtonState(Xbox360Button.A, r.A);
        _vpad.SetButtonState(Xbox360Button.B, r.B);
        _vpad.SetButtonState(Xbox360Button.X, r.X);
        _vpad.SetButtonState(Xbox360Button.Y, r.Y);
        _vpad.SetButtonState(Xbox360Button.LeftShoulder, r.LB);
        _vpad.SetButtonState(Xbox360Button.RightShoulder, r.RB);
        _vpad.SetButtonState(Xbox360Button.Start, r.Start);
        _vpad.SetButtonState(Xbox360Button.Back, r.Back);
        _vpad.SetButtonState(Xbox360Button.Guide, r.Guide);
        _vpad.SetButtonState(Xbox360Button.LeftThumb, r.LStick);
        _vpad.SetButtonState(Xbox360Button.RightThumb, r.RStick);
        _vpad.SetButtonState(Xbox360Button.Up, r.DpadUp);
        _vpad.SetButtonState(Xbox360Button.Down, r.DpadDown);
        _vpad.SetButtonState(Xbox360Button.Left, r.DpadLeft);
        _vpad.SetButtonState(Xbox360Button.Right, r.DpadRight);
        _vpad.LeftTrigger = r.LT;
        _vpad.RightTrigger = r.RT;
        _vpad.LeftThumbX = r.LX;
        _vpad.LeftThumbY = r.LY;
        _vpad.RightThumbX = r.RX;
        _vpad.RightThumbY = r.RY;
        _vpad.SubmitReport();
    }

    // ── Transforms ─────────────────────────────────────────────────
    private static Xbox360Report ApplyTransforms(Xbox360Report r, BridgeConfig cfg)
    {
        // Deadzones sticks — appliqués sur le vecteur (LX,LY)/(RX,RY).
        // Un radial deadzone est plus naturel qu'un per-axis. On
        // compute la magnitude, si < threshold * 32767 → set 0.
        if (cfg.DeadzoneLeft > 0)
            (r.LX, r.LY) = ApplyRadialDeadzone(r.LX, r.LY, cfg.DeadzoneLeft);
        if (cfg.DeadzoneRight > 0)
            (r.RX, r.RY) = ApplyRadialDeadzone(r.RX, r.RY, cfg.DeadzoneRight);

        // Trigger thresholds — en dessous → 0, sinon valeur native.
        // Ne ré-échelonne pas (ce serait une option future).
        if (r.LT < (byte)(cfg.TriggerLeftThreshold * 255)) r.LT = 0;
        if (r.RT < (byte)(cfg.TriggerRightThreshold * 255)) r.RT = 0;

        // Invert Y sur stick droit (config option). Beaucoup de FPS
        // demandent ça. Le stick gauche reste normal — on mappe
        // movement, pas aim.
        if (cfg.InvertY)
            r.RY = (short)(-Math.Clamp((int)r.RY, -32767, 32767));

        // Gyro → stick droit (DualSense only, applied additively).
        // Phase 1 minimal : on lit déjà le gyro brut dans le parser
        // et stocke dans r.GyroDX/DY. Si activé, on les rajoute au
        // stick droit avec sensibilité, clamp 16-bit.
        if (cfg.GyroEnabled && cfg.GyroMode == "rightStick")
        {
            int rx = r.RX + (int)(r.GyroDX * cfg.GyroSensitivityX);
            int ry = r.RY + (int)(r.GyroDY * cfg.GyroSensitivityY);
            r.RX = (short)Math.Clamp(rx, short.MinValue, short.MaxValue);
            r.RY = (short)Math.Clamp(ry, short.MinValue, short.MaxValue);
        }
        return r
        ;
    }

    private static (short, short) ApplyRadialDeadzone(short x, short y, double dz)
    {
        double mag = Math.Sqrt((double)x * x + (double)y * y);
        double threshold = dz * 32767.0;
        if (mag < threshold) return (0, 0);
        // Re-scale : map [threshold..32767] → [0..32767] pour pas avoir
        // un saut dur à la sortie du deadzone.
        double scale = (mag - threshold) / (32767.0 - threshold);
        double nx = (x / mag) * scale * 32767;
        double ny = (y / mag) * scale * 32767;
        return (
            (short)Math.Clamp(nx, short.MinValue, short.MaxValue),
            (short)Math.Clamp(ny, short.MinValue, short.MaxValue)
        );
    }

    // ── Remap ──────────────────────────────────────────────────────
    private static Xbox360Report ApplyRemap(Xbox360Report src, Dictionary<string, string> remap)
    {
        if (remap.Count == 0) return src;
        // Build : pour chaque virtual button du remap, on regarde
        // l'état du bouton SOURCE et l'assigne au bouton CIBLE. Le
        // bouton source d'origine est cleared sauf s'il est lui-même
        // remappé depuis ailleurs (sinon clic A → mapped sur B vide
        // mais l'A original reste pressé).
        var src2 = src;
        var pressed = ButtonsToMap(src2);
        var result = src2;
        // Reset all face/menu/dpad/bumpers buttons to false ; on
        // ré-applique selon remap.
        result.A = result.B = result.X = result.Y = false;
        result.LB = result.RB = false;
        result.Back = result.Start = result.Guide = false;
        result.LStick = result.RStick = false;
        result.DpadUp = result.DpadDown = result.DpadLeft = result.DpadRight = false;
        foreach (var (from, isPressed) in pressed)
        {
            if (!isPressed) continue;
            var to = remap.TryGetValue(from, out var t) ? t : from;
            SetButton(ref result, to, true);
        }
        return result;
    }

    private static IEnumerable<(string name, bool pressed)> ButtonsToMap(Xbox360Report r)
    {
        yield return ("A", r.A);
        yield return ("B", r.B);
        yield return ("X", r.X);
        yield return ("Y", r.Y);
        yield return ("LB", r.LB);
        yield return ("RB", r.RB);
        yield return ("BACK", r.Back);
        yield return ("START", r.Start);
        yield return ("GUIDE", r.Guide);
        yield return ("LSTICK", r.LStick);
        yield return ("RSTICK", r.RStick);
        yield return ("DPAD_UP", r.DpadUp);
        yield return ("DPAD_DOWN", r.DpadDown);
        yield return ("DPAD_LEFT", r.DpadLeft);
        yield return ("DPAD_RIGHT", r.DpadRight);
    }

    private static void SetButton(ref Xbox360Report r, string name, bool value)
    {
        switch (name)
        {
            case "A": r.A = value; break;
            case "B": r.B = value; break;
            case "X": r.X = value; break;
            case "Y": r.Y = value; break;
            case "LB": r.LB = value; break;
            case "RB": r.RB = value; break;
            case "BACK": r.Back = value; break;
            case "START": r.Start = value; break;
            case "GUIDE": r.Guide = value; break;
            case "LSTICK": r.LStick = value; break;
            case "RSTICK": r.RStick = value; break;
            case "DPAD_UP": r.DpadUp = value; break;
            case "DPAD_DOWN": r.DpadDown = value; break;
            case "DPAD_LEFT": r.DpadLeft = value; break;
            case "DPAD_RIGHT": r.DpadRight = value; break;
        }
    }

    // ── Rumble forwarding (game → physical pad) ────────────────────
    private static void OnRumbleFeedback(object? sender, Xbox360FeedbackReceivedEventArgs e)
    {
        if (_hidStream == null || _hidDevice == null) return;
        if (!_config.RumbleEnabled) return;
        try
        {
            var isDualSense = DUALSENSE_PIDS.Contains((ushort)_hidDevice.ProductID);
            byte large = e.LargeMotor; // strong / left motor
            byte small = e.SmallMotor; // light / right motor
            if (isDualSense)
                WriteDualSenseRumble(large, small);
            else
                WriteDS4Rumble(large, small);
        }
        catch (Exception ex)
        {
            Emit("log", new { level = "warn", msg = $"rumble write failed: {ex.Message}" });
        }
    }

    /// DualSense Output Report 0x02 (USB) — set rumble.
    ///   buf[0] = 0x02 (Report ID)
    ///   buf[1] = 0xFF (Valid Flag 0 : rumble + audio + ...) — minimal
    ///            we just need rumble bit (0x01) + reset bit (0x02)
    ///   buf[2] = 0x00 (Valid Flag 1)
    ///   buf[3] = right motor (small)
    ///   buf[4] = left motor (large)
    /// On envoie un report de 48 bytes (full USB length) avec zéros
    /// partout sauf les bytes rumble.
    ///
    /// En Bluetooth, ce report n'est pas utilisable — il faut un
    /// Report ID 0x31 avec un CRC32 calculé, layout complexe (78 bytes).
    /// Pour v0.4.6 on skip rumble en BT plutôt que d'envoyer un
    /// output report invalide qui ferait disconnect le HID — meilleur
    /// trade-off vs un rumble inactif.
    private static void WriteDualSenseRumble(byte large, byte small)
    {
        if (_hidStream == null) return;
        if (_isBluetooth) return; // Skip — BT rumble report TBD
        var buf = new byte[48];
        buf[0] = 0x02;            // Report ID
        buf[1] = 0x03;            // Flag 0 : rumble enabled + audio off mute
        buf[2] = 0x00;            // Flag 1
        buf[3] = small;           // right motor (small/high-freq)
        buf[4] = large;           // left motor (large/low-freq)
        try { _hidStream.Write(buf); } catch { /* swallow */ }
    }

    /// DualShock 4 Output Report 0x05 (USB) — set rumble + LED.
    ///   buf[0] = 0x05 (Report ID)
    ///   buf[1] = flag (0xFF for rumble + LED)
    ///   buf[2] = 0x04 (unknown, observed)
    ///   buf[3] = 0x00
    ///   buf[4] = right motor (small)
    ///   buf[5] = left motor (large)
    ///   buf[6..8] = LED R G B
    private static void WriteDS4Rumble(byte large, byte small)
    {
        if (_hidStream == null) return;
        var buf = new byte[32];
        buf[0] = 0x05;
        buf[1] = 0xFF;
        buf[2] = 0x04;
        buf[4] = small;
        buf[5] = large;
        try { _hidStream.Write(buf); } catch { /* swallow */ }
    }

    // ── Parsers ──────────────────────────────────────────────────────
    private struct Xbox360Report
    {
        public bool A, B, X, Y, LB, RB, Start, Back, Guide, LStick, RStick;
        public bool DpadUp, DpadDown, DpadLeft, DpadRight;
        public byte LT, RT;
        public short LX, LY, RX, RY;
        /// Gyro delta (raw int16 from controller) — used by gyro mix.
        public short GyroDX, GyroDY;
    }

    /// DualSense report parser — handles BOTH USB et Bluetooth modes.
    ///
    /// USB mode (Report ID 0x01, 64 bytes) :
    ///   b[0] = 0x01
    ///   b[1..4]  = LX, LY, RX, RY (data starts at off=1)
    ///   ...
    ///
    /// Bluetooth mode (Report ID 0x31, 78 bytes) :
    ///   b[0] = 0x31
    ///   b[1] = 1 byte de séquence/metadata BT
    ///   b[2..5]  = LX, LY, RX, RY (data starts at off=2)
    ///   ...
    ///
    /// AVANT v0.4.6 on faisait `off = b[0] == 0x01 ? 1 : 0` → en BT,
    /// off restait à 0, donc on lisait b[0] (= 0x31, le report ID lui-
    /// même) comme LX. Résultat : stick coincé à 0x31, et tous les
    /// boutons à des offsets décalés → le jeu voyait le virtual pad
    /// connecté mais AUCUN bouton ne passait. C'était EXACTEMENT le
    /// bug "AUCUNE SAISIE" de Lego Marvel quand la DualSense est en
    /// Bluetooth (cas typique laptop).
    ///
    /// Le reste du layout (offsets relatifs à `off`) est identique
    /// entre USB et BT — Sony aligne les données.
    private static Xbox360Report ParseDualSense(byte[] b, int len)
    {
        var r = new Xbox360Report();
        if (len < 10) return r;
        // Detect transport via Report ID. Si on tombe sur autre chose
        // (ancien firmware ?) on assume USB (off=1) en best-effort.
        int off;
        if (b[0] == 0x01) off = 1;        // USB
        else if (b[0] == 0x31) off = 2;   // Bluetooth
        else off = 1;                      // fallback (most likely USB)
        if (len < off + 10) return r;

        r.LX = NormalizeAxis(b[off + 0]);
        r.LY = NormalizeAxis(b[off + 1], invert: true);
        r.RX = NormalizeAxis(b[off + 2]);
        r.RY = NormalizeAxis(b[off + 3], invert: true);
        r.LT = b[off + 4];
        r.RT = b[off + 5];

        byte faceAndDpad = b[off + 7];
        byte dpad = (byte)(faceAndDpad & 0x0F);
        r.X = (faceAndDpad & 0x10) != 0; // Square
        r.A = (faceAndDpad & 0x20) != 0; // Cross
        r.B = (faceAndDpad & 0x40) != 0; // Circle
        r.Y = (faceAndDpad & 0x80) != 0; // Triangle
        SetDpad(dpad, ref r);

        byte shoulder = b[off + 8];
        r.LB = (shoulder & 0x01) != 0;
        r.RB = (shoulder & 0x02) != 0;
        r.Back = (shoulder & 0x10) != 0;
        r.Start = (shoulder & 0x20) != 0;
        r.LStick = (shoulder & 0x40) != 0;
        r.RStick = (shoulder & 0x80) != 0;

        byte misc = b[off + 9];
        r.Guide = (misc & 0x01) != 0;

        // Gyro raw (signed int16, little-endian). Bytes 15-16 = X,
        // 17-18 = Y. Le report DualSense USB est 64 bytes alors on
        // a bien la place.
        if (len >= off + 19)
        {
            r.GyroDX = (short)(b[off + 15] | (b[off + 16] << 8));
            r.GyroDY = (short)(b[off + 17] | (b[off + 18] << 8));
            // Le raw est très sensible — on divise par 64 pour avoir
            // une amplitude utile pour le mix stick droit. 64 = empiric
            // sweet spot ; la sensitivity user multiplie par-dessus.
            r.GyroDX = (short)(r.GyroDX / 64);
            r.GyroDY = (short)(r.GyroDY / 64);
        }
        return r;
    }

    /// DualShock 4 — layout proche du DualSense pour les premiers
    /// 10 bytes. Le gyro est à un offset différent (à brancher plus
    /// tard) ; pour V1 on ne lit que les boutons/sticks.
    private static Xbox360Report ParseDualShock4(byte[] b, int len)
    {
        var r = ParseDualSense(b, len);
        // Clear gyro pour DS4 (offset différent du DualSense, on ne
        // mappe pas pour l'instant).
        r.GyroDX = 0;
        r.GyroDY = 0;
        return r;
    }

    private static void SetDpad(byte dpad, ref Xbox360Report r)
    {
        switch (dpad)
        {
            case 0: r.DpadUp = true; break;
            case 1: r.DpadUp = true; r.DpadRight = true; break;
            case 2: r.DpadRight = true; break;
            case 3: r.DpadDown = true; r.DpadRight = true; break;
            case 4: r.DpadDown = true; break;
            case 5: r.DpadDown = true; r.DpadLeft = true; break;
            case 6: r.DpadLeft = true; break;
            case 7: r.DpadUp = true; r.DpadLeft = true; break;
        }
    }

    private static short NormalizeAxis(byte v, bool invert = false)
    {
        int signed = (v - 128) * 256;
        if (invert) signed = -signed;
        return (short)Math.Clamp(signed, short.MinValue, short.MaxValue);
    }

    private static void Shutdown()
    {
        try { _cts?.Cancel(); } catch { }
        try { _hidStream?.Dispose(); } catch { }
        _hidStream = null;
        _hidDevice = null;
        try
        {
            if (_vpad != null)
            {
                _vpad.FeedbackReceived -= OnRumbleFeedback;
                _vpad.Disconnect();
            }
        }
        catch { }
        _vpad = null;
        try { _vigem?.Dispose(); } catch { }
        _vigem = null;
        // Désactive le cloak HidHide proprement pour rendre la
        // manette visible au système (sinon elle reste cachée
        // jusqu'au reboot ou intervention manuelle HidHide CLI).
        DeactivateHidHide();
    }

    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        WriteIndented = false,
    };

    private static void Emit(string evt, object payload)
    {
        var dict = new Dictionary<string, object?> { ["event"] = evt };
        foreach (var prop in payload.GetType().GetProperties())
            dict[prop.Name] = prop.GetValue(payload);
        var json = JsonSerializer.Serialize(dict, _jsonOpts);
        Console.WriteLine(json);
        Console.Out.Flush();
    }
}

/// Mirror du ControllerConfig côté renderer. Tout l'état que le
/// helper applique sur la boucle HID. Mutable via `{cmd:"config"}`.
internal sealed class BridgeConfig
{
    public Dictionary<string, string> Remap { get; set; } = new();
    public double DeadzoneLeft { get; set; } = 0.10;
    public double DeadzoneRight { get; set; } = 0.10;
    public double TriggerLeftThreshold { get; set; } = 0.05;
    public double TriggerRightThreshold { get; set; } = 0.05;
    public bool InvertY { get; set; } = false;
    public bool RumbleEnabled { get; set; } = true;
    public bool GyroEnabled { get; set; } = false;
    public string GyroMode { get; set; } = "rightStick";
    public double GyroSensitivityX { get; set; } = 1.0;
    public double GyroSensitivityY { get; set; } = 1.0;

    public static BridgeConfig Default() => new();

    public static BridgeConfig FromJson(JsonElement el)
    {
        var c = new BridgeConfig();
        if (el.TryGetProperty("remap", out var rm) && rm.ValueKind == JsonValueKind.Object)
        {
            foreach (var p in rm.EnumerateObject())
            {
                if (p.Value.ValueKind == JsonValueKind.String)
                    c.Remap[p.Name] = p.Value.GetString() ?? "";
            }
        }
        if (el.TryGetProperty("deadzones", out var dz) && dz.ValueKind == JsonValueKind.Object)
        {
            if (dz.TryGetProperty("leftStick", out var l) && l.ValueKind == JsonValueKind.Number)
                c.DeadzoneLeft = l.GetDouble();
            if (dz.TryGetProperty("rightStick", out var r) && r.ValueKind == JsonValueKind.Number)
                c.DeadzoneRight = r.GetDouble();
        }
        if (el.TryGetProperty("triggers", out var tr) && tr.ValueKind == JsonValueKind.Object)
        {
            if (tr.TryGetProperty("left", out var l) && l.ValueKind == JsonValueKind.Number)
                c.TriggerLeftThreshold = l.GetDouble();
            if (tr.TryGetProperty("right", out var r) && r.ValueKind == JsonValueKind.Number)
                c.TriggerRightThreshold = r.GetDouble();
        }
        if (el.TryGetProperty("invertY", out var iv) && iv.ValueKind != JsonValueKind.Undefined)
            c.InvertY = iv.ValueKind == JsonValueKind.True;
        if (el.TryGetProperty("rumbleEnabled", out var ru) && ru.ValueKind != JsonValueKind.Undefined)
            c.RumbleEnabled = ru.ValueKind == JsonValueKind.True;
        if (el.TryGetProperty("gyro", out var gy) && gy.ValueKind == JsonValueKind.Object)
        {
            if (gy.TryGetProperty("enabled", out var en))
                c.GyroEnabled = en.ValueKind == JsonValueKind.True;
            if (gy.TryGetProperty("mode", out var mo) && mo.ValueKind == JsonValueKind.String)
                c.GyroMode = mo.GetString() ?? "rightStick";
            if (gy.TryGetProperty("sensitivityX", out var sx) && sx.ValueKind == JsonValueKind.Number)
                c.GyroSensitivityX = sx.GetDouble();
            if (gy.TryGetProperty("sensitivityY", out var sy) && sy.ValueKind == JsonValueKind.Number)
                c.GyroSensitivityY = sy.GetDouble();
        }
        return c;
    }
}
