cmake_minimum_required(VERSION 3.21)
project(StremioTVNative VERSION 0.2.3 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(STREMIO_TV_APP_ID "io.github.shreyasajj.StremioTV" CACHE STRING "Desktop file / Wayland app id")

find_package(Qt6 6.5 REQUIRED COMPONENTS Quick Qml Network OpenGL WebEngineQuick WebChannel)
find_package(Qt6 6.5 QUIET COMPONENTS DBus)
find_package(PkgConfig REQUIRED)
pkg_check_modules(MPV REQUIRED IMPORTED_TARGET mpv)

qt_standard_project_setup(REQUIRES 6.5)

qt_add_executable(stremio-tv-native main.cpp)
qt_add_qml_module(stremio-tv-native
    URI StremioTV.Native
    VERSION 1.0
    QML_FILES Main.qml
    RESOURCES bridge.js
    SOURCES
        mpvcontroller.cpp mpvcontroller.h
        mpvitem.cpp mpvitem.h
        shellbridge.cpp shellbridge.h
)

# The shared web UI lives one directory up (also used by the Electron shell).
get_filename_component(STREMIO_TV_UI_SRC "${CMAKE_CURRENT_SOURCE_DIR}/../ui" ABSOLUTE)
target_compile_definitions(stremio-tv-native PRIVATE
    STREMIO_TV_APP_ID="${STREMIO_TV_APP_ID}"
    STREMIO_TV_SOURCE_UI="${STREMIO_TV_UI_SRC}")

target_link_libraries(stremio-tv-native PRIVATE
    Qt6::Quick Qt6::Qml Qt6::Network Qt6::OpenGL Qt6::WebEngineQuick Qt6::WebChannel
    PkgConfig::MPV)
if(TARGET Qt6::DBus)
    target_link_libraries(stremio-tv-native PRIVATE Qt6::DBus)
    target_compile_definitions(stremio-tv-native PRIVATE STREMIO_TV_HAVE_DBUS)
endif()

include(GNUInstallDirs)
install(TARGETS stremio-tv-native RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(DIRECTORY "${STREMIO_TV_UI_SRC}/" DESTINATION ${CMAKE_INSTALL_DATADIR}/stremio-tv/ui)
install(FILES packaging/${STREMIO_TV_APP_ID}.desktop DESTINATION ${CMAKE_INSTALL_DATADIR}/applications)
install(FILES packaging/${STREMIO_TV_APP_ID}.metainfo.xml DESTINATION ${CMAKE_INSTALL_DATADIR}/metainfo)
install(FILES packaging/${STREMIO_TV_APP_ID}.svg
        DESTINATION ${CMAKE_INSTALL_DATADIR}/icons/hicolor/scalable/apps)
