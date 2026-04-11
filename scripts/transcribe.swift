#!/usr/bin/env swift

import Foundation
import Speech

guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: transcribe <audio-file> [locale]\n", stderr)
    exit(1)
}

let filePath = CommandLine.arguments[1]
let localeId = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : "zh-CN"
let fileURL = URL(fileURLWithPath: filePath)

guard FileManager.default.fileExists(atPath: filePath) else {
    fputs("Error: file not found: \(filePath)\n", stderr)
    exit(1)
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
    fputs("Error: locale \(localeId) not supported\n", stderr)
    exit(1)
}

guard recognizer.isAvailable else {
    fputs("Error: speech recognizer not available for \(localeId)\n", stderr)
    exit(1)
}

let request = SFSpeechURLRecognitionRequest(url: fileURL)
request.shouldReportPartialResults = false

if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
}

var finished = false
var hadError = false

recognizer.recognitionTask(with: request) { result, error in
    if let error = error {
        fputs("Error: \(error.localizedDescription)\n", stderr)
        hadError = true
        finished = true
        return
    }
    guard let result = result else { return }
    if result.isFinal {
        let text = result.bestTranscription.formattedString
        if text.isEmpty {
            fputs("Error: empty transcription\n", stderr)
            hadError = true
        } else {
            print(text)
        }
        finished = true
    }
}

let deadline = Date().addingTimeInterval(30)
while !finished && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
}

if !finished {
    fputs("Error: recognition timed out\n", stderr)
    exit(1)
}

exit(hadError ? 1 : 0)
