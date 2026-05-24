#pragma once
// Logger fichier partagé entre tous les .cpp de la DLL. Écrit dans
// %TEMP%\nexus-overlay-dll-<pid>.log. Thread-safe, fflush après
// chaque ligne pour ne rien perdre si le jeu crash.
namespace nexus::nlog {
void log(const char* fmt, ...);
// Counter-style log : ne log que les N premiers appels avec un tag.
// Utile dans les hooks Present qui sont call 60x/sec.
void log_once(const char* tag, int max_calls, const char* fmt, ...);
}
