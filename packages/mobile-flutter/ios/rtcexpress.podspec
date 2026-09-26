Pod::Spec.new do |s|
  s.name             = 'rtcexpress'
  s.version          = '0.1.0'
  s.summary          = 'Flutter plugin for RTC Platform'
  s.homepage         = 'https://github.com/Devs-private-limited/rtc-platform'
  s.license          = { :type => 'MIT' }
  s.author           = { 'RTC Platform' => 'dev@rtc.local' }
  s.source           = { :path => '.' }
  s.source_files     = [
    'Classes/**/*',
    '../../mobile-ios/Sources/RTCExpress/**/*.swift'
  ]
  s.dependency 'Flutter'
  s.dependency 'Mediasoup-Client-Swift', '0.13.2'
  s.platform = :ios, '15.0'
  s.swift_version = '5.9'
end
