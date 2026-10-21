import Foundation
import UniformTypeIdentifiers

// Start provider requests synchronously in performDrop, as UIKit requires.
// The serial callback queue bounds decoding memory and keeps provider URLs alive
// until preparation finishes. Only prepared bytes are buffered; no copied files.
final class DroppedFileBatch: @unchecked Sendable {
    private let queue = DispatchQueue(label: "wisp.remote.file-drop", qos: .userInitiated)
    private let stream: AsyncThrowingStream<(Int, PreparedFile), Error>
    private let continuation: AsyncThrowingStream<(Int, PreparedFile), Error>.Continuation
    private var finished = false
    private var remaining: Int
    private var total = 0
    private var progress: [Progress] = []

    static func contentType(for provider: NSItemProvider) -> UTType? {
        let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
        return types.first { $0.conforms(to: .pdf) }
            ?? types.first { $0.conforms(to: .image) }
            ?? types.first { $0.conforms(to: .data) && !$0.conforms(to: .url) }
    }

    init(providers: [NSItemProvider]) {
        let pair = AsyncThrowingStream<(Int, PreparedFile), Error>.makeStream()
        stream = pair.stream
        continuation = pair.continuation
        remaining = providers.count
        guard !providers.isEmpty, providers.count <= AttachmentPreparer.maximumCount,
              providers.allSatisfy({ Self.contentType(for: $0) != nil }) else {
            finished = true
            continuation.finish(throwing: providers.count > AttachmentPreparer.maximumCount ? AttachmentError.limit : AttachmentError.unsupported)
            return
        }
        for (index, provider) in providers.enumerated() {
            let type = Self.contentType(for: provider)!
            let name = provider.suggestedName
            let operation = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { [weak self] url, error in
                guard let self else { return }
                // The URL must be consumed before this callback returns.
                self.queue.sync {
                    guard !self.finished else { return }
                    do {
                        guard error == nil, let url else { throw AttachmentError.unsupported }
                        let file = try AttachmentPreparer.prepareDroppedFile(url, filename: name, type: type)
                        self.total += file.size
                        guard self.total <= AttachmentPreparer.maximumTotalBytes else { throw AttachmentError.limit }
                        self.continuation.yield((index, file))
                        self.remaining -= 1
                        if self.remaining == 0 {
                            self.finished = true
                            self.continuation.finish()
                        }
                    } catch {
                        self.finished = true
                        self.continuation.finish(throwing: error)
                    }
                }
            }
            progress.append(operation)
        }
    }

    func files() async throws -> [PreparedFile] {
        var result: [(Int, PreparedFile)] = []
        for try await item in stream {
            try Task.checkCancellation()
            result.append(item)
        }
        return result.sorted { $0.0 < $1.0 }.map(\.1)
    }

    func cancel() {
        queue.async { [self] in
            finished = true
            continuation.finish(throwing: CancellationError())
        }
        for operation in progress { operation.cancel() }
    }
}
