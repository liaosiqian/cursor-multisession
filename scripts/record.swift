#!/usr/bin/env swift

import Foundation
import AVFoundation

guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: record <output-file.wav>\nSend SIGINT (Ctrl+C) or SIGTERM to stop.\n", stderr)
    exit(1)
}

let outputPath = CommandLine.arguments[1]
let outputURL = URL(fileURLWithPath: outputPath)

switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized:
    break
case .notDetermined:
    let sem = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        if !granted {
            fputs("Error: microphone access denied by user\n", stderr)
            exit(1)
        }
        sem.signal()
    }
    sem.wait()
case .denied, .restricted:
    fputs("Error: microphone access denied. Open System Settings > Privacy & Security > Microphone and enable access.\n", stderr)
    exit(1)
@unknown default:
    fputs("Error: unknown microphone authorization status\n", stderr)
    exit(1)
}

let engine = AVAudioEngine()
let inputNode = engine.inputNode
let bus: AVAudioNodeBus = 0
let inputFormat = inputNode.outputFormat(forBus: bus)

fputs("Info: input format: \(inputFormat)\n", stderr)

let recordingFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: 16000,
    channels: 1,
    interleaved: false
)!

guard let converter = AVAudioConverter(from: inputFormat, to: recordingFormat) else {
    fputs("Error: cannot create audio converter\n", stderr)
    exit(1)
}

let settings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatLinearPCM),
    AVSampleRateKey: 16000,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
]

guard let audioFile = try? AVAudioFile(forWriting: outputURL, settings: settings) else {
    fputs("Error: cannot create output file at \(outputPath)\n", stderr)
    exit(1)
}

var isRunning = true
var totalFrames: UInt64 = 0

signal(SIGINT) { _ in
    isRunning = false
}
signal(SIGTERM) { _ in
    isRunning = false
}

inputNode.installTap(onBus: bus, bufferSize: 4096, format: inputFormat) { buffer, _ in
    let frameCount = AVAudioFrameCount(
        Double(buffer.frameLength) * recordingFormat.sampleRate / inputFormat.sampleRate
    )
    guard let convertedBuffer = AVAudioPCMBuffer(pcmFormat: recordingFormat, frameCapacity: frameCount) else { return }

    var error: NSError?
    converter.convert(to: convertedBuffer, error: &error) { _, outStatus in
        outStatus.pointee = .haveData
        return buffer
    }

    if error == nil, convertedBuffer.frameLength > 0 {
        try? audioFile.write(from: convertedBuffer)
        totalFrames += UInt64(convertedBuffer.frameLength)
    }
}

do {
    try engine.start()
    fputs("Recording... (send SIGINT or SIGTERM to stop)\n", stderr)
    print("RECORDING_STARTED")
    fflush(stdout)
} catch {
    fputs("Error: \(error.localizedDescription)\n", stderr)
    exit(1)
}

while isRunning {
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
}

engine.stop()
inputNode.removeTap(onBus: bus)
let durationSec = Double(totalFrames) / 16000.0
fputs("Recording saved to \(outputPath) (\(totalFrames) frames, \(String(format: "%.1f", durationSec))s)\n", stderr)
print("RECORDING_STOPPED")
