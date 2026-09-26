require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "RTCExpress"
  s.version      = package["version"]
  s.summary      = "React Native bridge for RTC Platform"
  s.homepage     = "https://github.com/Devs-private-limited/rtc-platform"
  s.license      = "MIT"
  s.authors      = { "RTC Platform" => "dev@rtc.local" }
  s.platforms    = { :ios => "15.0" }
  s.source       = { :path => "." }

  s.source_files = [
    "ios/**/*.{h,m,mm,swift}",
    "../../mobile-ios/Sources/RTCExpress/**/*.swift"
  ]

  s.dependency "React-Core"
  s.dependency "Mediasoup-Client-Swift", "0.13.2"
end
