import type { WebRtcPayload } from "@rtc/protocol";
import type { SignalingSend } from "./types.js";

export interface P2pMediaOptions {
  audio?: boolean;
  video?: boolean;
}

export type OnRemoteStream = (stream: MediaStream) => void;

type CameraFacing = "user" | "environment";

function videoConstraints(facingMode: CameraFacing): MediaTrackConstraints {
  return { facingMode: { ideal: facingMode } };
}

export class P2pMediaEngine {
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private remoteMediaStream: MediaStream | null = null;
  private mediaOptions: P2pMediaOptions = { audio: true, video: false };
  private facingMode: CameraFacing = "user";

  constructor(
    private iceServers: RTCIceServer[],
    private userId: string,
    private send: SignalingSend,
    private getActiveCall: () => {
      callId: string;
      peerUserId: string;
    } | null,
    private onRemoteStream?: OnRemoteStream
  ) {}

  setMediaOptions(options: P2pMediaOptions) {
    this.mediaOptions = { audio: options.audio !== false, video: options.video === true };
  }

  async prepare(isCaller: boolean) {
    if (this.peerConnection) return;
    this.peerConnection = new RTCPeerConnection({ iceServers: this.iceServers });
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: this.mediaOptions.audio,
      video: this.mediaOptions.video ? videoConstraints(this.facingMode) : false,
    });
    this.localStream.getTracks().forEach((track) => {
      this.peerConnection!.addTrack(track, this.localStream!);
    });

    this.remoteAudio = new Audio();
    this.remoteAudio.autoplay = true;
    this.peerConnection.ontrack = (event) => {
      if (!this.remoteMediaStream) this.remoteMediaStream = new MediaStream();
      if (!this.remoteMediaStream.getTracks().some((t) => t.id === event.track.id)) {
        this.remoteMediaStream.addTrack(event.track);
      }

      if (event.track.kind === "audio" && this.remoteAudio) {
        this.remoteAudio.srcObject = new MediaStream(this.remoteMediaStream.getAudioTracks());
      }

      this.onRemoteStream?.(this.remoteMediaStream);
    };

    this.peerConnection.onicecandidate = (event) => {
      const call = this.getActiveCall();
      if (!event.candidate || !call) return;
      this.send({
        type: "ice_candidate",
        payload: {
          callId: call.callId,
          fromUserId: this.userId,
          toUserId: call.peerUserId,
          candidate: event.candidate.toJSON(),
        },
      });
    };

    if (!isCaller) {
      // callee waits for offer
    }
  }

  getLocalStream() {
    return this.localStream;
  }

  getRemoteStream() {
    return this.remoteMediaStream;
  }

  getPeerConnection() {
    return this.peerConnection;
  }

  async createOffer(peerUserId: string, callId: string) {
    await this.prepare(true);
    const offer = await this.peerConnection!.createOffer();
    await this.peerConnection!.setLocalDescription(offer);
    this.send({
      type: "webrtc_offer",
      payload: {
        callId,
        fromUserId: this.userId,
        toUserId: peerUserId,
        sdp: offer,
      },
    });
  }

  async handleOffer(payload: WebRtcPayload) {
    if (!payload.sdp) return;
    await this.prepare(false);
    await this.peerConnection!.setRemoteDescription(payload.sdp);
    const answer = await this.peerConnection!.createAnswer();
    await this.peerConnection!.setLocalDescription(answer);
    this.send({
      type: "webrtc_answer",
      payload: {
        callId: payload.callId,
        fromUserId: this.userId,
        toUserId: payload.fromUserId,
        sdp: answer,
      },
    });
  }

  async handleAnswer(payload: WebRtcPayload) {
    if (!payload.sdp || !this.peerConnection) return;
    await this.peerConnection.setRemoteDescription(payload.sdp);
  }

  async handleIceCandidate(payload: WebRtcPayload) {
    if (!payload.candidate || !this.peerConnection) return;
    await this.peerConnection.addIceCandidate(payload.candidate);
  }

  onConnected(callback: () => void) {
    if (!this.peerConnection) return;
    this.peerConnection.onconnectionstatechange = () => {
      if (this.peerConnection?.connectionState === "connected") callback();
    };
  }

  async shareScreen() {
    if (!this.peerConnection) throw new Error("Not in call");
    if (this.screenStream) await this.stopScreenShare();
    this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = this.screenStream.getVideoTracks()[0];
    screenTrack.onended = () => void this.stopScreenShare();

    const sender = this.peerConnection.getSenders().find((s) => s.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(screenTrack);
    } else {
      this.peerConnection.addTrack(screenTrack, this.screenStream);
      const call = this.getActiveCall();
      if (call) await this.createOffer(call.peerUserId, call.callId);
    }
    return this.screenStream;
  }

  async stopScreenShare() {
    if (!this.peerConnection || !this.localStream) return;
    const cameraTrack = this.localStream.getVideoTracks()[0];
    const sender = this.peerConnection.getSenders().find((s) => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(cameraTrack || null);
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
  }

  muteMicrophone(muted: boolean) {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  muteCamera(muted: boolean) {
    this.localStream?.getVideoTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  async switchCamera() {
    if (!this.peerConnection || !this.localStream) {
      throw new Error("Not in a video call");
    }
    if (this.screenStream) {
      throw new Error("Stop screen share before switching camera");
    }
    const oldTrack = this.localStream.getVideoTracks()[0];
    if (!oldTrack) throw new Error("No camera track");

    const nextFacing: CameraFacing = this.facingMode === "user" ? "environment" : "user";
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: videoConstraints(nextFacing),
    });
    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) throw new Error("Could not access camera");

    const sender = this.peerConnection.getSenders().find((s) => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(newTrack);

    oldTrack.stop();
    this.localStream.removeTrack(oldTrack);
    this.localStream.addTrack(newTrack);
    this.facingMode = nextFacing;
    return this.localStream;
  }

  destroy() {
    this.peerConnection?.close();
    this.peerConnection = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
      this.remoteAudio = null;
    }
    this.remoteMediaStream = null;
  }
}

export { P2pMediaEngine as P2pVoiceEngine };
