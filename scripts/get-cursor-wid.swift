import CoreGraphics
import Foundation

let args = CommandLine.arguments
let listAll = args.count > 1 && args[1] == "--list"

let options: CGWindowListOption = [.optionAll]
guard let windowList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    exit(1)
}

if listAll {
    for w in windowList {
        let owner = w["kCGWindowOwnerName"] as? String ?? "?"
        let wid = w["kCGWindowNumber"] as? Int ?? 0
        let name = w["kCGWindowName"] as? String ?? ""
        let bounds = w["kCGWindowBounds"] as? [String: Any] ?? [:]
        let x = bounds["X"] as? Int ?? 0
        let y = bounds["Y"] as? Int ?? 0
        let width = bounds["Width"] as? Int ?? 0
        let height = bounds["Height"] as? Int ?? 0
        let layer = w["kCGWindowLayer"] as? Int ?? -1
        let alpha = w["kCGWindowAlpha"] as? Double ?? 0
        let onScreen = w["kCGWindowIsOnscreen"] as? Bool ?? false
        print("\(wid)\t\(x),\(y)\t\(width)x\(height)\tL\(layer)\ta\(String(format:"%.1f", alpha))\t\(onScreen ? "ON" : "off")\t\(owner)\t\(name)")
    }
    exit(0)
}

struct CursorWin {
    let wid: Int
    let x: Int
    let y: Int
    let w: Int
    let h: Int
}

var candidates: [CursorWin] = []

for w in windowList {
    guard let owner = w["kCGWindowOwnerName"] as? String,
          owner == "Cursor",
          let wid = w["kCGWindowNumber"] as? Int,
          let layer = w["kCGWindowLayer"] as? Int,
          layer == 0,
          let onScreen = w["kCGWindowIsOnscreen"] as? Bool,
          onScreen,
          let bounds = w["kCGWindowBounds"] as? [String: Any],
          let x = bounds["X"] as? Int,
          let y = bounds["Y"] as? Int,
          let width = bounds["Width"] as? Int,
          let height = bounds["Height"] as? Int,
          width > 200 && height > 200 else { continue }

    candidates.append(CursorWin(wid: wid, x: x, y: y, w: width, h: height))
}

candidates.sort { $0.wid < $1.wid }

if let best = candidates.first {
    print("\(best.wid) \(best.x) \(best.y) \(best.w) \(best.h)")
} else {
    exit(1)
}
