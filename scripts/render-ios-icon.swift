import AppKit
import ImageIO

// Local build asset from the shared Remote portrait master.
guard CommandLine.arguments.count == 3,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
                                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                    isPlanar: false, colorSpaceName: .deviceRGB,
                                    bytesPerRow: 0, bitsPerPixel: 0),
      let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Could not prepare the local iPhone app icon.")
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphics
image.draw(in: NSRect(x: 0, y: 0, width: 1024, height: 1024))
NSGraphicsContext.restoreGraphicsState()
// AppKit renders SVG into RGBA. Flatten into an opaque RGB context for iOS icons.
guard let rendered = bitmap.cgImage,
      let opaque = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8,
                             bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
    fatalError("Could not flatten the iPhone app icon.")
}
opaque.draw(rendered, in: CGRect(x: 0, y: 0, width: 1024, height: 1024))
guard let finalImage = opaque.makeImage(),
      let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL,
                                                        "public.png" as CFString, 1, nil) else {
    fatalError("Could not encode the iPhone app icon.")
}
CGImageDestinationAddImage(destination, finalImage, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Could not save the iPhone app icon.") }
