import Foundation
import AppKit
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics

_ = NSApplication.shared

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: capture-cursor <output.png>\n", stderr)
    exit(1)
}

let outputPath = CommandLine.arguments[1]
let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        let cursorWindows = content.windows.filter { w in
            guard let app = w.owningApplication else { return false }
            return app.applicationName == "Cursor" && w.frame.width > 200 && w.frame.height > 200
        }.sorted { $0.windowID < $1.windowID }

        guard let targetWindow = cursorWindows.first else {
            fputs("No Cursor window found\n", stderr)
            exitCode = 1
            semaphore.signal()
            return
        }

        let filter = SCContentFilter(desktopIndependentWindow: targetWindow)
        let config = SCStreamConfiguration()
        config.width = Int(targetWindow.frame.width) * 2
        config.height = Int(targetWindow.frame.height) * 2
        config.showsCursor = false
        config.captureResolution = .best

        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)

        let url = URL(fileURLWithPath: outputPath) as CFURL
        guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else {
            fputs("Failed to create image destination\n", stderr)
            exitCode = 1
            semaphore.signal()
            return
        }

        CGImageDestinationAddImage(dest, image, nil)

        if CGImageDestinationFinalize(dest) {
            print("\(targetWindow.windowID) \(image.width)x\(image.height)")
        } else {
            fputs("Failed to write image\n", stderr)
            exitCode = 1
        }
    } catch {
        fputs("Error: \(error.localizedDescription)\n", stderr)
        exitCode = 1
    }
    semaphore.signal()
}

semaphore.wait()
exit(exitCode)
