import Foundation
import ImageIO
import PDFKit
import UniformTypeIdentifiers

struct PreparedFile: Sendable {
    let kind: String
    let filename: String
    let dataBase64: String
    let size: Int
    let mimeType: String?
    let width: Int?
    let height: Int?

    var dictionary: [String: Any] {
        var value: [String: Any] = [
            "kind": kind,
            "filename": filename,
            "dataBase64": dataBase64,
            "size": size,
        ]
        if let mimeType { value["mimeType"] = mimeType }
        if let width { value["width"] = width }
        if let height { value["height"] = height }
        return value
    }
}

enum AttachmentPreparer {
    static let maximumCount = 10
    static let maximumFileBytes = 5 * 1024 * 1024
    static let maximumTotalBytes = 15 * 1024 * 1024
    private static let maximumSourceBytes = 25 * 1024 * 1024

    static func prepare(_ urls: [URL]) async throws -> [PreparedFile] {
        guard !urls.isEmpty, urls.count <= maximumCount else { throw AttachmentError.limit }
        return try await Task.detached(priority: .userInitiated) {
            var result: [PreparedFile] = []
            var total = 0
            for url in urls {
                let accessed = url.startAccessingSecurityScopedResource()
                defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                let item = try prepareOne(url)
                total += item.size
                guard total <= maximumTotalBytes else { throw AttachmentError.limit }
                result.append(item)
            }
            return result
        }.value
    }

    private static func prepareOne(_ url: URL) throws -> PreparedFile {
        let name = try safeFilename(url.lastPathComponent)
        let type = (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType)
            ?? UTType(filenameExtension: url.pathExtension)
        let maximum = type?.conforms(to: .pdf) == true || type?.conforms(to: .image) == true
            ? maximumSourceBytes : maximumFileBytes
        return try prepareData(readBoundedFile(url, maximum: maximum), name: name, type: type)
    }

    // NSItemProvider's temporary URL is valid only inside its callback.
    // Read and prepare it before returning; never retain a provider URL.
    static func prepareDroppedFile(_ url: URL, filename: String?, type: UTType) throws -> PreparedFile {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let name = try safeFilename(filename ?? url.lastPathComponent)
        let maximum = type.conforms(to: .pdf) || type.conforms(to: .image) ? maximumSourceBytes : maximumFileBytes
        return try prepareData(readBoundedFile(url, maximum: maximum), name: name, type: type)
    }

    private static func prepareData(_ data: Data, name: String, type: UTType?) throws -> PreparedFile {
        if type?.conforms(to: .pdf) == true { return try preparePDF(data, name: name) }
        if type?.conforms(to: .image) == true { return try prepareImage(data, name: name) }
        guard data.count <= maximumFileBytes else { throw AttachmentError.limit }
        return try prepareText(data, name: name, mimeType: type?.preferredMIMEType)
    }

    private static func preparePDF(_ sourceData: Data, name: String) throws -> PreparedFile {
        guard let document = PDFDocument(data: sourceData),
              !document.isEncrypted, !document.isLocked,
              let text = document.string,
              let data = text.data(using: .utf8),
              !data.isEmpty,
              !data.prefix(8192).contains(0),
              data.count <= maximumFileBytes else { throw AttachmentError.unsupported }
        return PreparedFile(kind: "pdf_text", filename: name, dataBase64: data.base64EncodedString(),
                            size: data.count, mimeType: "text/plain", width: nil, height: nil)
    }

    private static func prepareImage(_ sourceData: Data, name: String) throws -> PreparedFile {
        guard let source = CGImageSourceCreateWithData(sourceData as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 2048,
              ] as CFDictionary) else { throw AttachmentError.unsupported }

        var jpeg: Data?
        for quality in [0.85, 0.72, 0.58, 0.44] {
            let buffer = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(buffer, UTType.jpeg.identifier as CFString, 1, nil) else {
                throw AttachmentError.unsupported
            }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { throw AttachmentError.unsupported }
            let candidate = buffer as Data
            if candidate.count <= maximumFileBytes { jpeg = candidate; break }
        }
        guard let jpeg, !jpeg.isEmpty else { throw AttachmentError.limit }
        let outputName = (name as NSString).deletingPathExtension + ".jpg"
        return PreparedFile(kind: "image", filename: try safeFilename(outputName), dataBase64: jpeg.base64EncodedString(),
                            size: jpeg.count, mimeType: "image/jpeg", width: image.width, height: image.height)
    }

    private static func prepareText(_ data: Data, name: String, mimeType: String?) throws -> PreparedFile {
        guard !data.isEmpty, data.count <= maximumFileBytes,
              !data.prefix(8192).contains(0),
              String(data: data, encoding: .utf8) != nil else { throw AttachmentError.unsupported }
        return PreparedFile(kind: "file", filename: name, dataBase64: data.base64EncodedString(), size: data.count,
                            mimeType: mimeType ?? "text/plain", width: nil, height: nil)
    }

    private static func safeFilename(_ value: String) throws -> String {
        let name = value.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 255, name != ".", name != "..",
              !name.contains("/"), !name.contains("\\"),
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw AttachmentError.unsupported
        }
        return name
    }

    private static func readBoundedFile(_ url: URL, maximum: Int) throws -> Data {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let bytes = attributes[.size] as? NSNumber,
              bytes.intValue > 0, bytes.intValue <= maximum else {
            throw AttachmentError.limit
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var data = Data()
        while data.count <= maximum {
            let remaining = maximum + 1 - data.count
            let chunk = try handle.read(upToCount: min(64 * 1024, remaining)) ?? Data()
            if chunk.isEmpty {
                guard !data.isEmpty else { throw AttachmentError.unsupported }
                return data
            }
            data.append(chunk)
        }
        throw AttachmentError.limit
    }
}

enum AttachmentError: Error {
    case limit
    case unsupported
}
