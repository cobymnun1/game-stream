cmake_minimum_required(VERSION 3.20)
project(moonlight_wasm)

# Requires Emscripten: https://emscripten.org/docs/getting_started/
# Build: emcmake cmake -B build && cmake --build build

set(CMAKE_C_STANDARD 11)
set(SRC_DIR ${CMAKE_SOURCE_DIR}/src/moonlight-common-c/src)

add_executable(moonlight
  ${SRC_DIR}/AudioStream.c
  ${SRC_DIR}/ByteBuffer.c
  ${SRC_DIR}/Connection.c
  ${SRC_DIR}/ControlStream.c
  ${SRC_DIR}/InputStream.c
  ${SRC_DIR}/Misc.c
  ${SRC_DIR}/Platform.c
  ${SRC_DIR}/PlatformCrypto.c
  ${SRC_DIR}/PlatformSockets.c
  ${SRC_DIR}/RtpAudioQueue.c
  ${SRC_DIR}/RtpVideoQueue.c
  ${SRC_DIR}/RtspConnection.c
  ${SRC_DIR}/RtspParser.c
  ${SRC_DIR}/SdpGenerator.c
  ${SRC_DIR}/VideoDepacketizer.c
  ${SRC_DIR}/VideoStream.c
  ${SRC_DIR}/rswrapper.c
  js/socket-bridge.c
)

target_include_directories(moonlight PRIVATE ${SRC_DIR})

# Emscripten-specific flags
set_target_properties(moonlight PROPERTIES
  SUFFIX ".js"
  OUTPUT_NAME "moonlight"
)

target_link_options(moonlight PRIVATE
  # Enable ASYNCIFY so sync C socket calls can await async JS Direct Sockets
  "-sASYNCIFY=1"
  "-sASYNCIFY_IMPORTS=[socket_connect,socket_recv,socket_send,socket_recvfrom,socket_sendto]"
  # Export the functions the JS layer needs to call
  "-sEXPORTED_FUNCTIONS=[_LiStartConnection,_LiStopConnection,_LiSendKeyboardEvent,_LiSendMouseMoveEvent,_LiSendMouseButtonEvent,_LiRequestIdrFrame,_malloc,_free]"
  "-sEXPORTED_RUNTIME_METHODS=[ccall,cwrap,UTF8ToString,stringToUTF8]"
  # Custom socket library (Direct Sockets bridge instead of WebSockets)
  "--js-library=${CMAKE_SOURCE_DIR}/js/socket-bridge.js"
  # Output as ES module
  "-sENVIRONMENT=web"
  "-sMODULARIZE=1"
  "-sEXPORT_ES6=1"
  "-sEXPORT_NAME=MoonlightModule"
  # Memory
  "-sINITIAL_MEMORY=67108864"  # 64MB
  "-sALLOW_MEMORY_GROWTH=1"
  "-O2"
)
