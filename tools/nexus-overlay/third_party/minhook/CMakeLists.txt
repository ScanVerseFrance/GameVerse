# Vendored MinHook via FetchContent. v1.3.4+ ships its own CMakeLists
# qui définit déjà le target `minhook` (static lib). On laisse upstream
# faire le boulot — nos add_library historiques sont supprimés sinon
# conflit "target minhook already exists".
include(FetchContent)
FetchContent_Declare(
    minhook_src
    GIT_REPOSITORY https://github.com/TsudaKageyu/minhook.git
    GIT_TAG        v1.3.4  # latest stable (Q1 2026)
    GIT_SHALLOW    ON
)
FetchContent_MakeAvailable(minhook_src)

# Note : le target `minhook` est désormais fourni par upstream. Pour
# les includes, upstream pose minhook_src_SOURCE_DIR/include sur la
# PUBLIC interface de `minhook` — pas besoin de target_include_directories
# manuel ici. dll/CMakeLists.txt n'a qu'à `target_link_libraries(... minhook)`.
