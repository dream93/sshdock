// swift-tools-version: 6.0
import PackageDescription
import Foundation

let packageDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let coreLibrary = packageDirectory.appendingPathComponent("../core/target/release/libsshdock_core.a").standardized.path

let package = Package(
    name: "SSHDockMacOS",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "SSHDockNative", targets: ["SSHDockMacOS"])],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.20.0")
    ],
    targets: [
        .target(name: "CSshDockCore", path: "Sources/CSshDockCore", publicHeadersPath: "include"),
        .executableTarget(
            name: "SSHDockMacOS",
            dependencies: ["CSshDockCore", .product(name: "SwiftTerm", package: "SwiftTerm")],
            linkerSettings: [.unsafeFlags([coreLibrary]), .linkedFramework("Security")]
        ),
        .testTarget(name: "SSHDockMacOSTests", dependencies: ["SSHDockMacOS"])
    ],
    swiftLanguageModes: [.v5]
)
