// =====================================================================
//  ipc.h — named-pipe client that pulls state from Electron main.
//
//  Pipe path : \\.\pipe\nexus-overlay-<launcher_pid>
//  We get the launcher pid from the env var NEXUS_LAUNCHER_PID set by
//  the injector (which knows it because it's a child of the launcher).
//
//  Protocol :
//    Client → Server : 4-byte LE length + JSON request
//      { "type": "get-state" }
//      { "type": "event", "name": "open-chat", "peerId": "..." }
//
//    Server → Client : 4-byte LE length + JSON response
//      { "type": "state", "data": { ... } }
//      { "type": "ok" }
//
//  Polling : 500ms get-state pull when not waiting on a response.
// =====================================================================
#pragma once
#include <atomic>

namespace nexus::ipc {

// Worker loop — run inside its own std::thread by dllmain.
void run(const std::atomic<bool>& shutdown);

// Fire an event back to Electron (e.g. "open-friend-chat" with payload).
// Synchronous from the caller's POV but uses a separate pipe instance
// to avoid deadlocking the polling loop.
void send_event(const char* json_payload);

// Fire-and-forget : queue le payload sur un thread worker dédié et
// retourne IMMÉDIATEMENT (aucune attente d'ack). Critique pour les
// events appelés depuis la WndProc subclass du jeu — un send_event()
// bloquant freeze le jeu de plusieurs secondes si la pipe est lente.
// On accumule les events ; le worker drain dans l'ordre d'arrivée.
void send_event_async(const char* json_payload);

} // namespace nexus::ipc
