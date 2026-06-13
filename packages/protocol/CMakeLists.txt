cmake_minimum_required(VERSION 3.20)
project(moonlight_wasm)

# Requires Emscripten: https://emscripten.org/docs/getting_started/
# Setup: pnpm --filter @basehack/protocol fetch:moonlight
# Build: emcmake cmake -B build && cmake --build build --target moonlight

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

set(VENDOR_DIR ${CMAKE_SOURCE_DIR}/vendor/moonlight-common-c)
set(SRC_DIR ${VENDOR_DIR}/src)

if (NOT EXISTS ${SRC_DIR}/Limelight.h)
  message(FATAL_ERROR
    "moonlight-common-c is missing. Run: pnpm --filter @basehack/protocol fetch:moonlight")
endif()

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_SOURCE_DIR}/dist)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_SOURCE_DIR}/dist)
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)

# moonlight's stream lifecycle relies on real OS threads (control/video/audio
# receive loops). Compile EVERY object (enet + moonlight-common-c + platform)
# with -pthread so atomics/TLS ABI is consistent across the whole link.
add_compile_options(-pthread)

add_subdirectory(${VENDOR_DIR}/enet ${CMAKE_BINARY_DIR}/enet)

file(GLOB MOONLIGHT_COMMON_SOURCES CONFIGURE_DEPENDS ${SRC_DIR}/*.c)
list(REMOVE_ITEM MOONLIGHT_COMMON_SOURCES ${SRC_DIR}/PlatformSockets.c)
list(REMOVE_ITEM MOONLIGHT_COMMON_SOURCES ${SRC_DIR}/PlatformCrypto.c)

add_executable(moonlight
  ${MOONLIGHT_COMMON_SOURCES}
  platform/moonlight_bridge.c
  platform/platform_web_crypto.c
  platform/platform_web.c
  platform/enet_web.c
)

target_include_directories(moonlight SYSTEM PRIVATE
  ${SRC_DIR}
  ${VENDOR_DIR}/nanors
  ${VENDOR_DIR}/nanors/deps
  ${VENDOR_DIR}/nanors/deps/obl
)

target_link_libraries(moonlight PRIVATE enet)
set_property(TARGET moonlight APPEND PROPERTY
  LINK_DEPENDS ${CMAKE_SOURCE_DIR}/js/socket-bridge.js
)

target_compile_definitions(moonlight PRIVATE
  HAS_SOCKLEN_T
  NDEBUG
  LC_EMSCRIPTEN_DIRECT_SOCKETS
)

# Emscripten-specific flags
set_target_properties(moonlight PROPERTIES
  SUFFIX ".js"
  OUTPUT_NAME "moonlight"
)

target_link_options(moonlight PRIVATE
  # Real pthreads: moonlight runs its receive/decode loops on background
  # threads. Async JS socket/crypto work is proxied to the main thread (where
  # the Direct Sockets transport lives) via __proxy:'sync'+__async, so the
  # worker blocks on a futex without needing ASYNCIFY. This replaces the old
  # single-threaded ASYNCIFY model (which can't host moonlight's threads).
  "-pthread"
  "-sPTHREAD_POOL_SIZE=24"
  "-sPTHREAD_POOL_SIZE_STRICT=0"
  # Blocking happens only on worker threads (allowed); the main thread never
  # blocks. Permit it explicitly so a stray main-thread wait warns instead of
  # aborting the whole module.
  "-sALLOW_BLOCKING_ON_MAIN_THREAD=1"
  # Export the functions the JS layer needs to call
  "-sEXPORTED_FUNCTIONS=[_ml_start_connection,_ml_stop_connection,_ml_interrupt_connection,_ml_send_keyboard,_ml_send_mouse_move,_ml_send_mouse_button,_ml_send_high_res_scroll,_ml_request_idr_frame,_ml_get_estimated_rtt,_malloc,_free]"
  "-sEXPORTED_RUNTIME_METHODS=[ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8]"
  # Custom socket library (Direct Sockets bridge instead of WebSockets)
  "--js-library=${CMAKE_SOURCE_DIR}/js/socket-bridge.js"
  # Route moonlight's direct libc recv() calls through our socket bridge
  "-Wl,--wrap=recv"
  "-Wl,--wrap=sendto"
  # Route ENet's control-stream socket I/O through the Direct Sockets bridge
  # (enet_web.c) instead of raw BSD sockets that can't reach the host.
  "-Wl,--wrap=enet_socket_create"
  "-Wl,--wrap=enet_socket_destroy"
  "-Wl,--wrap=enet_socket_bind"
  "-Wl,--wrap=enet_socket_get_address"
  "-Wl,--wrap=enet_socket_set_option"
  "-Wl,--wrap=enet_socket_get_option"
  "-Wl,--wrap=enet_socket_connect"
  "-Wl,--wrap=enet_socket_shutdown"
  "-Wl,--wrap=enet_socket_send"
  "-Wl,--wrap=enet_socket_receive"
  "-Wl,--wrap=enet_socket_wait"
  # Output as ES module (web + worker, since pthreads spawn Web Workers)
  "-sENVIRONMENT=web,worker"
  "-sMODULARIZE=1"
  "-sEXPORT_ES6=1"
  "-sEXPORT_NAME=MoonlightModule"
  "-sALLOW_TABLE_GROWTH=1"
  # Memory
  "-sINITIAL_MEMORY=67108864"  # 64MB
  "-sALLOW_MEMORY_GROWTH=1"
  "-O2"
)
