// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WispRemoteNative",
    platforms: [
        .iOS("17.5"),
        .macOS("14.5"),
    ],
    products: [
        .library(name: "RemoteCore", targets: ["RemoteCore"]),
        .executable(name: "RemoteProbe", targets: ["RemoteProbe"]),
    ],
    dependencies: [
        .package(url: "https://github.com/n0-computer/iroh-ffi", exact: "1.1.0"),
    ],
    targets: [
        .target(
            name: "RemoteCore",
            dependencies: [.product(name: "IrohLib", package: "iroh-ffi")],
            linkerSettings: [.linkedFramework("Security")]
        ),
        .executableTarget(
            name: "RemoteProbe",
            dependencies: ["RemoteCore"],
            path: "Sources/RemoteProbe"
        ),
        .testTarget(name: "RemoteCoreTests", dependencies: ["RemoteCore"]),
        .target(
            name: "AttachmentImport",
            path: "App",
            exclude: ["Info.plist", "QRScannerView.swift", "RemoteWebView.swift", "RootView.swift", "WispRemoteApp.swift"],
            sources: ["AttachmentPreparer.swift", "DroppedFileBatch.swift"]
        ),
        .testTarget(name: "AttachmentImportTests", dependencies: ["AttachmentImport"]),
    ]
)
