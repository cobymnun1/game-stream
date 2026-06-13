// Direct Sockets and browser callbacks for the Emscripten build.
// The host TypeScript wrapper injects Module.moonlightTransport and
// Module.moonlightCallbacks when instantiating the generated module.
//
// THREADING MODEL (pthreads, no ASYNCIFY):
// moonlight runs its RTSP/control/video/audio loops on background Web Worker
// threads. The Direct Sockets transport and the WebCodecs/UI callbacks only
// exist on the main browser thread (where Module is configured). So every
// function here that touches the transport or callbacks is proxied to the main
// thread:
//   * async I/O (sockets, crypto)  -> __proxy:'sync' + __async:true
//       The calling worker blocks on a futex until the main thread resolves the
//       returned promise, then receives the resolved value. wasm memory is a
//       SharedArrayBuffer, so HEAPU8 reads/writes done on the main thread are
//       visible to the worker (and vice-versa) without copying.
//   * void cleanup (socket_close) -> __proxy:'async'  (fire-and-forget, never
//       blocks, avoids any chance of a main-thread self-deadlock during stop)
//   * host callbacks (stages, frames, audio) -> __proxy:'sync' so they run on
//       the main thread where Module.moonlightCallbacks is defined.
// crypto_random stays thread-local: crypto.getRandomValues is synchronous and
// available on workers, so it needs no proxy.

mergeInto(LibraryManager.library, {
  $getTransport: function() {
    const transport = Module['moonlightTransport']
    if (!transport) throw new Error('Moonlight transport has not been configured')
    return transport
  },

  $getCallbacks: function() {
    return Module['moonlightCallbacks'] || {}
  },

  $copyFromHeap: function(dataPtr, length) {
    return HEAPU8.slice(dataPtr, dataPtr + length)
  },

  $writeInt: function(ptr, value) {
    HEAP32[ptr >> 2] = value
  },

  $cryptoAlgorithmName: function(algorithm) {
    if (algorithm === 1) return 'AES-CBC'
    if (algorithm === 2) return 'AES-GCM'
    throw new Error(`Unsupported crypto algorithm ${algorithm}`)
  },

  // Called by the C platform layer instead of socket() + connect().
  // NOTE: these proxied-sync-async bridges must be declared as *non-async*
  // functions that RETURN a promise. emscripten's jsifier copies the `async`
  // keyword from this source onto the worker-side proxy stub; if the stub is
  // async it returns a Promise that wasm coerces to 0 instead of the value the
  // worker blocked for. Returning an inner async IIFE keeps the worker stub
  // synchronous (it returns proxyToMainThread()'s value) while the main thread
  // still gets a real promise for PROXY_SYNC_ASYNC to await.
  socket_connect__deps: ['$getTransport', '$UTF8ToString'],
  socket_connect__async: true,
  socket_connect__proxy: 'sync',
  socket_connect: function(hostPtr, port, isUdp) {
    return (async () => {
      const host = UTF8ToString(hostPtr)
      try {
        return await getTransport().connect(host, port, isUdp ? 'udp' : 'tcp')
      } catch (err) {
        return -1
      }
    })()
  },

  socket_bind_udp__deps: ['$getTransport'],
  socket_bind_udp__async: true,
  socket_bind_udp__proxy: 'sync',
  socket_bind_udp: function(localPort) {
    return (async () => {
      try {
        return await getTransport().bindUdp(localPort || undefined)
      } catch (err) {
        return -1
      }
    })()
  },

  socket_send__deps: ['$getTransport', '$copyFromHeap'],
  socket_send__async: true,
  socket_send__proxy: 'sync',
  socket_send: function(fd, dataPtr, length) {
    return (async () => {
      const data = copyFromHeap(dataPtr, length)
      try {
        return await getTransport().send(fd, data)
      } catch (err) {
        return -1
      }
    })()
  },

  // TCP recv: returns the number of bytes read, 0 on orderly peer close
  // (end-of-stream), or -1 on error. moonlight's RTSP loop relies on 0
  // meaning "done reading", so we must not collapse close into an error.
  socket_recv__deps: ['$getTransport'],
  socket_recv__async: true,
  socket_recv__proxy: 'sync',
  socket_recv: function(fd, bufPtr, maxLength) {
    return (async () => {
      try {
        const data = await getTransport().recv(fd, maxLength)
        if (data.length > 0) HEAPU8.set(data, bufPtr)
        return data.length
      } catch (err) {
        return -1
      }
    })()
  },

  socket_sendto__deps: ['$getTransport', '$copyFromHeap', '$UTF8ToString'],
  socket_sendto__async: true,
  socket_sendto__proxy: 'sync',
  socket_sendto: function(fd, dataPtr, length, hostPtr, port) {
    return (async () => {
      const host = hostPtr ? UTF8ToString(hostPtr) : undefined
      const data = copyFromHeap(dataPtr, length)
      try {
        return await getTransport().sendTo(fd, data, host, port || undefined)
      } catch (err) {
        return -1
      }
    })()
  },

  socket_recvfrom__deps: ['$getTransport'],
  socket_recvfrom__async: true,
  socket_recvfrom__proxy: 'sync',
  socket_recvfrom: function(fd, bufPtr, maxLength) {
    return (async () => {
      try {
        const data = await getTransport().recvFrom(fd, maxLength)
        if (data.length === 0) return -1
        HEAPU8.set(data, bufPtr)
        return data.length
      } catch (err) {
        return -1
      }
    })()
  },

  // ENet control-stream receive: waits up to timeoutMs for a datagram on the
  // given UDP fd. Returns the byte count (>0), 0 when no datagram arrived in
  // time (ENet treats this as EWOULDBLOCK / timeout), or -1 on error.
  enet_udp_recv__deps: ['$getTransport'],
  enet_udp_recv__async: true,
  enet_udp_recv__proxy: 'sync',
  enet_udp_recv: function(fd, bufPtr, maxLength, timeoutMs) {
    return (async () => {
      try {
        const data = await getTransport().recvFromTimed(fd, maxLength, timeoutMs)
        if (data.length === 0) return 0
        HEAPU8.set(data, bufPtr)
        return data.length
      } catch (err) {
        return -1
      }
    })()
  },

  socket_close__deps: ['$getTransport'],
  socket_close__proxy: 'async',
  socket_close: function(fd) {
    try {
      getTransport().close(fd)
    } catch (err) {}
  },

  // #region agent log
  // C-callable debug log (proxied to main thread, fire-and-forget) used to
  // trace the RTSP handshake running on the connection worker thread.
  ml_dbg__deps: ['$UTF8ToString'],
  ml_dbg__proxy: 'async',
  ml_dbg: function(tagPtr, a, b) {
    const tag = UTF8ToString(tagPtr)
    fetch('http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '31fcc6' },
      body: JSON.stringify({
        sessionId: '31fcc6',
        runId: 'rtsp-thread-dbg',
        hypothesisId: 'H60,H61,H62,H63',
        location: 'vendor/moonlight-common-c/src/RtspConnection.c',
        message: tag,
        data: { a, b },
        timestamp: Date.now(),
      }),
    }).catch(() => {})
  },
  // #endregion

  // With pthreads the wasm heap is a SharedArrayBuffer; crypto.getRandomValues
  // can reject shared-memory views, so fill a private buffer then copy in.
  crypto_random: function(dataPtr, length) {
    const buf = new Uint8Array(length)
    crypto.getRandomValues(buf)
    HEAPU8.set(buf, dataPtr)
  },

  crypto_encrypt__deps: ['$copyFromHeap', '$writeInt', '$cryptoAlgorithmName'],
  crypto_encrypt__async: true,
  crypto_encrypt__proxy: 'sync',
  crypto_encrypt: function(algorithm, flags, keyPtr, keyLength, ivPtr, ivLength, tagPtr, tagLength,
    inputPtr, inputLength, outputPtr, outputLengthPtr) {
    return (async () => {
      const keyBytes = copyFromHeap(keyPtr, keyLength)
      const iv = copyFromHeap(ivPtr, ivLength)
      const input = copyFromHeap(inputPtr, inputLength)
      try {
        const key = await crypto.subtle.importKey(
          'raw', keyBytes, { name: cryptoAlgorithmName(algorithm) }, false, ['encrypt', 'decrypt'])
        const encrypted = new Uint8Array(await crypto.subtle.encrypt(
          algorithm === 1
            ? { name: 'AES-CBC', iv }
            : { name: 'AES-GCM', iv, tagLength: tagLength * 8 },
          key,
          input,
        ))

        if (algorithm === 2 && tagPtr && tagLength > 0) {
          const ciphertextLength = encrypted.length - tagLength
          HEAPU8.set(encrypted.slice(ciphertextLength), tagPtr)
          HEAPU8.set(encrypted.slice(0, ciphertextLength), outputPtr)
          writeInt(outputLengthPtr, ciphertextLength)
        } else {
          HEAPU8.set(encrypted, outputPtr)
          writeInt(outputLengthPtr, encrypted.length)
        }

        return 1
      } catch (err) {
        console.warn('[moonlight crypto] encrypt failed', err, { algorithm, flags })
        return 0
      }
    })()
  },

  crypto_decrypt__deps: ['$copyFromHeap', '$writeInt', '$cryptoAlgorithmName'],
  crypto_decrypt__async: true,
  crypto_decrypt__proxy: 'sync',
  crypto_decrypt: function(algorithm, flags, keyPtr, keyLength, ivPtr, ivLength, tagPtr, tagLength,
    inputPtr, inputLength, outputPtr, outputLengthPtr) {
    return (async () => {
      const keyBytes = copyFromHeap(keyPtr, keyLength)
      const iv = copyFromHeap(ivPtr, ivLength)
      let input = copyFromHeap(inputPtr, inputLength)
      if (algorithm === 2 && tagPtr && tagLength > 0) {
        const combined = new Uint8Array(inputLength + tagLength)
        combined.set(input)
        combined.set(copyFromHeap(tagPtr, tagLength), inputLength)
        input = combined
      }
      try {
        const key = await crypto.subtle.importKey(
          'raw', keyBytes, { name: cryptoAlgorithmName(algorithm) }, false, ['encrypt', 'decrypt'])
        const decrypted = new Uint8Array(await crypto.subtle.decrypt(
          algorithm === 1
            ? { name: 'AES-CBC', iv }
            : { name: 'AES-GCM', iv, tagLength: tagLength * 8 },
          key,
          input,
        ))

        HEAPU8.set(decrypted, outputPtr)
        writeInt(outputLengthPtr, decrypted.length)
        return 1
      } catch (err) {
        console.warn('[moonlight crypto] decrypt failed', err, { algorithm, flags })
        return 0
      }
    })()
  },

  ml_stage_starting__deps: ['$getCallbacks', '$UTF8ToString'],
  ml_stage_starting__proxy: 'sync',
  ml_stage_starting: function(stage, namePtr) {
    getCallbacks().onStage?.({ stage, phase: 'starting', name: UTF8ToString(namePtr) })
  },

  ml_stage_complete__deps: ['$getCallbacks', '$UTF8ToString'],
  ml_stage_complete__proxy: 'sync',
  ml_stage_complete: function(stage, namePtr) {
    getCallbacks().onStage?.({ stage, phase: 'complete', name: UTF8ToString(namePtr) })
  },

  ml_stage_failed__deps: ['$getCallbacks', '$UTF8ToString'],
  ml_stage_failed__proxy: 'sync',
  ml_stage_failed: function(stage, errorCode, namePtr) {
    getCallbacks().onStage?.({ stage, phase: 'failed', errorCode, name: UTF8ToString(namePtr) })
  },

  ml_connection_started__deps: ['$getCallbacks'],
  ml_connection_started__proxy: 'sync',
  ml_connection_started: function() {
    getCallbacks().onConnectionStarted?.()
  },

  ml_connection_terminated__deps: ['$getCallbacks'],
  ml_connection_terminated__proxy: 'sync',
  ml_connection_terminated: function(errorCode) {
    getCallbacks().onConnectionTerminated?.(errorCode)
  },

  // Fired once by the connection worker after LiStartConnection returns,
  // carrying its result code (0 = streams established). This is how the host
  // learns the outcome now that ml_start_connection is fire-and-forget.
  ml_connection_result__deps: ['$getCallbacks'],
  ml_connection_result__proxy: 'sync',
  ml_connection_result: function(code) {
    getCallbacks().onConnectionResult?.(code)
  },

  ml_video_setup__deps: ['$getCallbacks'],
  ml_video_setup__proxy: 'sync',
  ml_video_setup: function(videoFormat, width, height, redrawRate) {
    const codec = (videoFormat & 0x1000) !== 0 ? 'av1'
      : (videoFormat & 0x0100) !== 0 ? 'hevc'
        : 'h264'
    getCallbacks().onVideoFormat?.({
      codec,
      width,
      height,
      fps: redrawRate,
      rawFormat: videoFormat,
    })
    return 0
  },

  ml_video_start: function() {},
  ml_video_stop: function() {},
  ml_video_cleanup: function() {},

  ml_video_frame__deps: ['$getCallbacks', '$copyFromHeap'],
  ml_video_frame__proxy: 'sync',
  ml_video_frame: function(dataPtr, length, frameNumber, frameType, presentationTimeUs, rtpTimestamp) {
    getCallbacks().onVideoFrame?.({
      data: copyFromHeap(dataPtr, length),
      frameIndex: frameNumber,
      type: frameType === 1 ? 'idr' : 'pframe',
      timestampUs: presentationTimeUs,
      rtpTimestamp,
    })
    return 0
  },

  ml_audio_init__deps: ['$getCallbacks'],
  ml_audio_init__proxy: 'sync',
  ml_audio_init: function(audioConfiguration, sampleRate, channelCount, samplesPerFrame) {
    getCallbacks().onAudioFormat?.({
      audioConfiguration,
      sampleRate,
      channelCount,
      samplesPerFrame,
    })
    return 0
  },

  ml_audio_start: function() {},
  ml_audio_stop: function() {},
  ml_audio_cleanup: function() {},

  ml_audio_packet__deps: ['$getCallbacks', '$copyFromHeap'],
  ml_audio_packet__proxy: 'sync',
  ml_audio_packet: function(dataPtr, length) {
    getCallbacks().onAudioPacket?.({ data: copyFromHeap(dataPtr, length) })
  },
})
