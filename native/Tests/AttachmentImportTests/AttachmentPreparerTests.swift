import CoreGraphics
import CoreText
import Foundation
import ImageIO
import PDFKit
import UniformTypeIdentifiers
import XCTest
@testable import AttachmentImport

final class AttachmentPreparerTests: XCTestCase {
    private func pdf(text: String? = "Synthetic contract: approval is still required.") -> Data {
        let data = NSMutableData()
        var rect = CGRect(x: 0, y: 0, width: 612, height: 792)
        let context = CGContext(consumer: CGDataConsumer(data: data)!, mediaBox: &rect, nil)!
        context.beginPDFPage(nil)
        if let text {
            let attributes = [kCTFontAttributeName as NSAttributedString.Key: CTFontCreateWithName("Helvetica" as CFString, 16, nil)]
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
            context.textPosition = CGPoint(x: 40, y: 700)
            CTLineDraw(line, context)
        }
        context.endPDFPage()
        context.closePDF()
        return data as Data
    }

    private func prepare(_ data: Data, name: String = "contract.pdf", mime: String = "application/pdf") async throws -> PreparedFile {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("fixture")
        try data.write(to: url)
        let provider = NSItemProvider()
        provider.suggestedName = name
        provider.registerFileRepresentation(forTypeIdentifier: UTType(mimeType: mime)!.identifier, fileOptions: [], visibility: .all) { complete in
            complete(url, false, nil)
            return nil
        }
        let batch = DroppedFileBatch(providers: [provider])
        defer { batch.cancel() }
        return try await batch.files()[0]
    }

    private func rejects(_ action: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await action(); XCTFail("Expected rejection", file: file, line: line) }
        catch is AttachmentError { }
        catch { XCTFail("Unexpected error: \(type(of: error))", file: file, line: line) }
    }

    func testDroppedPDFMatchesPickerExtraction() async throws {
        let data = pdf()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("contract.pdf")
        try data.write(to: url)
        let picked = try await AttachmentPreparer.prepare([url])[0]
        let dropped = try await prepare(data)
        XCTAssertEqual(dropped.kind, "pdf_text")
        XCTAssertEqual(dropped.filename, picked.filename)
        XCTAssertEqual(dropped.dataBase64, picked.dataBase64)
        XCTAssertEqual(dropped.size, picked.size)
        let text = String(data: Data(base64Encoded: dropped.dataBase64)!, encoding: .utf8)!
        XCTAssertTrue(text.contains("approval is still required"))
        XCTAssertFalse(text.contains("%PDF"), "Only extracted text enters the upload path")
        let noExtension = try await prepare(data, name: "contract")
        XCTAssertEqual(noExtension.dataBase64, dropped.dataBase64)
    }

    func testMalformedScannedAndEncryptedPDFsAreRejected() async throws {
        await rejects { _ = try await self.prepare(Data("not a PDF".utf8)) }
        await rejects { _ = try await self.prepare(self.pdf(text: nil)) }
        let document = PDFDocument(data: pdf())!
        let encrypted = document.dataRepresentation(options: [PDFDocumentWriteOption.ownerPasswordOption:"owner-test", PDFDocumentWriteOption.userPasswordOption:"reader-test"])!
        await rejects { _ = try await self.prepare(encrypted) }
    }

    func testTextAndUnsafeNames() async throws {
        let data = Data("Synthetic plain text".utf8)
        let prepared = try await prepare(data, name: "note.txt", mime: "text/plain")
        XCTAssertEqual(prepared.kind, "file")
        XCTAssertEqual(Data(base64Encoded: prepared.dataBase64), data)
        for name in ["../note.txt", "a/b.txt", "a\\b.txt", ".", "..", "", "a\u{0000}.txt", String(repeating: "a", count: 256)] {
            await rejects { _ = try await self.prepare(data, name: name, mime: "text/plain") }
        }
        await rejects { _ = try await self.prepare(Data([0,1,2]), name: "binary.txt", mime: "text/plain") }
        await rejects { _ = try await self.prepare(Data([0xFF]), name: "bad.txt", mime: "text/plain") }
    }

    func testSourceAndPreparedSizeLimits() async throws {
        await rejects { _ = try await self.prepare(Data()) }
        await rejects { _ = try await self.prepare(Data(repeating: 65, count: 5 * 1024 * 1024 + 1), name: "large.txt", mime: "text/plain") }
        await rejects { _ = try await self.prepare(Data(repeating: 65, count: 25 * 1024 * 1024 + 1)) }
    }

    func testImageIsResizedAndEncodedAsJPEG() async throws {
        let context = CGContext(data: nil, width: 4096, height: 16, bitsPerComponent: 8, bytesPerRow: 4096*4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(gray: 0.5, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 4096, height: 16))
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let result = try await prepare(data as Data, name: "image.png", mime: "image/png")
        XCTAssertEqual(result.kind, "image")
        XCTAssertEqual(result.filename, "image.jpg")
        XCTAssertEqual(result.width, 2048)
        XCTAssertLessThanOrEqual(result.size, AttachmentPreparer.maximumFileBytes)
        let decoded = CGImageSourceCreateWithData(Data(base64Encoded: result.dataBase64)! as CFData, nil)!
        XCTAssertEqual(CGImageSourceGetType(decoded) as String?, UTType.jpeg.identifier)
    }
    func testBatchRejectsTooManyFilesURLsAndProviderFailure() async {
        let provider = NSItemProvider()
        provider.registerFileRepresentation(forTypeIdentifier: UTType.pdf.identifier, fileOptions: [], visibility: .all) { complete in
            complete(nil, false, NSError(domain: "SyntheticProvider", code: 1))
            return nil
        }
        for providers in [Array(repeating: provider, count: 11), [provider], [NSItemProvider(object: URL(string: "https://example.com/file.pdf")! as NSURL)]] {
            let batch = DroppedFileBatch(providers: providers)
            defer { batch.cancel() }
            await rejects { _ = try await batch.files() }
        }
    }

    func testBatchPreservesFileOrderAndRejectsTotalSize() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var providers: [NSItemProvider] = []
        for index in 0..<4 {
            let url = directory.appendingPathComponent("note-\(index).txt")
            try Data(repeating: UInt8(65 + index), count: 4 * 1024 * 1024).write(to: url)
            let provider = NSItemProvider()
            provider.suggestedName = url.lastPathComponent
            provider.registerFileRepresentation(forTypeIdentifier: UTType.plainText.identifier, fileOptions: [], visibility: .all) { complete in
                DispatchQueue.global().asyncAfter(deadline: .now() + Double(4-index) * 0.01) { complete(url, false, nil) }
                return nil
            }
            providers.append(provider)
        }
        let valid = DroppedFileBatch(providers: Array(providers.prefix(3)))
        defer { valid.cancel() }
        let files = try await valid.files()
        XCTAssertEqual(files.map(\.filename), ["note-0.txt", "note-1.txt", "note-2.txt"])
        let excessive = DroppedFileBatch(providers: providers)
        defer { excessive.cancel() }
        await rejects { _ = try await excessive.files() }
    }

    func testCancellationReleasesWaitingConsumer() async {
        let provider = NSItemProvider()
        provider.registerFileRepresentation(forTypeIdentifier: UTType.pdf.identifier, fileOptions: [], visibility: .all) { _ in Progress(totalUnitCount: 1) }
        let batch = DroppedFileBatch(providers: [provider])
        batch.cancel()
        do { _ = try await batch.files(); XCTFail("Cancelled batch must not succeed") }
        catch is CancellationError { }
        catch { XCTFail("Unexpected error: \(type(of: error))") }
    }

}
