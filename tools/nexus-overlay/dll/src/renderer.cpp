#include "renderer.h"
#include "overlay_state.h"
#include "ipc.h"

#include "imgui.h"
#include "backends/imgui_impl_win32.h"

extern IMGUI_IMPL_API LRESULT
ImGui_ImplWin32_WndProcHandler(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);

namespace nexus::renderer {

namespace {

// Visibility shortcut from inside the game : Shift+Tab toggles. The
// hooked WndProc forwards key events here BEFORE handing them to
// ImGui (we want the user to be able to bind Shift+Tab even if
// ImGui has no focus yet, so we don't depend on
// ImGui::GetIO().WantCaptureKeyboard).
bool was_shift_down = false;
bool was_tab_down   = false;
bool handle_global_hotkey(UINT msg, WPARAM wp) {
    if (msg == WM_KEYDOWN && wp == VK_SHIFT) was_shift_down = true;
    if (msg == WM_KEYDOWN && wp == VK_TAB && was_shift_down) {
        if (!was_tab_down) {
            was_tab_down = true;
            nexus::OverlayState::instance().toggle_visible();
            nexus::ipc::send_event(R"({"type":"event","name":"toggle-visible"})");
            return true;
        }
    }
    if (msg == WM_KEYUP   && wp == VK_TAB)   was_tab_down   = false;
    if (msg == WM_KEYUP   && wp == VK_SHIFT) was_shift_down = false;
    return false;
}

void draw_top_logo(const nexus::GameInfo& game) {
    // Centered hero text at the top. The actual game logo PNG can't
    // easily be loaded inside the DLL (no JPEG/PNG decoder in our
    // tiny CRT-static binary). For Phase 1 we show the title as
    // styled text ; Phase 2 will pre-decode the logo on Electron
    // side and ship the raw pixels via IPC. Steam library_hero is
    // 1920×620, decoded to ~5 MB RGBA which we can stream.
    ImVec2 size = ImGui::GetIO().DisplaySize;
    ImGui::SetNextWindowPos(ImVec2(size.x * 0.5f, 80), ImGuiCond_Always, ImVec2(0.5f, 0));
    ImGui::SetNextWindowBgAlpha(0.0f);
    ImGui::PushStyleColor(ImGuiCol_Border, ImVec4(0, 0, 0, 0));
    ImGui::Begin("##logo", nullptr,
                 ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                 ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoScrollbar |
                 ImGuiWindowFlags_NoBackground | ImGuiWindowFlags_AlwaysAutoResize |
                 ImGuiWindowFlags_NoInputs);
    ImGui::PushFont(ImGui::GetIO().Fonts->Fonts.front()); // default font; we scale via SetWindowFontScale
    ImGui::SetWindowFontScale(2.5f);
    const std::string& title = game.title.empty() ? std::string("Nexus Overlay") : game.title;
    ImVec2 text_size = ImGui::CalcTextSize(title.c_str());
    ImGui::SetCursorPosX((ImGui::GetWindowWidth() - text_size.x) * 0.5f);
    ImGui::TextColored(ImVec4(1, 1, 1, 0.96f), "%s", title.c_str());
    ImGui::SetWindowFontScale(1.0f);
    ImGui::PopFont();
    ImGui::TextColored(ImVec4(0.8f, 0.8f, 0.85f, 0.6f),
                       "EN COURS · SHIFT+TAB POUR FERMER");
    ImGui::End();
    ImGui::PopStyleColor();
}

void draw_friends_panel(const std::vector<nexus::Friend>& friends) {
    ImGui::SetNextWindowPos(ImVec2(60, 200), ImGuiCond_FirstUseEver);
    ImGui::SetNextWindowSize(ImVec2(420, 480), ImGuiCond_FirstUseEver);
    ImGui::Begin("Amis", nullptr, ImGuiWindowFlags_NoCollapse);
    if (friends.empty()) {
        ImGui::TextColored(ImVec4(0.7f, 0.7f, 0.75f, 1.0f),
                           "Aucun ami en ligne pour le moment.");
    } else {
        for (const auto& f : friends) {
            ImVec4 dot;
            const char* label = "";
            switch (f.status) {
                case nexus::Friend::Status::InGame:
                    dot = ImVec4(0.66f, 0.33f, 0.97f, 1.0f); label = "En jeu"; break;
                case nexus::Friend::Status::Online:
                    dot = ImVec4(0.13f, 0.77f, 0.37f, 1.0f); label = "En ligne"; break;
                case nexus::Friend::Status::Away:
                    dot = ImVec4(0.96f, 0.62f, 0.04f, 1.0f); label = "Absent"; break;
                default:
                    dot = ImVec4(0.42f, 0.45f, 0.50f, 1.0f); label = "Hors ligne"; break;
            }
            ImGui::ColorButton((f.id + "##dot").c_str(), dot,
                ImGuiColorEditFlags_NoTooltip | ImGuiColorEditFlags_NoBorder, ImVec2(10, 10));
            ImGui::SameLine();
            ImGui::TextUnformatted(f.name.c_str());
            ImGui::SameLine();
            ImGui::TextColored(ImVec4(0.6f, 0.6f, 0.65f, 1.0f), "(%s%s%s)",
                               label,
                               f.gameTitle.empty() ? "" : " · ",
                               f.gameTitle.c_str());
            ImGui::Separator();
        }
    }
    ImGui::End();
}

void draw_button_bar() {
    ImVec2 size = ImGui::GetIO().DisplaySize;
    ImGui::SetNextWindowPos(ImVec2(size.x * 0.5f, size.y - 80),
                            ImGuiCond_Always, ImVec2(0.5f, 0.5f));
    ImGui::SetNextWindowBgAlpha(0.7f);
    ImGui::Begin("##btnbar", nullptr,
                 ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                 ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse |
                 ImGuiWindowFlags_AlwaysAutoResize);
    if (ImGui::Button("Amis"))         { /* TODO toggle friends */ }
    ImGui::SameLine();
    if (ImGui::Button("Chat"))         { nexus::ipc::send_event(R"({"type":"event","name":"open-chat"})"); }
    ImGui::SameLine();
    if (ImGui::Button("Succes"))       { nexus::ipc::send_event(R"({"type":"event","name":"open-achievements"})"); }
    ImGui::SameLine();
    if (ImGui::Button("Capture"))      { nexus::ipc::send_event(R"({"type":"event","name":"screenshot"})"); }
    ImGui::SameLine();
    if (ImGui::Button("Notes"))        { nexus::ipc::send_event(R"({"type":"event","name":"open-notes"})"); }
    ImGui::SameLine();
    if (ImGui::Button("Perf"))         { /* TODO inline perf HUD */ }
    ImGui::SameLine();
    if (ImGui::Button("Remote Play"))  { nexus::ipc::send_event(R"({"type":"event","name":"open-remote-play"})"); }
    ImGui::SameLine();
    if (ImGui::Button("X (Fermer)")) {
        // Envoie un event toggle-visible à Electron, qui flippe son
        // overlayUserVisible. Au prochain poll (≤500ms) la DLL recevra
        // visible:false et cachera l'ImGui définitivement. Sans ce
        // event, Electron continue à envoyer visible:true et la DLL
        // remontre l'overlay en boucle.
        nexus::ipc::send_event(R"({"type":"event","name":"toggle-visible"})");
        // Aussi flip local pour réactivité immédiate (sinon 1 frame
        // avant que l'event roundtrip + poll soit complet).
        nexus::OverlayState::instance().set_visible(false);
    }
    ImGui::End();
}

void draw_backdrop() {
    // Semi-transparent fullscreen dim. We can't render outside our
    // hooked Present, but we CAN paint a screen-sized window with
    // dark alpha. ImGui only paints what we tell it to.
    ImVec2 size = ImGui::GetIO().DisplaySize;
    ImGui::SetNextWindowPos(ImVec2(0, 0));
    ImGui::SetNextWindowSize(size);
    ImGui::SetNextWindowBgAlpha(0.72f);
    ImGui::Begin("##backdrop", nullptr,
                 ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                 ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoScrollbar |
                 ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoSavedSettings |
                 ImGuiWindowFlags_NoInputs);
    ImGui::End();
}

} // namespace

void draw_frame() {
    nexus::OverlayState& st = nexus::OverlayState::instance();
    if (!st.visible()) return;

    nexus::GameInfo            game_copy;
    std::vector<nexus::Friend> friends_copy;
    st.read([&](const nexus::OverlayState& s) {
        game_copy    = s.game();
        friends_copy = s.friends();
        return 0;
    });

    draw_backdrop();
    draw_top_logo(game_copy);
    draw_friends_panel(friends_copy);
    draw_button_bar();
}

LRESULT wndproc_handler(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (handle_global_hotkey(msg, wp)) {
        return 1; // swallow — ImGui doesn't need to see it
    }
    // When overlay is visible, route to ImGui so it can capture
    // mouse/keyboard. Otherwise let everything pass through to the
    // game.
    if (nexus::OverlayState::instance().visible()) {
        return ImGui_ImplWin32_WndProcHandler(hwnd, msg, wp, lp);
    }
    return 0;
}

void shutdown() {
    if (ImGui::GetCurrentContext()) {
        ImGui::DestroyContext();
    }
}

} // namespace nexus::renderer
