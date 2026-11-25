// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TriboonCore",
    platforms: [
        .iOS(.v17),
        .tvOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "TriboonCore",
            targets: ["TriboonCore"]
        ),
    ],
    targets: [
        .target(
            name: "TriboonCore",
            path: "Sources/TriboonCore"
        ),
        .testTarget(
            name: "TriboonCoreTests",
            dependencies: ["TriboonCore"],
            path: "Tests/TriboonCoreTests"
        ),
    ]
)
