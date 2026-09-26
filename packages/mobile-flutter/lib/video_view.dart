import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// Android renderer for the active P2P call. Place it inside bounded dimensions.
class RTCVideoView extends StatelessWidget {
  final bool local;
  const RTCVideoView({super.key, this.local = false});

  @override
  Widget build(BuildContext context) {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) {
      throw UnsupportedError('RTCVideoView currently supports Android only');
    }
    return AndroidView(
      viewType: 'rtcexpress/video',
      creationParams: <String, dynamic>{'local': local},
      creationParamsCodec: const StandardMessageCodec(),
    );
  }
}
