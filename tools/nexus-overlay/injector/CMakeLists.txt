add_executable(nexus_overlay_injector
    src/main.cpp
)

set_target_properties(nexus_overlay_injector PROPERTIES
    OUTPUT_NAME "nexus-overlay-injector"
)

target_link_libraries(nexus_overlay_injector PRIVATE
    user32
    kernel32
)

# Subsystem console — the injector runs from Electron's spawn() and
# we want stderr/stdout captured for diagnostics.
if(MSVC)
    set_target_properties(nexus_overlay_injector PROPERTIES
        LINK_FLAGS "/SUBSYSTEM:CONSOLE"
    )
endif()
