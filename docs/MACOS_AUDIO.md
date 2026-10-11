# macOS SV2 playback capture

The optional Swift helper requires macOS 14.2+ and Xcode Command Line Tools. Build with `npm run build-audio`. The source is maintained in `native/macos/`; `.build/macos/SVAudioCapture.app` is a locally built, ad-hoc signed application bundle with `NSAudioCaptureUsageDescription`. Rebuild after source changes. No third-party audio driver is installed.

## Capture path

The helper enumerates Core Audio process objects and matches their PID to the running application bundle `com.dreamtonics.svstudio2.pro`. A stereo `CATapDescription` contains only those objects. It is private, non-exclusive and unmuted; other applications are not included and SV2 remains audible through its normal output. A private aggregate device delivers Float32 PCM to the IO callback. The aggregate tap does not wait for the first SV2 sound before starting, allowing readiness to precede playback.

The callback copies PCM into a bounded writer queue. AVAudioFile writes a Float32 WAV; peak, RMS, nonzero sample count, frames, channels, sample rate, first signal position dropped-buffer count and invalid-sample count are returned. A full writer queue increments the drop counter; it never silently reports an intact take. Device start/stop, IO proc and tap cleanup happen in the helper. EOF, SIGINT, SIGTERM and a maximum duration all end capture. Completion reports the first stop reason; only an explicit stop command can produce a successful take.

Apple's [Core Audio tap guide](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps) describes the API and system audio recording permission. A probe is not a permission grant. macOS may attribute the permission to the launching application. If access is denied, the helper can produce silence; silence is rejected by the coordinator. No TCC database is edited and no permission restriction is bypassed. A sandbox can return zero process objects even while SV2 is running; use a launcher with Core Audio access.

## MCP orchestration

`sv_audio_status` reports platform/build status and process availability without recording. `sv_capture_audio` requires `sessionId`, a stable `requestId`, `startSeconds` and `durationSeconds` (0.5–120). `tailSeconds` defaults to 0.3 and is limited to 3. The client should allow at least the requested duration plus 40 seconds for a call; the included CLI allows 180 seconds.

The coordinator requires stopped playback, reserves a new WAV path, and persists an `executing` receipt before starting capture. It waits for the helper's readiness, seeks and plays, polls the host playhead until the requested end, stops playback, records the stopped-playback tail and restores the previous position. It rejects a backwards or stalled playhead, interrupted playback, missing audio, a short recording, dropped buffers, nonfinite PCM or a helper that ends before playback and the tail finish. Normal failure/cancellation closes the recorder and attempts to stop and restore playback in the pinned session. If the project/session has changed, cleanup does not control the new project and reports the cleanup error.

Files are local: `<queue>/recordings/<requestId>.wav` and `<requestId>.json`, with directory mode 0700 and file mode 0600. A shared filesystem lock permits only one capture per queue. Completed retries return the original result; a different payload with the same ID conflicts. A failed or interrupted ID never initiates another recording. `sv_get_audio_result` works without a live bridge and returns the full receipt, including failed/unfinished state. Failed WAVs remain available for diagnosis.

A process crash can leave an `executing` receipt, and Studio playback may still need to be stopped manually. A native helper crash or source process exit is not a completed take. Inspect the receipt and live project before using a new ID. Keep the journal and WAV together; do not delete deduplication records while retries are possible.

## Timing and signal scope

This is realtime playback capture, not Studio's offline export command. The WAV includes capture lead-in, file queue scheduling and the requested stopped-playback tail. Playhead polling can overshoot the requested end by a polling interval plus IPC latency. `playbackAcknowledgedOffsetSeconds` estimates the control acknowledgement offset; `firstSignalSeconds` identifies the first nonzero PCM frame. Neither promises a sample-accurate project origin. The native tap's stereo mixdown and float encoding are not a promise of equivalence to Studio's export settings.

All audible SV2 sources are captured: singers, accompaniment, metronome and effects. To capture one singer, read `sv_get_project_structure`, save all mixer states, apply `sv_set_track_mixer` with `solo: true` to the intended track, then restore the saved state after recording. Select an interval containing actual notes. Vocal mode names are caller-supplied singer-specific names; `getVoice()` does not enumerate database modes.

The live scripts use only `test_proj/agent_queue_test.svp`. `live-extended-test.mjs` exercises structural edits and a solo take; `live-render-test.mjs` raises the first vocal phrase by two semitones, captures newly synthesized playback and restores its pitches and mixer. Evidence stays in ignored `test_results/macos/`. Original project files and recordings are not committed.
