import Foundation
import AVFoundation
import Mediasoup
import WebRTC

struct SfuJoinOptions {
    var audio = true
    var video = false
    var announceToRoom = false
    var targetUserId: String?
    var callId: String?
}

/// SFU group voice/video and 1:1 SFU calls via mediasoup-client-swift.
final class SfuMediaEngine: NSObject {
    private let sfuUrl: String
    private let userId: String
    private let authToken: String
    private let sendSignaling: (String, [String: Any]) throws -> Void
    private let onRemoteVideo: (RTCVideoTrack) -> Void

    private let pcFactory: RTCPeerConnectionFactory
    private var device: Device?
    private var sendTransport: SendTransport?
    private var recvTransport: ReceiveTransport?
    private var roomId: String?
    private var audioTrack: RTCAudioTrack?
    private var videoTrack: RTCVideoTrack?
    private var capturer: RTCCameraVideoCapturer?
    private var micProducer: Producer?
    private var camProducer: Producer?
    private var consumers: [String: Consumer] = [:]
    private var usingFrontCamera = true
    private var joinOptions = SfuJoinOptions()

    private var sendDelegate: SendHandler?
    private var recvDelegate: RecvHandler?
    private let producerDelegate = ProducerHandler()
    private let consumerDelegate = ConsumerHandler()

    init(
        sfuUrl: String,
        userId: String,
        authToken: String,
        sendSignaling: @escaping (String, [String: Any]) throws -> Void,
        onRemoteVideo: @escaping (RTCVideoTrack) -> Void
    ) {
        self.sfuUrl = sfuUrl
        self.userId = userId
        self.authToken = authToken
        self.sendSignaling = sendSignaling
        self.onRemoteVideo = onRemoteVideo
        let encoder = RTCDefaultVideoEncoderFactory()
        let decoder = RTCDefaultVideoDecoderFactory()
        self.pcFactory = RTCPeerConnectionFactory(encoderFactory: encoder, decoderFactory: decoder)
        super.init()
    }

    func joinRoom(roomId: String, options: SfuJoinOptions) async throws {
        self.roomId = roomId
        self.joinOptions = options
        let base = sfuUrl.trimmingCharacters(in: .init(charactersIn: "/"))
        let encodedRoom = roomId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? roomId

        let join = try await postJSON("\(base)/v1/rooms/\(encodedRoom)/join", body: ["peerId": userId])
        guard let rtpCapabilities = join["rtpCapabilities"] else {
            throw sfuError("Missing rtpCapabilities from SFU join")
        }

        let mediasoupDevice = Device()
        try mediasoupDevice.load(with: try jsonString(rtpCapabilities))
        device = mediasoupDevice

        try createSendTransport(base: base, roomId: roomId, options: options)
        try createRecvTransport(base: base, roomId: roomId)
        if options.audio || options.video {
            try publishCameraMic(options: options)
        }
        try await consumeExisting(base: base, roomId: roomId)
    }

    func handleRemoteProducer(_ payload: [String: Any]) {
        guard let currentRoom = roomId else { return }
        guard let payloadRoom = payload["roomId"] as? String, payloadRoom == currentRoom else { return }
        guard let fromUserId = payload["fromUserId"] as? String, fromUserId != userId else { return }
        guard let producerId = payload["producerId"] as? String else { return }
        if consumers[producerId] != nil { return }
        let base = sfuUrl.trimmingCharacters(in: .init(charactersIn: "/"))
        Task {
            try? await consumeProducer(base: base, roomId: currentRoom, producerId: producerId)
        }
    }

    func muteMicrophone(_ muted: Bool) {
        if muted { micProducer?.pause() } else { micProducer?.resume() }
        audioTrack?.isEnabled = !muted
    }

    func muteCamera(_ muted: Bool) {
        if muted { camProducer?.pause() } else { camProducer?.resume() }
        videoTrack?.isEnabled = !muted
    }

    func switchCamera() {
        guard let capturer else { return }
        usingFrontCamera.toggle()
        let position: AVCaptureDevice.Position = usingFrontCamera ? .front : .back
        if let device = RTCCameraVideoCapturer.captureDevices().first(where: { $0.position == position }),
           let format = RTCCameraVideoCapturer.supportedFormats(for: device).last {
            capturer.startCapture(with: device, format: format, fps: 24)
        }
    }

    func getLocalVideoTrack() -> RTCVideoTrack? { videoTrack }

    func destroy() {
        micProducer?.close()
        camProducer?.close()
        consumers.values.forEach { $0.close() }
        consumers.removeAll()
        sendTransport?.close()
        recvTransport?.close()
        sendTransport = nil
        recvTransport = nil
        device = nil
        capturer?.stopCapture()
        capturer = nil
        videoTrack = nil
        audioTrack = nil
        roomId = nil
        sendDelegate = nil
        recvDelegate = nil
    }

    // MARK: - Transport setup

    private func createSendTransport(base: String, roomId: String, options: SfuJoinOptions) throws {
        let info = try postJSONSync("\(base)/v1/rooms/\(encode(roomId))/transports", body: ["peerId": userId])
        let mediasoupDevice = device ?? { throw sfuError("Device not loaded") }()

        let handler = SendHandler(engine: self, base: base, roomId: roomId, options: options)
        sendDelegate = handler

        let transport = try mediasoupDevice.createSendTransport(
            id: info["id"] as? String ?? "",
            iceParameters: try jsonString(info["iceParameters"] ?? [:]),
            iceCandidates: try jsonString(info["iceCandidates"] ?? []),
            dtlsParameters: try jsonString(info["dtlsParameters"] ?? [:]),
            sctpParameters: nil,
            iceServers: "[]",
            iceTransportPolicy: .all,
            appData: nil
        )
        transport.delegate = handler
        sendTransport = transport
    }

    private func createRecvTransport(base: String, roomId: String) throws {
        let info = try postJSONSync("\(base)/v1/rooms/\(encode(roomId))/transports", body: ["peerId": userId])
        let mediasoupDevice = device ?? { throw sfuError("Device not loaded") }()

        let handler = RecvHandler(engine: self, base: base, roomId: roomId)
        recvDelegate = handler

        let transport = try mediasoupDevice.createReceiveTransport(
            id: info["id"] as? String ?? "",
            iceParameters: try jsonString(info["iceParameters"] ?? [:]),
            iceCandidates: try jsonString(info["iceCandidates"] ?? []),
            dtlsParameters: try jsonString(info["dtlsParameters"] ?? [:]),
            sctpParameters: nil,
            iceServers: "[]",
            iceTransportPolicy: .all,
            appData: nil
        )
        transport.delegate = handler
        recvTransport = transport
    }

    fileprivate func connectTransport(base: String, roomId: String, transportId: String, dtlsParameters: String) throws {
        let dtlsObject = try parseJSONObject(dtlsParameters)
        _ = try postJSONSync(
            "\(base)/v1/rooms/\(encode(roomId))/transports/\(transportId)/connect",
            body: ["peerId": userId, "dtlsParameters": dtlsObject]
        )
    }

    fileprivate func produceOnServer(
        base: String,
        roomId: String,
        transportId: String,
        kind: MediaKind,
        rtpParameters: String,
        options: SfuJoinOptions
    ) throws -> String {
        let kindString = kind == .audio ? "audio" : "video"
        let rtpObject = try parseJSONObject(rtpParameters)
        let res = try postJSONSync(
            "\(base)/v1/rooms/\(encode(roomId))/transports/\(transportId)/produce",
            body: ["peerId": userId, "kind": kindString, "rtpParameters": rtpObject]
        )
        let producerId = res["producerId"] as? String ?? ""
        if !producerId.isEmpty && (options.announceToRoom || options.targetUserId != nil) {
            var payload: [String: Any] = [
                "roomId": roomId,
                "producerId": producerId,
                "kind": kindString
            ]
            if let target = options.targetUserId { payload["toUserId"] = target }
            if let callId = options.callId { payload["callId"] = callId }
            try sendSignaling("sfu_producer", payload)
        }
        return producerId
    }

    private func publishCameraMic(options: SfuJoinOptions) throws {
        let send = sendTransport ?? { throw sfuError("Send transport missing") }()

        if options.audio {
            let audioSource = pcFactory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
            audioTrack = pcFactory.audioTrack(with: audioSource, trackId: "audio0")
            let producer = try send.createProducer(
                for: audioTrack!,
                encodings: nil,
                codecOptions: nil,
                appData: nil
            )
            producer.delegate = producerDelegate
            producer.resume()
            micProducer = producer
        }

        if options.video {
            startCamera()
            if let track = videoTrack {
                let producer = try send.createProducer(
                    for: track,
                    encodings: nil,
                    codecOptions: nil,
                    appData: nil
                )
                producer.delegate = producerDelegate
                producer.resume()
                camProducer = producer
            }
        }
    }

    private func consumeExisting(base: String, roomId: String) async throws {
        let encodedRoom = roomId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? roomId
        let encodedPeer = userId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? userId
        var request = URLRequest(url: URL(string: "\(base)/v1/rooms/\(encodedRoom)/producers?peerId=\(encodedPeer)")!)
        request.httpMethod = "GET"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode < 300 else { return }
        let json = (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        let producers = json["producers"] as? [[String: Any]] ?? []
        for item in producers {
            guard let producerId = item["producerId"] as? String else { continue }
            try await consumeProducer(base: base, roomId: roomId, producerId: producerId)
        }
    }

    fileprivate func consumeProducer(base: String, roomId: String, producerId: String) async throws {
        let recv = recvTransport ?? { throw sfuError("Recv transport missing") }()
        let mediasoupDevice = device ?? { throw sfuError("Device not loaded") }()
        if consumers[producerId] != nil { return }

        let res = try postJSONSync(
            "\(base)/v1/rooms/\(encode(roomId))/transports/\(recv.id)/consume",
            body: [
                "peerId": userId,
                "producerId": producerId,
                "rtpCapabilities": try parseJSONObject(mediasoupDevice.rtpCapabilities)
            ]
        )

        let kindString = (res["kind"] as? String) ?? "audio"
        let kind: MediaKind = kindString == "video" ? .video : .audio
        let consumer = try recv.consume(
            consumerDelegate,
            id: res["consumerId"] as? String ?? "",
            producerId: producerId,
            kind: kind,
            rtpParameters: try jsonString(res["rtpParameters"] ?? [:]),
            appData: nil
        )
        consumer.resume()
        consumers[producerId] = consumer

        if let track = consumer.track as? RTCVideoTrack {
            onRemoteVideo(track)
        }
    }

    private func startCamera() {
        let source = pcFactory.videoSource()
        capturer = RTCCameraVideoCapturer(delegate: source)
        videoTrack = pcFactory.videoTrack(with: source, trackId: "video0")
        if let device = RTCCameraVideoCapturer.captureDevices().first(where: { $0.position == .front }),
           let format = RTCCameraVideoCapturer.supportedFormats(for: device).last {
            capturer?.startCapture(with: device, format: format, fps: 24)
        }
    }

    // MARK: - HTTP helpers

    private func postJSON(_ urlString: String, body: [String: Any]) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: urlString)!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode < 300 else {
            throw sfuError("SFU request failed")
        }
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private func postJSONSync(_ urlString: String, body: [String: Any]) throws -> [String: Any] {
        var request = URLRequest(url: URL(string: urlString)!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let sem = DispatchSemaphore(value: 0)
        var result: [String: Any] = [:]
        var thrown: Error?
        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { sem.signal() }
            if let error { thrown = error; return }
            guard let data,
                  let http = response as? HTTPURLResponse,
                  http.statusCode < 300 else {
                thrown = sfuError("SFU request failed")
                return
            }
            result = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        }.resume()
        sem.wait()
        if let thrown { throw thrown }
        return result
    }

    private func jsonString(_ value: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value)
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    private func parseJSONObject(_ string: String) throws -> Any {
        let data = Data(string.utf8)
        return try JSONSerialization.jsonObject(with: data)
    }

    private func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private func sfuError(_ message: String) -> NSError {
        NSError(domain: "RTCExpress", code: 31, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

// MARK: - Mediasoup delegates

private final class SendHandler: NSObject, SendTransportDelegate {
    private weak var engine: SfuMediaEngine?
    private let base: String
    private let roomId: String
    private let options: SfuJoinOptions

    init(engine: SfuMediaEngine, base: String, roomId: String, options: SfuJoinOptions) {
        self.engine = engine
        self.base = base
        self.roomId = roomId
        self.options = options
    }

    func onConnect(transport: Transport, dtlsParameters: String) {
        try? engine?.connectTransport(base: base, roomId: roomId, transportId: transport.id, dtlsParameters: dtlsParameters)
    }

    func onConnectionStateChange(transport: Transport, connectionState: TransportConnectionState) {}

    func onProduce(
        transport: Transport,
        kind: MediaKind,
        rtpParameters: String,
        appData: String,
        callback: @escaping (String?) -> Void
    ) {
        let producerId = try? engine?.produceOnServer(
            base: base,
            roomId: roomId,
            transportId: transport.id,
            kind: kind,
            rtpParameters: rtpParameters,
            options: options
        )
        callback(producerId)
    }

    func onProduceData(
        transport: Transport,
        sctpParameters: String,
        label: String,
        protocol dataProtocol: String,
        appData: String,
        callback: @escaping (String?) -> Void
    ) {
        callback(nil)
    }
}

private final class RecvHandler: NSObject, ReceiveTransportDelegate {
    private weak var engine: SfuMediaEngine?
    private let base: String
    private let roomId: String

    init(engine: SfuMediaEngine, base: String, roomId: String) {
        self.engine = engine
        self.base = base
        self.roomId = roomId
    }

    func onConnect(transport: Transport, dtlsParameters: String) {
        try? engine?.connectTransport(base: base, roomId: roomId, transportId: transport.id, dtlsParameters: dtlsParameters)
    }

    func onConnectionStateChange(transport: Transport, connectionState: TransportConnectionState) {}
}

private final class ProducerHandler: NSObject, ProducerDelegate {
    func onTransportClose(in producer: Producer) {}
}

private final class ConsumerHandler: NSObject, ConsumerDelegate {
    func onTransportClose(in consumer: Consumer) {}
}
