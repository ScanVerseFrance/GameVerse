#include "overlay_state.h"
#include "nlog.h"

namespace nexus {

OverlayState& OverlayState::instance() {
    static OverlayState s;
    return s;
}

void OverlayState::set_visible(bool v) {
    std::lock_guard<std::mutex> lk(m_);
    if (visible_ != v) {
        nexus::nlog::log("OverlayState::set_visible %d -> %d", visible_, v);
    }
    visible_ = v;
}

void OverlayState::set_game(GameInfo g) {
    std::lock_guard<std::mutex> lk(m_);
    game_ = std::move(g);
}

void OverlayState::set_friends(std::vector<Friend> friends) {
    std::lock_guard<std::mutex> lk(m_);
    friends_ = std::move(friends);
}

void OverlayState::set_username(std::string u) {
    std::lock_guard<std::mutex> lk(m_);
    username_ = std::move(u);
}

} // namespace nexus
