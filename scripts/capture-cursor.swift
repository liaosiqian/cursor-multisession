import Foundation
import AppKit
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics

_ = NSApplication.shared

func printUsage() {
    fputs("""
    Usage: capture-cursor <output.png> [options]
    Options:
      --app <name>     Target application (default: Cursor). Use "any" to pick largest visible window.
      --screen         Capture entire main screen instead of a window.
      --list           List visible application windows and exit.
    
    """, stderr)
}

guard CommandLine.arguments.count > 1 else {
    printUsage()
    exit(1)
}

let outputPath = CommandLine.arguments[1]
var targetApp = "Cursor"
var captureScreen = false
var listMode = false

var i = 2
while i < CommandLine.arguments.count {
    switch CommandLine.arguments[i] {
    case "--app":
        i += 1
        if i < CommandLine.arguments.count {
            targetApp = CommandLine.arguments[i]
        }
    case "--screen":
        captureScreen = true
    case "--list":
        listMode = true
    default:
        break
    }
    i += 1
}

let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

        if listMode {
            var seen = Set<String>()
            for w in content.windows {
                guard let app = w.owningApplication, w.frame.width > 100, w.frame.height > 100 else { continue }
                let name = app.applicationName
                if seen.insert(name).inserted {
                    print("\(name) (\(Int(w.frame.width))x\(Int(w.frame.height)))")
                }
            }
            semaphore.signal()
            return
        }

        if captureScreen {
            guard let display = content.displays.first else {
                fputs("No display found\n", stderr)
                exitCode = 1
                semaphore.signal()
                return
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.width = Int(display.width) * 2
            config.height = Int(display.height) * 2
            config.showsCursor = false
            config.captureResolution = .best

            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            try writeImage(image, to: outputPath)
            print("screen \(image.width)x\(image.height)")
            semaphore.signal()
            return
        }

        let matchedWindows: [SCWindow]
        if targetApp.lowercased() == "any" {
            matchedWindows = content.windows.filter { w in
                guard w.owningApplication != nil else { return false }
                return w.frame.width > 200 && w.frame.height > 200
            }.sorted { ($0.frame.width * $0.frame.height) > ($1.frame.width * $1.frame.height) }
        } else {
            matchedWindows = content.windows.filter { w in
                guard let app = w.owningApplication else { return false }
                return app.applicationName.localizedCaseInsensitiveContains(targetApp)
                    && w.frame.width > 200 && w.frame.height > 200
            }.sorted { $0.windowID < $1.windowID }
        }

        guard let targetWindow = matchedWindows.first else {
            fputs("No window found for '\(targetApp)'\n", stderr)
            let available = Set(content.windows.compactMap { $0.owningApplication?.applicationName })
                .sorted().prefix(20).joined(separator: ", ")
            fputs("Available: \(available)\n", stderr)
            exitCode = 1
            semaphore.signal()
            return
        }

        let appName = targetWindow.owningApplication?.applicationName ?? "unknown"
        let filter = SCContentFilter(desktopIndependentWindow: targetWindow)
        let config = SCStreamConfiguration()
        config.width = Int(targetWindow.frame.width) * 2
        config.height = Int(targetWindow.frame.height) * 2
        config.showsCursor = false
        config.captureResolution = .best

        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        try writeImage(image, to: outputPath)
        print("\(appName) \(targetWindow.windowID) \(image.width)x\(image.height)")
    } catch {
        fputs("Error: \(error.localizedDescription)\n", stderr)
        exitCode = 1
    }
    semaphore.signal()
}

func writeImage(_ image: CGImage, to outputPath: String) throws {
    let url = URL(fileURLWithPath: outputPath) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else {
        throw NSError(domain: "capture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to create image destination"])
    }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else {
        throw NSError(domain: "capture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to write image"])
    }
}

semaphore.wait()
exit(exitCode)
