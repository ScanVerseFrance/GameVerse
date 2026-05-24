// =====================================================================
//  overlay_state.h — shared in-process state for the hooked DLL
//
//  Single source of truth that the IPC thread WRITES (from cloud
//  data pulled from Electron) and the render hook READS (every
//  Present, throttled to ~60 fps). All access goes through
//  OverlayState::with(...) which holds a mutex — concurrent
//  reads from multiple render threads (rare but possible with
//  DXGI flip-model multi-buffering) are safe.
// =====================================================================
#pragma once
#include <mutex>
#include <string>
#include <vector>
#include <functional>

namespace nexus {

struct Friend {
    std::string id;
    std::string name;
    std::string avatarUrl;      // may be empty
    enum class Status { InGame, Online, Away, Offline };
    Status status = Status::Offline;
    std::string gameTitle;       // only when status == InGame, may be empty
};

struct GameInfo {
    std::string title;
    int steamAppId = 0;          // 0 if unknown
    std::string coverUrl;        // library_hero or logo, resolved by Electron
};

class OverlayState {
public:
    static OverlayState& instance();

    // Mutated by the IPC thread on every state push from Electron.
    void set_visible(bool v);
    void set_game(GameInfo g);
    void set_friends(std::vector<Friend> friends);
    void set_username(std::string u);

    // Read by the render hook. Snapshot pattern : the caller passes
    // a lambda, we lock + invoke + unlock. Avoids returning refs
    // into mutex-guarded data.
    template <typename F>
    auto read(F&& fn) const -> decltype(fn(std::declval<const OverlayState&>())) {
        std::lock_guard<std::mutex> lk(m_);
        return fn(*this);
    }

    bool                       visible() const { return visible_; }
    const GameInfo&            game()    const { return game_; }
    const std::vector<Friend>& friends() const { return friends_; }
    const std::string&         username() const { return username_; }

    // Toggle visibility — used when the user presses Shift+Tab
    // INSIDE the game (the DLL captures input ; cf hook_*.cpp's
    // ImGui_ImplWin32_WndProcHandler chain).
    void toggle_visible() { visible_ = !visible_; }

private:
    OverlayState() = default;
    mutable std::mutex m_;
    bool                visible_ = false;
    GameInfo            game_;
    std::vector<Friend> friends_;
    std::string         username_;
};

} // namespace nexus
