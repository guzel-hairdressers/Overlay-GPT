import Foundation
import Speech

// ─── Native macOS speech-to-text using SFSpeechRecognizer ──────────────────
// Usage: stt <audio-file-path>
// Output: transcript text to stdout, errors to stderr

let args = CommandLine.arguments
guard args.count > 1 else {
    fputs("Usage: stt <audio-file>\n", stderr)
    exit(1)
}

let audioURL = URL(fileURLWithPath: args[1])
guard FileManager.default.fileExists(atPath: args[1]) else {
    fputs("ERROR: File not found at \(args[1])\n", stderr)
    exit(1)
}

let group = DispatchGroup()
var transcript: String?
var sttError: String?

group.enter()

SFSpeechRecognizer.requestAuthorization { status in
    defer { group.leave() }

    guard status == .authorized else {
        sttError = "Speech recognition not authorized. Grant permission in System Settings > Privacy & Security > Speech Recognition."
        return
    }

    guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
        sttError = "Speech recognizer not available on this device."
        return
    }

    let request = SFSpeechURLRecognitionRequest(url: audioURL)
    request.requiresOnDeviceRecognition = true   // offline, no network needed
    request.shouldReportPartialResults = false

    group.enter()
    recognizer.recognitionTask(with: request) { result, error in
        defer { group.leave() }

        if let error = error as NSError? {
            // kAFAssistantErrorDomain code 203 = no speech detected
            if error.domain == "kAFAssistantErrorDomain" && error.code == 203 {
                sttError = "No speech detected in the recording."
            } else {
                sttError = error.localizedDescription
            }
            return
        }

        if let result = result, result.isFinal {
            transcript = result.bestTranscription.formattedString
        }
    }
}

group.wait()

if let error = sttError {
    fputs("ERROR: \(error)\n", stderr)
    exit(1)
}

let output = transcript?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
if output.isEmpty {
    fputs("ERROR: No transcript produced.\n", stderr)
    exit(1)
}

print(output)
exit(0)
