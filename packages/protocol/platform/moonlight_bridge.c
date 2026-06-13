#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

#include <emscripten/emscripten.h>

#include "Limelight.h"

extern void ml_stage_starting(int stage, const char* name);
extern void ml_stage_complete(int stage, const char* name);
extern void ml_stage_failed(int stage, int error_code, const char* name);
extern void ml_connection_started(void);
extern void ml_connection_terminated(int error_code);
extern void ml_connection_result(int code);
extern int ml_video_setup(int video_format, int width, int height, int redraw_rate);
extern void ml_video_start(void);
extern void ml_video_stop(void);
extern void ml_video_cleanup(void);
extern int ml_video_frame(const char* data, int length, int frame_number, int frame_type,
  double presentation_time_us, uint32_t rtp_timestamp);
extern int ml_audio_init(int audio_configuration, int sample_rate, int channel_count, int samples_per_frame);
extern void ml_audio_start(void);
extern void ml_audio_stop(void);
extern void ml_audio_cleanup(void);
extern void ml_audio_packet(const char* data, int length);

static int audio_configuration_from_channels(int audio_channels);

static void bridge_stage_starting(int stage) {
  ml_stage_starting(stage, LiGetStageName(stage));
}

static void bridge_stage_complete(int stage) {
  ml_stage_complete(stage, LiGetStageName(stage));
}

static void bridge_stage_failed(int stage, int error_code) {
  ml_stage_failed(stage, error_code, LiGetStageName(stage));
}

static void bridge_connection_started(void) {
  ml_connection_started();
}

static void bridge_connection_terminated(int error_code) {
  ml_connection_terminated(error_code);
}

static int bridge_video_setup(int video_format, int width, int height, int redraw_rate, void* context, int dr_flags) {
  (void)context;
  (void)dr_flags;
  return ml_video_setup(video_format, width, height, redraw_rate);
}

static void bridge_video_start(void) {
  ml_video_start();
}

static void bridge_video_stop(void) {
  ml_video_stop();
}

static void bridge_video_cleanup(void) {
  ml_video_cleanup();
}

static int bridge_submit_decode_unit(PDECODE_UNIT decode_unit) {
  if (decode_unit == NULL || decode_unit->fullLength <= 0 || decode_unit->bufferList == NULL) {
    return DR_OK;
  }

  char* frame = malloc((size_t)decode_unit->fullLength);
  if (frame == NULL) {
    return DR_NEED_IDR;
  }

  int offset = 0;
  for (PLENTRY entry = decode_unit->bufferList; entry != NULL; entry = entry->next) {
    if (entry->length <= 0) {
      continue;
    }

    memcpy(frame + offset, entry->data, (size_t)entry->length);
    offset += entry->length;
  }

  int result = ml_video_frame(frame, offset, decode_unit->frameNumber, decode_unit->frameType,
    (double)decode_unit->presentationTimeUs, decode_unit->rtpTimestamp);
  free(frame);
  return result;
}

static int bridge_audio_init(int audio_configuration, const POPUS_MULTISTREAM_CONFIGURATION opus_config,
  void* context, int ar_flags) {
  (void)context;
  (void)ar_flags;

  if (opus_config == NULL) {
    return ml_audio_init(audio_configuration, 0, 0, 0);
  }

  return ml_audio_init(audio_configuration, opus_config->sampleRate, opus_config->channelCount,
    opus_config->samplesPerFrame);
}

static void bridge_audio_start(void) {
  ml_audio_start();
}

static void bridge_audio_stop(void) {
  ml_audio_stop();
}

static void bridge_audio_cleanup(void) {
  ml_audio_cleanup();
}

static void bridge_audio_packet(char* sample_data, int sample_length) {
  ml_audio_packet(sample_data, sample_length);
}

// Connection parameters owned by the connection worker thread. moonlight holds
// onto serverInfo string pointers for the lifetime of the connection, so we
// strdup them here (the JS-allocated originals are freed as soon as
// ml_start_connection returns) and keep them alive until the next start/stop.
struct conn_params {
  char* address;
  char* app_version;
  char* gfe_version;
  char* rtsp_session_url;
  int codec_mode_support;
  int width;
  int height;
  int fps;
  int bitrate_kbps;
  int audio_channels;
  int video_format;
  int packet_size;
  int streaming_remotely;
  unsigned char ri_key[16];
  bool has_ri_key;
  unsigned char ri_iv[16];
  bool has_ri_iv;
};

static struct conn_params* g_conn_params = NULL;

static char* dup_str(const char* s) {
  if (s == NULL || s[0] == '\0') {
    return NULL;
  }
  size_t n = strlen(s) + 1;
  char* d = (char*)malloc(n);
  if (d != NULL) {
    memcpy(d, s, n);
  }
  return d;
}

static void free_conn_params(struct conn_params* p) {
  if (p == NULL) {
    return;
  }
  free(p->address);
  free(p->app_version);
  free(p->gfe_version);
  free(p->rtsp_session_url);
  free(p);
}

// Runs the full LiStartConnection handshake on a background thread. moonlight
// spawns its own receive/decode threads from here; all of those threads do
// their socket/crypto I/O by proxying to the main browser thread, so this
// thread (and its children) are free to block. Running this off the browser
// main thread is mandatory: the main thread must stay in its event loop to
// service those proxied async operations.
static void* connection_thread(void* arg) {
  struct conn_params* p = (struct conn_params*)arg;

  SERVER_INFORMATION server_info;
  STREAM_CONFIGURATION stream_config;
  CONNECTION_LISTENER_CALLBACKS connection_callbacks;
  DECODER_RENDERER_CALLBACKS video_callbacks;
  AUDIO_RENDERER_CALLBACKS audio_callbacks;

  LiInitializeServerInformation(&server_info);
  LiInitializeStreamConfiguration(&stream_config);
  LiInitializeConnectionCallbacks(&connection_callbacks);
  LiInitializeVideoCallbacks(&video_callbacks);
  LiInitializeAudioCallbacks(&audio_callbacks);

  server_info.address = p->address;
  server_info.serverInfoAppVersion = p->app_version;
  server_info.serverInfoGfeVersion = p->gfe_version;
  server_info.rtspSessionUrl = p->rtsp_session_url;
  server_info.serverCodecModeSupport = p->codec_mode_support;

  stream_config.width = p->width;
  stream_config.height = p->height;
  stream_config.fps = p->fps;
  stream_config.bitrate = p->bitrate_kbps;
  stream_config.packetSize = p->packet_size;
  stream_config.streamingRemotely = p->streaming_remotely;
  stream_config.audioConfiguration = audio_configuration_from_channels(p->audio_channels);
  stream_config.supportedVideoFormats = p->video_format;
  stream_config.clientRefreshRateX100 = p->fps * 100;
  stream_config.encryptionFlags = ENCFLG_ALL;

  if (p->has_ri_key) {
    memcpy(stream_config.remoteInputAesKey, p->ri_key, sizeof(stream_config.remoteInputAesKey));
  }
  if (p->has_ri_iv) {
    memcpy(stream_config.remoteInputAesIv, p->ri_iv, sizeof(stream_config.remoteInputAesIv));
  }

  connection_callbacks.stageStarting = bridge_stage_starting;
  connection_callbacks.stageComplete = bridge_stage_complete;
  connection_callbacks.stageFailed = bridge_stage_failed;
  connection_callbacks.connectionStarted = bridge_connection_started;
  connection_callbacks.connectionTerminated = bridge_connection_terminated;

  video_callbacks.setup = bridge_video_setup;
  video_callbacks.start = bridge_video_start;
  video_callbacks.stop = bridge_video_stop;
  video_callbacks.cleanup = bridge_video_cleanup;
  video_callbacks.submitDecodeUnit = bridge_submit_decode_unit;
  video_callbacks.capabilities = CAPABILITY_DIRECT_SUBMIT;

  audio_callbacks.init = bridge_audio_init;
  audio_callbacks.start = bridge_audio_start;
  audio_callbacks.stop = bridge_audio_stop;
  audio_callbacks.cleanup = bridge_audio_cleanup;
  audio_callbacks.decodeAndPlaySample = bridge_audio_packet;
  audio_callbacks.capabilities = CAPABILITY_DIRECT_SUBMIT | CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION;

  int result = LiStartConnection(&server_info, &stream_config, &connection_callbacks, &video_callbacks,
    &audio_callbacks, NULL, 0, NULL, 0);

  ml_connection_result(result);
  return NULL;
}

EMSCRIPTEN_KEEPALIVE
int ml_start_connection(const char* address, const char* app_version, const char* gfe_version,
  const char* rtsp_session_url, int codec_mode_support, int width, int height, int fps,
  int bitrate_kbps, int audio_channels, int video_format, int packet_size, int streaming_remotely,
  const unsigned char* ri_key, int ri_key_len, const unsigned char* ri_iv, int ri_iv_len) {
  struct conn_params* p = (struct conn_params*)calloc(1, sizeof(*p));
  if (p == NULL) {
    ml_connection_result(-1);
    return -1;
  }

  p->address = dup_str(address);
  p->app_version = dup_str(app_version);
  p->gfe_version = dup_str(gfe_version);
  p->rtsp_session_url = dup_str(rtsp_session_url);
  p->codec_mode_support = codec_mode_support;
  p->width = width;
  p->height = height;
  p->fps = fps;
  p->bitrate_kbps = bitrate_kbps;
  p->audio_channels = audio_channels;
  p->video_format = video_format;
  p->packet_size = packet_size;
  p->streaming_remotely = streaming_remotely;

  if (ri_key != NULL && ri_key_len >= 16) {
    memcpy(p->ri_key, ri_key, sizeof(p->ri_key));
    p->has_ri_key = true;
  }
  if (ri_iv != NULL && ri_iv_len >= 16) {
    memcpy(p->ri_iv, ri_iv, sizeof(p->ri_iv));
    p->has_ri_iv = true;
  }

  free_conn_params(g_conn_params);
  g_conn_params = p;

  pthread_t thread;
  if (pthread_create(&thread, NULL, connection_thread, p) != 0) {
    free_conn_params(g_conn_params);
    g_conn_params = NULL;
    ml_connection_result(-1);
    return -1;
  }
  pthread_detach(thread);

  // Fire-and-forget: the real outcome arrives via ml_connection_result once
  // LiStartConnection returns on the worker.
  return 0;
}

static void* stop_thread(void* arg) {
  (void)arg;
  LiStopConnection();
  return NULL;
}

EMSCRIPTEN_KEEPALIVE
void ml_stop_connection(void) {
  // LiStopConnection joins moonlight's worker threads. Those threads may be
  // blocked in a proxied-sync socket recv on the main thread, so the join must
  // NOT run on the main thread (it would freeze the event loop that has to
  // service their I/O). Run it on its own worker instead.
  pthread_t thread;
  if (pthread_create(&thread, NULL, stop_thread, NULL) == 0) {
    pthread_detach(thread);
  } else {
    LiStopConnection();
  }
}

EMSCRIPTEN_KEEPALIVE
void ml_interrupt_connection(void) {
  LiInterruptConnection();
}

EMSCRIPTEN_KEEPALIVE
int ml_send_keyboard(int key_code, int key_action, int modifiers) {
  return LiSendKeyboardEvent((short)key_code, (char)key_action, (char)modifiers);
}

EMSCRIPTEN_KEEPALIVE
int ml_send_mouse_move(int delta_x, int delta_y) {
  return LiSendMouseMoveEvent((short)delta_x, (short)delta_y);
}

EMSCRIPTEN_KEEPALIVE
int ml_send_mouse_button(int button, int action) {
  return LiSendMouseButtonEvent((char)action, button);
}

EMSCRIPTEN_KEEPALIVE
int ml_send_high_res_scroll(int scroll_amount) {
  return LiSendHighResScrollEvent((short)scroll_amount);
}

EMSCRIPTEN_KEEPALIVE
void ml_request_idr_frame(void) {
  LiRequestIdrFrame();
}

EMSCRIPTEN_KEEPALIVE
int ml_get_estimated_rtt(uint32_t* estimated_rtt, uint32_t* estimated_rtt_variance) {
  return LiGetEstimatedRttInfo(estimated_rtt, estimated_rtt_variance) ? 1 : 0;
}

static int audio_configuration_from_channels(int audio_channels) {
  switch (audio_channels) {
    case 6:
      return AUDIO_CONFIGURATION_51_SURROUND;
    case 8:
      return AUDIO_CONFIGURATION_71_SURROUND;
    case 2:
    default:
      return AUDIO_CONFIGURATION_STEREO;
  }
}
