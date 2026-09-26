// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RTCExpress",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "RTCExpress", targets: ["RTCExpress"])
    ],
    dependencies: [
        .package(url: "https://github.com/VLprojects/mediasoup-client-swift.git", exact: "0.13.2")
    ],
    targets: [
        .target(
            name: "RTCExpress",
            dependencies: [
                .product(name: "Mediasoup", package: "Mediasoup-Client-Swift")
            ]
        )
    ]
)
