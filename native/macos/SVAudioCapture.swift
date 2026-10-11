import Foundation
import AppKit
import CoreAudio
import AVFoundation

let bundleID = "com.dreamtonics.svstudio2.pro"
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}
struct CaptureError: Error { let message: String }
func checked(_ status: OSStatus, _ operation: String) throws {
    if status != noErr { throw CaptureError(message: "\(operation): OSStatus \(status)") }
}
func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}
func targets() throws -> [AudioObjectID] {
    var a = address(kAudioHardwarePropertyProcessObjectList), size: UInt32 = 0
    try checked(AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size), "process list size")
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    try checked(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids), "process list")
    return ids.filter { id in
        var b = address(kAudioProcessPropertyPID), pid: pid_t = 0, s = UInt32(MemoryLayout<pid_t>.size)
        guard AudioObjectGetPropertyData(id, &b, 0, nil, &s, &pid) == noErr else { return false }
        return NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == bundleID
    }
}

@available(macOS 14.2, *)
final class Capture {
    var tap: AudioObjectID = 0, device: AudioObjectID = 0
    var proc: AudioDeviceIOProcID?
    var file: AVAudioFile?
    let writer = DispatchQueue(label: "sv.audio.writer")
    let lock = NSLock()
    var pending = 0, dropped = 0, writeError: String?
    var frames: Int64 = 0, sampleCount: Int64 = 0, nonzero: Int64 = 0, invalidSamples: Int64 = 0
    var squareSum: Double = 0, peak: Float = 0
    var firstSignalFrame: Int64?
    var stopReason = "unknown"
    var format: AVAudioFormat!
    var started = false
    func requestStop(_ reason: String) {
        lock.lock()
        if stopReason == "unknown" { stopReason = reason }
        lock.unlock()
        CFRunLoopStop(CFRunLoopGetMain())
    }
    func start(path: String) throws {
        let processes = try targets()
        guard !processes.isEmpty else { throw CaptureError(message: "SV2 is not running or has no Core Audio process object") }
        let desc = CATapDescription(stereoMixdownOfProcesses: processes)
        desc.name = "SV Agent Capture"; desc.isPrivate = true; desc.muteBehavior = .unmuted
        try checked(AudioHardwareCreateProcessTap(desc, &tap), "create SV2 process tap")
        var a = address(kAudioTapPropertyFormat), asbd = AudioStreamBasicDescription(), size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try checked(AudioObjectGetPropertyData(tap, &a, 0, nil, &size, &asbd), "tap format")
        guard let fmt = AVAudioFormat(streamDescription: &asbd), fmt.commonFormat == .pcmFormatFloat32 else {
            throw CaptureError(message: "Unsupported tap format; expected Float32 PCM")
        }
        format = fmt
        let spec: [String: Any] = [
            kAudioAggregateDeviceNameKey: "SV Agent Capture", kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true, kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: desc.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]]
        ]
        try checked(AudioHardwareCreateAggregateDevice(spec as CFDictionary, &device), "create private aggregate")
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: fmt.sampleRate,
            AVNumberOfChannelsKey: fmt.channelCount, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false]
        file = try AVAudioFile(forWriting: URL(fileURLWithPath: path), settings: settings, commonFormat: .pcmFormatFloat32, interleaved: fmt.isInterleaved)
        try checked(AudioDeviceCreateIOProcIDWithBlock(&proc, device, nil) { [weak self] _, input, _, _, _ in
            self?.receive(input)
        }, "create audio callback")
        try checked(AudioDeviceStart(device, proc), "start capture (system audio permission required)")
        started = true
        emit(["event": "ready", "sampleRate": fmt.sampleRate, "channels": fmt.channelCount, "processCount": processes.count])
    }
    func receive(_ input: UnsafePointer<AudioBufferList>) {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard let first = buffers.first, first.mDataByteSize > 0 else { return }
        let count = AVAudioFrameCount(first.mDataByteSize) / format.streamDescription.pointee.mBytesPerFrame
        guard count > 0 else { return }
        lock.lock()
        if pending >= 256 { dropped += 1; lock.unlock(); return }
        pending += 1; lock.unlock()
        guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else {
            lock.lock(); pending -= 1; dropped += 1; lock.unlock(); return
        }
        pcm.frameLength = count
        let output = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        guard output.count == buffers.count else {
            lock.lock(); pending -= 1; dropped += 1; lock.unlock(); return
        }
        guard buffers.indices.allSatisfy({ buffers[$0].mDataByteSize <= output[$0].mDataByteSize }) else {
            lock.lock(); pending -= 1; dropped += 1; lock.unlock(); return
        }
        for i in 0..<buffers.count {
            guard let dst = output[i].mData else { continue }
            // Core Audio may represent silence with a nil source buffer.
            memset(dst, 0, Int(output[i].mDataByteSize))
            if let src = buffers[i].mData { memcpy(dst, src, Int(buffers[i].mDataByteSize)) }
        }
        writer.async { [self] in
            do { try file?.write(from: pcm) } catch { writeError = error.localizedDescription }
            frames += Int64(count)
            for b in output {
                guard let data = b.mData?.assumingMemoryBound(to: Float.self) else { continue }
                for i in 0..<(Int(b.mDataByteSize) / MemoryLayout<Float>.size) {
                    let value = data[i]; let absolute = abs(value)
                    if absolute.isFinite { peak = max(peak, absolute); squareSum += Double(value) * Double(value); if absolute > 0.000001 {
                        nonzero += 1
                        let position = frames - Int64(count) + Int64(format.isInterleaved ? i / Int(format.channelCount) : i)
                        firstSignalFrame = min(firstSignalFrame ?? position, position)
                    }; sampleCount += 1 } else { invalidSamples += 1 }
                }
            }
            lock.lock(); pending -= 1; lock.unlock()
        }
    }
    func stop() -> [String: Any] {
        if started { AudioDeviceStop(device, proc); started = false }
        if let proc { AudioDeviceDestroyIOProcID(device, proc); self.proc = nil }
        writer.sync { file = nil }
        if device != 0 { AudioHardwareDestroyAggregateDevice(device); device = 0 }
        if tap != 0 { AudioHardwareDestroyProcessTap(tap); tap = 0 }
        lock.lock(); let reason = stopReason; lock.unlock()
        var result: [String: Any] = ["event": "complete", "frames": frames, "sampleRate": format?.sampleRate ?? 0,
            "channels": format?.channelCount ?? 0, "durationSeconds": Double(frames) / (format?.sampleRate ?? 1), "peak": peak,
            "rms": sampleCount > 0 ? sqrt(squareSum / Double(sampleCount)) : 0,
            "nonzeroSamples": nonzero, "droppedBuffers": dropped, "invalidSamples": invalidSamples, "stopReason": reason]
        if let firstSignalFrame { result["firstSignalSeconds"] = Double(firstSignalFrame) / format.sampleRate }
        if let writeError { result["error"] = writeError }
        return result
    }
}

if #available(macOS 14.2, *) {
    if CommandLine.arguments.contains("--probe") {
        do { let ids = try targets(); emit(["event": "status", "supported": true, "bundleId": bundleID, "processCount": ids.count]) }
        catch { emit(["event": "error", "message": String(describing: error)]); exit(1) }
    } else {
        guard CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--record", let maximum = Double(CommandLine.arguments[3]), maximum > 0, maximum <= 180 else {
            emit(["event": "error", "message": "Usage: SVAudioCapture --record OUTPUT.wav MAX_SECONDS"]); exit(1)
        }
        let capture = Capture()
        do {
            try capture.start(path: CommandLine.arguments[2])
            DispatchQueue.global().async {
                let command = readLine()
                capture.requestStop(command == "stop" ? "command" : command == nil ? "eof" : "invalid_command")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + maximum) { capture.requestStop("timeout") }
            signal(SIGTERM, SIG_IGN)
            signal(SIGINT, SIG_IGN)
            let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
            let interruption = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
            termination.setEventHandler { capture.requestStop("signal") }
            interruption.setEventHandler { capture.requestStop("signal") }
            termination.resume(); interruption.resume()
            CFRunLoopRun()
            termination.cancel(); interruption.cancel()
            emit(capture.stop())
        } catch { _ = capture.stop(); emit(["event": "error", "message": String(describing: error)]); exit(1) }
    }
} else { emit(["event": "error", "message": "macOS 14.2 or newer is required"]); exit(1) }
