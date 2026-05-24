# Nexus Overlay — native in-game overlay

Hook DLL + injector qui permet à l'overlay Nexus de s'afficher **par-dessus
les jeux en exclusive fullscreen** (DirectX 9/10/11/12, OpenGL, Vulkan).

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  Nexus Launcher (Electron)                                        │
│                                                                   │
│  library.service.launchGame()                                     │
│        │                                                          │
│        ├─→ start the game process (existing flow)                 │
│        └─→ overlay-inject.service.injectInto(pid)                 │
│                  │                                                │
│                  └─→ spawn nexus-overlay-injector.exe --pid=<pid> │
│                                                                   │
│  overlay-ipc-server.service                                       │
│  named pipe `\\.\pipe\nexus-overlay`                              │
│  └─→ serves cloud state, friends, game info to the DLL            │
└──────────────────────────────────┬────────────────────────────────┘
                                   │ named pipe IPC
                                   ▼
┌───────────────────────────────────────────────────────────────────┐
│  Game process (e.g. forza6.exe)  ← DLL injected via CreateRemoteThread
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  nexus-overlay.dll                                          │  │
│  │  ────────────                                               │  │
│  │  DllMain (PROCESS_ATTACH) →                                 │  │
│  │    detect graphics API loaded (d3d11.dll? opengl32.dll?)   │  │
│  │    install MinHook detours on the right Present func        │  │
│  │                                                             │  │
│  │  Hooked Present() →                                         │  │
│  │    1. first call: init Dear ImGui backend                   │  │
│  │    2. every call:                                           │  │
│  │       a. query state from Electron via named pipe (cached)  │  │
│  │       b. ImGui::NewFrame()                                  │  │
│  │       c. draw overlay UI (logo, friends, chat, …)           │  │
│  │       d. ImGui::Render() into the game's back buffer        │  │
│  │       e. call original Present()                            │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

## What it hooks

| API     | DLL probed       | Function hooked                  | Detour technique          |
| ------- | ---------------- | -------------------------------- | ------------------------- |
| D3D 9   | `d3d9.dll`       | `IDirect3DDevice9::Present`      | vtable[17]                |
| D3D 10  | `dxgi.dll`       | `IDXGISwapChain::Present`        | vtable[8]                 |
| D3D 11  | `dxgi.dll`       | `IDXGISwapChain::Present`        | vtable[8]                 |
| D3D 12  | `dxgi.dll`       | `IDXGISwapChain::Present`        | vtable[8] (same vtable)   |
| OpenGL  | `opengl32.dll`   | `wglSwapBuffers`                 | IAT hook (Microsoft Detours) |
| Vulkan  | `vulkan-1.dll`   | `vkQueuePresentKHR`              | vtable + layer manifest   |

For D3D 10/11/12 the vtable layout is identical because they all use
`IDXGISwapChain` from DXGI — so a single hook covers all three. We
discriminate at runtime via `QueryInterface` to know which device the
swap chain belongs to (D3D11Device vs D3D12Device, etc.) so we
initialise the right ImGui backend.

## Build

Requirements :
- Windows 10/11 x64
- Visual Studio 2022 with "Desktop development with C++"
- CMake 3.25+
- Windows SDK 10.0.22621.0 (or newer)

One-command build :

```powershell
.\build.bat
```

Produces in `build/Release/` :
- `nexus-overlay.dll` — the hook DLL
- `nexus-overlay-injector.exe` — the injector executable

The Electron app picks these up via `overlay-inject.service.ts`.

## How the injection works

The injector uses the classic `CreateRemoteThread + LoadLibraryW` trick :

1. `OpenProcess(target_pid, PROCESS_CREATE_THREAD | VM_WRITE | VM_OPERATION)`
2. `VirtualAllocEx(target, size=MAX_PATH, MEM_COMMIT, PAGE_READWRITE)`
3. `WriteProcessMemory(target, allocated_addr, "C:\\path\\to\\nexus-overlay.dll\0", ...)`
4. `GetProcAddress(GetModuleHandle("kernel32"), "LoadLibraryW")`
5. `CreateRemoteThread(target, ..., loadLibraryAddr, allocated_addr, ...)`
6. The remote thread runs `LoadLibraryW(allocated_path)` in the game's address space
7. DllMain runs in the game process with PROCESS_ATTACH

That's it. No driver, no anti-cheat bypass, no signed certificate
required. **Standard Windows debugger APIs**.

> **Note** : this WILL be detected by aggressive anti-cheat solutions
> (BattlEye, EAC, Vanguard). Since Nexus Launcher targets offline /
> single-player titles, that's not a concern — but **never inject into
> a multiplayer competitive game** you care about playing.

## How the overlay renders

Once the hook intercepts `Present()` :

1. **First frame** — initialise the ImGui backend matching the
   game's API. For D3D11 that means :
   ```cpp
   ImGui_ImplWin32_Init(game_hwnd);
   ImGui_ImplDX11_Init(device, context);
   ```
2. **Every frame** — before calling the original `Present()` :
   ```cpp
   ImGui_ImplDX11_NewFrame();
   ImGui_ImplWin32_NewFrame();
   ImGui::NewFrame();
   draw_nexus_overlay();   // our UI
   ImGui::Render();
   ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());
   ```
3. The original `Present()` then swaps the back buffer to the screen,
   which now contains our overlay composited on top.

## State sync with Electron

The injected DLL doesn't know the user's friends, current game, etc.
It queries that state from the Electron main process via a named pipe :

- Pipe path : `\\.\pipe\nexus-overlay-<launcher_pid>`
- Protocol : length-prefixed JSON messages
- Server : `overlay-ipc-server.service.ts` (Electron main)
- Client : `ipc.cpp` in the DLL

Polling cadence : every 500ms the DLL requests a state snapshot
(`{ currentGame, friends, panelOpen, hotkey }`) and applies it to
its ImGui state. Conversely, user input in the overlay (button
clicks) is sent back to Electron for handling (open chat, send
invite, etc.).

## Project layout

```
tools/nexus-overlay/
├── README.md                  ← you are here
├── CMakeLists.txt             ← root build
├── build.bat                  ← one-shot build (calls cmake --build)
├── third_party/
│   └── minhook/               ← MinHook vendored (MIT)
├── dll/                       ← nexus-overlay.dll
│   ├── CMakeLists.txt
│   └── src/
│       ├── dllmain.cpp        ← DllMain + API detection
│       ├── overlay_state.{h,cpp}
│       ├── ipc.{h,cpp}        ← named pipe client
│       ├── renderer.{h,cpp}   ← ImGui dispatch
│       └── hooks/
│           ├── hook_dxgi.{h,cpp}    ← D3D10/11/12
│           ├── hook_d3d9.{h,cpp}
│           ├── hook_opengl.{h,cpp}
│           └── hook_vulkan.{h,cpp}
└── injector/                  ← nexus-overlay-injector.exe
    ├── CMakeLists.txt
    └── src/main.cpp
```

## Why MinHook (and not Detours)

| feature       | MinHook     | Microsoft Detours     |
| ------------- | ----------- | --------------------- |
| License       | BSD-2       | MIT                   |
| Vendor size   | ~4 files    | ~20 files + lib       |
| 64-bit relays | yes         | yes                   |
| Activity      | active      | active                |
| Steam uses    | parts (yes) | yes                   |

MinHook is smaller and easier to vendor inline — that's the only
reason. The hook semantics are identical.
