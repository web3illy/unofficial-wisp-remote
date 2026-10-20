import AppKit

let args = CommandLine.arguments
guard args.count == 3 else { fatalError("Expected asset and resource directories") }
let source = URL(fileURLWithPath: args[1]), destination = URL(fileURLWithPath: args[2])
func render(_ name: String, width: Int, height: Int, to path: URL) throws {
    guard let image = NSImage(contentsOf: source.appendingPathComponent(name + ".svg")),
          let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { throw NSError(domain: "IconRenderer", code: 1) }
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    image.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { throw NSError(domain: "IconRenderer", code: 2) }
    try png.write(to: path)
}
for theme in ["dark", "light"] {
    for state in ["offline", "closed", "connecting", "online"] {
        let name = "menu-\(theme)-\(state)"
        // A 2x bitmap for a 22x22 logical menu-bar image.
        try render(name, width: 44, height: 44, to: destination.appendingPathComponent(name + ".png"))
    }
}
for state in ["offline", "closed", "connecting", "online"] {
    try render("remote-app-\(state)", width: 512, height: 512, to: destination.appendingPathComponent("app-\(state).png"))
}
let iconset = destination.appendingPathComponent("Remote.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        try render("remote-app", width: size * scale, height: size * scale, to: iconset.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
