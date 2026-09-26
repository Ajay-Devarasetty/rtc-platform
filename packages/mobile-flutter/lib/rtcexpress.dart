import 'dart:async';
export 'video_view.dart';

import 'package:flutter/services.dart';

typedef RTCEventHandler = void Function(Map<String, dynamic> payload);

class RTCInitOptions {
  final String serverUrl;
  final String appId;
  final String userId;
  final String token;
  final String mediaMode;

  const RTCInitOptions({
    required this.serverUrl,
    required this.appId,
    required this.userId,
    required this.token,
    this.mediaMode = 'auto',
  });

  Map<String, dynamic> toMap() => {
        'serverUrl': serverUrl,
        'appId': appId,
        'userId': userId,
        'token': token,
        'mediaMode': mediaMode,
      };
}

class TokenRequest {
  final String appId;
  final String appSecret;
  final String userId;
  final String? roomId;

  const TokenRequest({
    required this.appId,
    required this.appSecret,
    required this.userId,
    this.roomId,
  });

  Map<String, dynamic> toMap() => {
        'appId': appId,
        'appSecret': appSecret,
        'userId': userId,
        if (roomId != null) 'roomId': roomId,
      };
}

class RTCExpress {
  static const _channel = MethodChannel('rtcexpress');
  static const _events = EventChannel('rtcexpress/events');

  static Stream<Map<String, dynamic>>? _eventStream;

  static Future<Map<String, dynamic>> fetchToken(
    String serverUrl,
    TokenRequest request,
  ) async {
    final result = await _channel.invokeMapMethod<String, dynamic>(
      'fetchToken',
      {'serverUrl': serverUrl, 'request': request.toMap()},
    );
    return Map<String, dynamic>.from(result ?? {});
  }

  Stream<Map<String, dynamic>> get events {
    _eventStream ??= _events
        .receiveBroadcastStream()
        .map((e) => Map<String, dynamic>.from(e as Map));
    return _eventStream!;
  }

  void on(String eventName, RTCEventHandler handler) {
    events.listen((payload) {
      if (payload['event'] == eventName) {
        final data = payload['data'];
        handler(Map<String, dynamic>.from(data as Map? ?? {}));
      }
    });
  }

  Future<void> init(RTCInitOptions options) async {
    await _channel.invokeMethod('init', options.toMap());
  }

  Future<void> joinRoom(String roomId) async {
    await _channel.invokeMethod('joinRoom', {'roomId': roomId});
  }

  Future<void> sendMessage(String text, {String? clientMsgId}) async {
    await _channel.invokeMethod('sendMessage', {'text': text, if (clientMsgId != null) 'clientMsgId': clientMsgId});
  }

  /// Android history bridge; call after the roomJoined event.
  Future<Map<String, dynamic>> getHistory(String roomId, {String? before}) async {
    final result = await _channel.invokeMapMethod<String, dynamic>('getHistory', {'roomId': roomId, if (before != null) 'before': before});
    return result ?? <String, dynamic>{};
  }

  Future<void> callUser(String peerUserId, {bool video = false}) async {
    await _channel.invokeMethod('callUser', {
      'peerUserId': peerUserId,
      'video': video,
    });
  }

  Future<void> acceptCall() async => _channel.invokeMethod('acceptCall');
  Future<void> rejectCall() async => _channel.invokeMethod('rejectCall');
  Future<void> endCall() async => _channel.invokeMethod('endCall');

  Future<void> muteMicrophone(bool muted) async {
    await _channel.invokeMethod('muteMicrophone', {'muted': muted});
  }

  Future<void> muteCamera(bool muted) async {
    await _channel.invokeMethod('muteCamera', {'muted': muted});
  }

  Future<void> switchCamera() async => _channel.invokeMethod('switchCamera');
  Future<void> destroy() async => _channel.invokeMethod('destroy');
}
