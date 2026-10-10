import "./style.css";
import { RTCExpress } from "@rtc/sdk";

const SERVER_URL = window.location.origin;
let APP_ID = "";
const params = new URLSearchParams(location.search);
const suppliedRoom = params.get("room") || "";
const DEFAULT_ROOM = /^[a-zA-Z0-9_-]{1,64}$/.test(suppliedRoom) ? suppliedRoom : `test-${crypto.randomUUID().replaceAll("-", "").slice(0,20)}`;
const DEVICE = params.get("device") === "b" ? "b" : "a";
const ownUser = `guest_${DEFAULT_ROOM}_${DEVICE}`;
const peerUser = `guest_${DEFAULT_ROOM}_${DEVICE === "a" ? "b" : "a"}`;
function deviceUrl(device: string) { const url = new URL(location.href); url.search = ""; url.hash = ""; url.searchParams.set("room", DEFAULT_ROOM); url.searchParams.set("device",device); return url.href; }
history.replaceState(null, "", deviceUrl(DEVICE));
function describeError(error: unknown) {
  if(error instanceof DOMException && error.name === "NotAllowedError") return "Permission was blocked. Allow the microphone/camera in your browser site settings, then try again.";
  if(error instanceof DOMException && error.name === "NotFoundError") return "No microphone or camera was found. Connect a device and try again.";
  if(error instanceof DOMException && error.name === "NotReadableError") return "The microphone or camera is busy. Close other apps using it and try again.";
  return error instanceof Error ? error.message : "Unable to complete this action.";
}

/**
 * Asks the server to mint a demo token.
 *
 * The app secret deliberately never reaches the browser — this page is served
 * publicly, so anything embedded here is public too. The server decides whether
 * the demo is enabled and issues the token itself.
 */
async function fetchDemoToken(userId: string, roomId?: string) {
  const res = await fetch(`${SERVER_URL}/v1/demo/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, roomId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Failed to fetch token (${res.status})`);
  }
  return (await res.json()) as { token: string; expiresIn: number };
}

interface PanelConfig {
  title: string;
  defaultUserId: string;
  mount: HTMLElement;
}

function log(el: HTMLElement, text: string) {
  el.textContent = text;
}

function appendMessage(
  container: HTMLElement,
  from: string,
  text: string,
  self: boolean
) {
  const div = document.createElement("div");
  div.className = `msg ${self ? "self" : ""}`;
  div.textContent = `${from}: ${text}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function attachStream(video: HTMLVideoElement, stream: MediaStream) {
  video.srcObject = stream;
  void video.play().catch(() => {});
}

function createPanel(config: PanelConfig) {
  const root = document.createElement("section");
  root.className = "panel";
  root.innerHTML = `
    <h2>${config.title}</h2>
    <div class="status">Disconnected</div>
    <div class="quality-badge" hidden>Quality: —</div>
    <div class="row">
      <input class="user-id" value="${config.defaultUserId}" placeholder="User ID" />
      <input class="room-id" value="${DEFAULT_ROOM}" placeholder="Room ID" />
    </div>
    <div class="row">
      <label class="mode-label">
        Media
        <select class="media-mode">
          <option value="auto" selected>Auto (SFU if available)</option>
          <option value="sfu">SFU</option>
          <option value="p2p">P2P</option>
        </select>
      </label>
    </div>
    <div class="row">
      <button class="connect">Connect</button>
      <button class="join secondary" disabled>Join room</button>
    </div>
    <div class="video-area" hidden>
      <div class="video-box">
        <video class="local-video" autoplay playsinline muted></video>
        <span class="video-label">You</span>
      </div>
      <div class="remote-videos"></div>
    </div>
    <div class="messages"></div>
    <div class="row">
      <input class="chat-input" placeholder="Type a message..." disabled />
      <button class="send secondary" disabled>Send</button>
    </div>
    <div class="row">
      <input class="peer-id" placeholder="Peer user ID" disabled />
      <button class="call secondary" disabled>Voice call</button>
      <button class="video-call secondary" disabled>Video call</button>
    </div>
    <div class="row">
      <button class="group-voice secondary" disabled>Group voice</button>
      <button class="group-video secondary" disabled>Group video</button>
      <button class="leave-media secondary" disabled hidden>Leave media</button>
    </div>
    <div class="call-bar">
      <button class="accept success" disabled hidden>Accept</button>
      <button class="reject danger" disabled hidden>Reject</button>
      <button class="end danger" disabled hidden>End call</button>
      <button class="mute secondary" disabled hidden>Mute</button>
      <button class="cam secondary" disabled hidden>Cam off</button>
      <button class="flip-cam secondary" disabled hidden>Flip cam</button>
      <button class="screen secondary" disabled hidden>Share screen</button>
      <button class="record danger" disabled hidden>Record</button>
      <button class="stop-record danger" disabled hidden>Stop &amp; save</button>
    </div>
    <div class="log"></div>
  `;
  config.mount.appendChild(root);

  const statusEl = root.querySelector(".status") as HTMLElement;
  const userIdInput = root.querySelector(".user-id") as HTMLInputElement;
  const roomIdInput = root.querySelector(".room-id") as HTMLInputElement;
  const connectBtn = root.querySelector(".connect") as HTMLButtonElement;
  const joinBtn = root.querySelector(".join") as HTMLButtonElement;
  const messagesEl = root.querySelector(".messages") as HTMLElement;
  const chatInput = root.querySelector(".chat-input") as HTMLInputElement;
  const sendBtn = root.querySelector(".send") as HTMLButtonElement;
  const peerIdInput = root.querySelector(".peer-id") as HTMLInputElement;
  peerIdInput.value = peerUser;
  userIdInput.readOnly = true;
  roomIdInput.readOnly = true;
  userIdInput.setAttribute("aria-label", "Your test user ID");
  roomIdInput.setAttribute("aria-label", "Shared test room");
  peerIdInput.setAttribute("aria-label", "Other device user ID");

  const callBtn = root.querySelector(".call") as HTMLButtonElement;
  const videoCallBtn = root.querySelector(".video-call") as HTMLButtonElement;
  const acceptBtn = root.querySelector(".accept") as HTMLButtonElement;
  const rejectBtn = root.querySelector(".reject") as HTMLButtonElement;
  const endBtn = root.querySelector(".end") as HTMLButtonElement;
  const muteBtn = root.querySelector(".mute") as HTMLButtonElement;
  const camBtn = root.querySelector(".cam") as HTMLButtonElement;
  const flipCamBtn = root.querySelector(".flip-cam") as HTMLButtonElement;
  const screenBtn = root.querySelector(".screen") as HTMLButtonElement;
  const recordBtn = root.querySelector(".record") as HTMLButtonElement;
  const stopRecordBtn = root.querySelector(".stop-record") as HTMLButtonElement;
  const mediaModeSelect = root.querySelector(".media-mode") as HTMLSelectElement;
  const groupVoiceBtn = root.querySelector(".group-voice") as HTMLButtonElement;
  const groupVideoBtn = root.querySelector(".group-video") as HTMLButtonElement;
  const leaveMediaBtn = root.querySelector(".leave-media") as HTMLButtonElement;
  const videoArea = root.querySelector(".video-area") as HTMLElement;
  const localVideo = root.querySelector(".local-video") as HTMLVideoElement;
  const remoteVideos = root.querySelector(".remote-videos") as HTMLElement;
  const logEl = root.querySelector(".log") as HTMLElement;
  const qualityBadge = root.querySelector(".quality-badge") as HTMLElement;

  let rtc: RTCExpress | null = null;
  let muted = false;
  let camOff = false;
  let inCall = false;
  let inRoom = false;
  let inGroupMedia = false;
  let isVideoSession = false;
  const remoteVideoEls = new Map<string, HTMLVideoElement>();

  function setConnected(connected: boolean) {
    joinBtn.disabled = !connected;
    chatInput.disabled = !connected || !inRoom;
    sendBtn.disabled = !connected || !inRoom;
    peerIdInput.disabled = !connected || !inRoom;
    callBtn.disabled = !connected || !inRoom || inCall || inGroupMedia;
    videoCallBtn.disabled = !connected || !inRoom || inCall || inGroupMedia;
    groupVoiceBtn.disabled = !connected || !inRoom || inCall || inGroupMedia;
    groupVideoBtn.disabled = !connected || !inRoom || inCall || inGroupMedia;
    connectBtn.textContent = connected ? "Connected" : "Connect";
    connectBtn.disabled = connected;
    mediaModeSelect.disabled = connected;
    statusEl.textContent = connected
      ? `Connected as ${userIdInput.value}`
      : "Disconnected";
  }

  let incomingCall = false;
  let sharingScreen = false;
  function resetScreenButton() { sharingScreen = false; screenBtn.textContent = "Share screen"; }

  function setCallUi(ringing: boolean, active: boolean, video = false) {
    acceptBtn.hidden = !(ringing && incomingCall);
    rejectBtn.hidden = !(ringing && incomingCall);
    endBtn.hidden = !active;
    muteBtn.hidden = !active;
    camBtn.hidden = !active || !video;
    flipCamBtn.hidden = !active || !video;
    screenBtn.hidden = !active;
    recordBtn.hidden = !active;
    stopRecordBtn.hidden = !active;
    acceptBtn.disabled = !(ringing && incomingCall);
    rejectBtn.disabled = !(ringing && incomingCall);
    endBtn.disabled = !active;
    muteBtn.disabled = !active;
    camBtn.disabled = !active;
    flipCamBtn.disabled = !active || !video;
    screenBtn.disabled = !active;
    recordBtn.disabled = !active;
    stopRecordBtn.disabled = !active;
    callBtn.disabled = ringing || active || !inRoom || inGroupMedia;
    videoCallBtn.disabled = ringing || active || !inRoom || inGroupMedia;
    inCall = ringing || active;
    isVideoSession = video;
    videoArea.hidden = !video && !inGroupMedia;
  }

  function clearRemoteVideos() {
    remoteVideoEls.forEach((v) => {
      v.srcObject = null;
      v.remove();
    });
    remoteVideoEls.clear();
    remoteVideos.innerHTML = "";
  }

  function wireRtc(rtcInstance: RTCExpress) {
    rtcInstance.on("localStream", ({ stream }) => {
      if (stream) attachStream(localVideo, stream);
      else localVideo.srcObject = null;
    });

    rtcInstance.on("remoteTrack", ({ producerId, userId, kind, stream, source }) => {
      if (kind !== "video") return;
      let video = remoteVideoEls.get(producerId);
      if (!video) {
        const box = document.createElement("div");
        box.className = "video-box";
        video = document.createElement("video");
        video.autoplay = true;
        // The SDK plays remote audio separately; keep the video element silent.
        video.muted = true;
        video.playsInline = true;
        const label = document.createElement("span");
        label.className = "video-label";
        label.textContent = `${userId} (${source || "cam"})`;
        box.appendChild(video);
        box.appendChild(label);
        remoteVideos.appendChild(box);
        remoteVideoEls.set(producerId, video);
      }
      attachStream(video, stream);
      videoArea.hidden = false;
    });
  }

  connectBtn.onclick = async () => {
    try {
      const userId = userIdInput.value.trim();
      if (!userId) return;
      connectBtn.disabled = true;
      rtc?.destroy();
      log(logEl, "Fetching token...");
      const tokenRes = await fetchDemoToken(userId, roomIdInput.value.trim());
      rtc = new RTCExpress();
      wireRtc(rtc);

      rtc.on("roomJoined", () => {
        log(logEl, `Joined ${roomIdInput.value.trim()}. Connect device ${DEVICE === "a" ? "B" : "A"}, then send a message.`);
        inRoom = true;
        setConnected(true);
      });
      rtc.on("disconnected", () => { inRoom = false; setConnected(false); log(logEl, "Connection lost. Reconnect, then join the room again."); });
      rtc.on("message", (msg) => {
        appendMessage(messagesEl, msg.fromUserId, msg.text, false);
      });
      rtc.on("userJoined", ({ userId: joined }) => {
        log(logEl, `${joined} joined the room`);
      });
      rtc.on("callInvite", ({ fromUserId, callType }) => {
        incomingCall = true;
        log(logEl, `Incoming ${callType || "voice"} call from ${fromUserId}`);
        setCallUi(true, false, callType === "video");
      });
      rtc.on("callState", ({ state, peerUserId, mediaMode, callType }) => {
        log(logEl, `Call ${state} with ${peerUserId} (${callType || "voice"}, ${mediaMode || "p2p"})`);
        const video = callType === "video";
        setCallUi(state === "ringing", state === "connecting" || state === "connected", video);
        if (state === "ended" || state === "rejected") {
          setCallUi(false, false);
          inCall = false;
          isVideoSession = false;
          qualityBadge.hidden = true;
          incomingCall = false; resetScreenButton();
          clearRemoteVideos();
          videoArea.hidden = !inGroupMedia;
          setConnected(true);
        }
      });
      rtc.on("recordingStarted", () => log(logEl, "Recording started..."));
      rtc.on("recordingReady", ({ durationMs, sizeBytes, url, recordingId }) => {
        log(logEl, `Recording ready (${Math.round(durationMs / 1000)}s, ${Math.round(sizeBytes / 1024)} KB)`);
        if (recordingId) log(logEl, `Recording ID: ${recordingId} — processing transcript...`);
        const a = document.createElement("a");
        a.href = url;
        a.download = `rtc-recording-${Date.now()}.webm`;
        a.textContent = "Download recording";
        a.style.color = "#93c5fd";
        a.style.display = "block";
        a.style.marginTop = "8px";
        logEl.appendChild(a);
      });
      rtc.on("transcriptReady", ({ transcript }) => {
        log(logEl, `Transcript: ${transcript}`);
      });
      rtc.on("summaryReady", ({ summary }) => {
        log(logEl, `AI Summary: ${summary}`);
      });
      rtc.on("callQuality", ({ score, label, metrics }) => {
        qualityBadge.hidden = false;
        qualityBadge.className = `quality-badge ${label}`;
        const parts = [`Quality: ${label} (${score})`];
        if (metrics.rttMs != null) parts.push(`RTT ${metrics.rttMs}ms`);
        if (metrics.packetLossPct != null) parts.push(`loss ${metrics.packetLossPct}%`);
        qualityBadge.textContent = parts.join(" · ");
      });
      rtc.on("error", ({ message }) => log(logEl, message));
      rtc.on("voiceRoomJoined", () => {
        inGroupMedia = true;
        groupVoiceBtn.hidden = true;
        groupVideoBtn.hidden = true;
        leaveMediaBtn.hidden = false;
        leaveMediaBtn.disabled = false;
        muteBtn.hidden = false;
        muteBtn.disabled = false;
        setConnected(true);
        log(logEl, "Joined group voice");
      });
      rtc.on("videoRoomJoined", () => {
        inGroupMedia = true;
        isVideoSession = true;
        groupVoiceBtn.hidden = true;
        groupVideoBtn.hidden = true;
        leaveMediaBtn.hidden = false;
        leaveMediaBtn.disabled = false;
        muteBtn.hidden = false;
        camBtn.hidden = false;
        flipCamBtn.hidden = false;
        screenBtn.hidden = false;
        recordBtn.hidden = false;
        stopRecordBtn.hidden = false;
        videoArea.hidden = false;
        setConnected(true);
        log(logEl, "Joined group video");
      });
      rtc.on("voiceRoomLeft", () => {
        inGroupMedia = false;
        groupVoiceBtn.hidden = false;
        groupVideoBtn.hidden = false;
        leaveMediaBtn.hidden = true;
        muteBtn.hidden = true;
        muted = false;
        muteBtn.textContent = "Mute";
        clearRemoteVideos();
        videoArea.hidden = true;
        localVideo.srcObject = null;
        setConnected(true);
        log(logEl, "Left group voice");
      });
      rtc.on("videoRoomLeft", () => {
        inGroupMedia = false;
        isVideoSession = false;
        groupVoiceBtn.hidden = false;
        groupVideoBtn.hidden = false;
        leaveMediaBtn.hidden = true;
        muteBtn.hidden = true;
        camBtn.hidden = true;
        flipCamBtn.hidden = true;
        screenBtn.hidden = true;
        muted = false;
        camOff = false;
        muteBtn.textContent = "Mute";
        camBtn.textContent = "Cam off";
        clearRemoteVideos();
        videoArea.hidden = true;
        localVideo.srcObject = null;
        setConnected(true);
        log(logEl, "Left group video");
      });

      await rtc.init({
        serverUrl: SERVER_URL,
        appId: APP_ID,
        autoReconnect: false,
        userId,
        token: tokenRes.token,
        mediaMode: mediaModeSelect.value as "auto" | "sfu" | "p2p",
      });
      setConnected(true);
      log(logEl, `Ready (${rtc.getMediaMode()}). Voice/video calls and group media supported.`);
    } catch (err) {
      rtc?.destroy();
      inRoom = false; setConnected(false);
      log(logEl, describeError(err));
    }
  };

  joinBtn.onclick = () => {
    try { rtc?.joinRoom(roomIdInput.value.trim()); log(logEl, "Joining room..."); } catch(error) { log(logEl, describeError(error)); }
  };

  sendBtn.onclick = () => {
    const text = chatInput.value.trim();
    if (!text || !rtc) return;
    try {
      rtc.sendMessage(text);
      appendMessage(messagesEl, "you", text, true);
      chatInput.value = "";
    } catch(error) { log(logEl, describeError(error)); }
  };

  chatInput.onkeydown = (e) => {
    if (e.key === "Enter") sendBtn.click();
  };

  callBtn.onclick = async () => {
    const peer = peerIdInput.value.trim();
    if (!peer || !rtc) return;
    try { incomingCall = false; await rtc.callUser(peer, { callType: "voice" }); } catch(error) { log(logEl, describeError(error)); }
  };

  videoCallBtn.onclick = async () => {
    const peer = peerIdInput.value.trim();
    if (!peer || !rtc) return;
    try { incomingCall = false; await rtc.videoCallUser(peer); } catch(error) { log(logEl, describeError(error)); }
  };

  acceptBtn.onclick = async () => {
    try {
      await rtc?.acceptCall();
      setCallUi(false, true, isVideoSession);
    } catch(error) { log(logEl, describeError(error)); }
  };

  rejectBtn.onclick = () => rtc?.rejectCall();
  endBtn.onclick = () => rtc?.endCall();

  muteBtn.onclick = () => {
    muted = !muted;
    rtc?.muteMicrophone(muted);
    muteBtn.textContent = muted ? "Unmute" : "Mute";
  };

  camBtn.onclick = () => {
    camOff = !camOff;
    rtc?.muteCamera(camOff);
    camBtn.textContent = camOff ? "Cam on" : "Cam off";
  };

  flipCamBtn.onclick = async () => {
    try {
      await rtc?.switchCamera();
      log(logEl, "Camera switched");
    } catch (err) {
      log(logEl, err instanceof Error ? err.message : "Could not switch camera");
    }
  };

  screenBtn.onclick = async () => {
    if (!rtc) return;
    screenBtn.disabled = true;
    try {
      if (sharingScreen) { await rtc.stopScreenShare(); resetScreenButton(); log(logEl, "Screen sharing stopped"); }
      else {
        if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen sharing is not supported in this browser. Try desktop Chrome or Edge.");
        const stream = await rtc.shareScreen();
        sharingScreen = true; screenBtn.textContent = "Stop sharing";
        stream?.getVideoTracks()[0]?.addEventListener("ended", resetScreenButton, { once: true });
        log(logEl, "Screen sharing started. Use Stop sharing to return to your camera.");
      }
    } catch (err) { log(logEl, describeError(err)); }
    finally { screenBtn.disabled = false; }
  };

  recordBtn.onclick = () => {
    try {
      rtc?.startRecording();
      recordBtn.disabled = true;
      stopRecordBtn.disabled = false;
      log(logEl, "Recording...");
    } catch (err) {
      log(logEl, err instanceof Error ? err.message : "Record failed");
    }
  };

  stopRecordBtn.onclick = async () => {
    try {
      await rtc?.stopRecording();
      recordBtn.disabled = false;
      stopRecordBtn.disabled = true;
    } catch (err) {
      log(logEl, err instanceof Error ? err.message : "Stop recording failed");
    }
  };

  groupVoiceBtn.onclick = async () => {
    try {
      await rtc?.joinVoiceRoom();
    } catch (err) {
      log(logEl, err instanceof Error ? err.message : "Group voice failed");
    }
  };

  groupVideoBtn.onclick = async () => {
    try {
      await rtc?.joinVideoRoom();
    } catch (err) {
      log(logEl, err instanceof Error ? err.message : "Group video failed");
    }
  };

  leaveMediaBtn.onclick = () => {
    if (isVideoSession) rtc?.leaveVideoRoom();
    else rtc?.leaveVoiceRoom();
  };
}

const app = document.getElementById("app")!;
app.innerHTML = `
  <header><p class="eyebrow">RTCEXPRESS / GUIDED DEMO</p><h1>Your first real-time connection</h1><p>Use two devices or two browser windows. This is a public demonstration project, separate from your customer account. Use test messages only.</p></header>
  <section class="demo-guide"><ol><li><strong>1. Invite your second device</strong><p>Copy the other device's link below. Each device has a different user ID and the same room.</p></li><li><strong>2. Connect and join</strong><p>On both devices, press Connect, then Join room. Send a message to confirm the connection.</p></li><li><strong>3. Try a call</strong><p>Allow microphone/camera access, start a voice or video call, then accept on the other device. Use headphones to avoid feedback.</p></li></ol>
  <label>Link for device ${DEVICE === "a" ? "B" : "A"}<input id="invite-url" readonly aria-label="Other device invitation"></label><div class="row"><button id="copy-invite">Copy invitation</button><a id="open-peer" target="_blank" rel="noopener">Open second window</a><a href="./">New test room</a></div><p id="invite-status" role="status"></p>
  <details><summary>Check microphone/camera and troubleshoot</summary><p>Use HTTPS or localhost. Allow access in browser site settings. On a phone, also check the browser's permissions in system settings. A second tab may compete for the same camera; two physical devices give a better test.</p><div class="row"><button id="check-mic">Check microphone</button><button id="check-camera">Check camera + microphone</button></div><p id="permission-result" role="status">Devices are accessed only when you press a check button. Test tracks are stopped immediately afterward.</p><p>Room links are invitations, not private access controls. Reloading or returning later may require reconnecting. If the demo is unavailable, contact support.</p></details></section>
  <p id="demo-availability" role="status">Checking demo availability...</p><div class="panels"></div>`;
const invite = document.getElementById("invite-url") as HTMLInputElement;
invite.value = deviceUrl(DEVICE === "a" ? "b" : "a");
(document.getElementById("open-peer") as HTMLAnchorElement).href = invite.value;
document.getElementById("copy-invite")!.onclick = async () => {const status=document.getElementById("invite-status")!;try{await navigator.clipboard.writeText(invite.value);status.textContent="Invitation copied. Open it on the other device.";}catch{invite.select();status.textContent="Select and copy the invitation above.";}};
for(const [id,video] of [["check-mic",false],["check-camera",true]] as const){document.getElementById(id)!.onclick=async()=>{const result=document.getElementById("permission-result")!;const buttons=Array.from(document.querySelectorAll<HTMLButtonElement>('#check-mic,#check-camera'));buttons.forEach(b=>b.disabled=true);result.textContent="Waiting for device permission...";try{if(!navigator.mediaDevices?.getUserMedia)throw new Error("Device checks require HTTPS and a browser supporting microphone/camera access.");const stream=await navigator.mediaDevices.getUserMedia({audio:true,video});stream.getTracks().forEach(t=>t.stop());result.textContent="Device access works. Test tracks stopped. This checks permissions, not network call quality.";}catch(error){result.textContent=describeError(error);}finally{buttons.forEach(b=>b.disabled=false);}};}
void fetch(`${SERVER_URL}/v1/demo/status`).then(async res=>{if(!res.ok)throw new Error("Unable to check the demo right now. Reload to retry.");return res.json();}).then(data=>{if(!data.enabled||typeof data.appId!=="string")throw new Error("The public demo is currently unavailable. Contact support or try again later.");APP_ID=data.appId;document.getElementById("demo-availability")!.textContent=`Device ${DEVICE.toUpperCase()} is ready. Start by connecting below.`;createPanel({title:`Device ${DEVICE.toUpperCase()}`,defaultUserId:ownUser,mount:document.querySelector(".panels")!});}).catch(error=>{document.getElementById("demo-availability")!.textContent=describeError(error);});
