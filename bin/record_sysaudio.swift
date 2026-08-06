import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

// Global for SIGINT handler
fileprivate var _globalRecorder: SystemAudioRecorder?

fileprivate func _sigintHandler(_: Int32) {
    _globalRecorder?.writeWavFile()
    fputs("DONE\n", stdout)
    fflush(stdout)
    _exit(0)
}

@available(macOS 13.0, *)
class SystemAudioRecorder: NSObject, SCStreamOutput {
    private var stream: SCStream?
    private let outputPath: String
    private var lastVolumeTime: Date = Date.distantPast
    private var audioData = Data()
    private var totalSamples: Int = 0

    init(outputPath: String) {
        self.outputPath = outputPath
        super.init()
    }

    func start() async throws {
        _globalRecorder = self
        signal(SIGINT, _sigintHandler)
        signal(SIGTERM, _sigintHandler)

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            fputs("Error: No display found for ScreenCaptureKit\n", stderr)
            exit(1)
        }

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = 16000
        config.channelCount = 1
        config.width = 2
        config.height = 2

        stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream?.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "sysaudio.queue"))
        try await stream?.startCapture()
        fputs("RECORDING\n", stdout)
        fflush(stdout)
    }

    func stop() async {
        if let s = stream {
            try? await s.stopCapture()
        }
        writeWavFile()
    }

    func writeWavFile() {
        let dataSize = UInt32(totalSamples * 2)       // Int16 = 2 bytes per sample
        let fileSize = dataSize + 36                   // RIFF size = data + 36

        var wav = Data(capacity: 44 + totalSamples * 2)

        // ── RIFF header ──
        wav.append(contentsOf: "RIFF".utf8)
        wav.append(packU32(fileSize))
        wav.append(contentsOf: "WAVE".utf8)

        // ── fmt  chunk ──
        wav.append(contentsOf: "fmt ".utf8)
        wav.append(packU32(16))           // chunk size
        wav.append(packU16(1))            // PCM
        wav.append(packU16(1))            // mono
        wav.append(packU32(16000))        // sample rate
        wav.append(packU32(32000))        // byte rate (16000 * 2)
        wav.append(packU16(2))            // block align
        wav.append(packU16(16))           // bits per sample

        // ── data chunk ──
        wav.append(contentsOf: "data".utf8)
        wav.append(packU32(dataSize))
        wav.append(audioData)

        try? wav.write(to: URL(fileURLWithPath: outputPath))
    }

    // Little-endian pack helpers
    private func packU32(_ v: UInt32) -> Data {
        var val = v.littleEndian
        return Data(bytes: &val, count: 4)
    }
    private func packU16(_ v: UInt16) -> Data {
        var val = v.littleEndian
        return Data(bytes: &val, count: 2)
    }

    @objc func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        do {
            try sampleBuffer.withAudioBufferList { audioBufferList, _ in
                let srcBuf = audioBufferList.unsafePointer.pointee.mBuffers
                let dataSize = Int(srcBuf.mDataByteSize)
                guard dataSize > 0, let srcPtr = srcBuf.mData else { return }

                let numSamples = sampleBuffer.numSamples
                guard numSamples > 0 else { return }

                // ScreenCaptureKit delivers Float32; convert to Int16 for WAV
                var chunk = Data(count: numSamples * 2)
                chunk.withUnsafeMutableBytes { (rawPtr: UnsafeMutableRawBufferPointer) in
                    let dst = rawPtr.bindMemory(to: Int16.self)
                    let srcFloat = srcPtr.bindMemory(to: Float32.self, capacity: dataSize / 4)
                    for i in 0..<numSamples {
                        let clamped = max(-1.0, min(1.0, srcFloat[i]))
                        dst[i] = Int16(clamped * 32767.0)
                    }
                }
                audioData.append(chunk)
                totalSamples += numSamples

                // Compute RMS dB from Float32 samples every ~100ms
                let now = Date()
                if now.timeIntervalSince(lastVolumeTime) >= 0.1 {
                    lastVolumeTime = now
                    let floatPtr = srcPtr.bindMemory(to: Float32.self, capacity: dataSize / 4)
                    let sampleCount = dataSize / 4
                    var sumSquares: Double = 0
                    for i in 0..<sampleCount {
                        let s = Double(floatPtr[i])
                        sumSquares += s * s
                    }
                    let rms = sqrt(sumSquares / Double(max(sampleCount, 1)))
                    let db = rms > 0.00003 ? 20.0 * log10(rms) : -90.0
                    let clampedDb = max(-90.0, min(0.0, db))
                    fputs("VOL:\(Int(round(clampedDb)))\n", stdout)
                    fflush(stdout)
                }
            }
        } catch {}
    }
}

if #available(macOS 13.0, *) {
    let args = CommandLine.arguments
    guard args.count >= 2 else {
        print("Usage: record_sysaudio <output_wav_path> [duration_seconds]")
        exit(1)
    }

    let outPath = args[1]
    let duration = args.count >= 3 ? (Double(args[2]) ?? 5.0) : 5.0

    let recorder = SystemAudioRecorder(outputPath: outPath)

    Task {
        do {
            try await recorder.start()
            try await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
            await recorder.stop()
            fputs("DONE\n", stdout)
            exit(0)
        } catch {
            fputs("Error: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }

    RunLoop.main.run()
} else {
    fputs("Error: macOS 13.0+ required for ScreenCaptureKit\n", stderr)
    exit(1)
}
