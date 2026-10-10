import test from 'node:test';
import assert from 'node:assert/strict';
import { P2pMediaEngine } from './p2p-media.js';

test('screen share replaces video and stopping restores camera', async (t) => {
  const camera = {kind:'video'}; const screen = {kind:'video',stop:t.mock.fn(),onended:null};
  const stream = {getVideoTracks:()=>[screen],getTracks:()=>[screen]};
  const previous = Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getDisplayMedia:async()=>stream}}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'navigator',previous);else Reflect.deleteProperty(globalThis,'navigator');});
  const sender = {track:camera,replaceTrack:t.mock.fn(async()=>{})};
  const engine = new P2pMediaEngine([], 'alice',()=>{},()=>({callId:'c',peerUserId:'bob'}));
  Object.assign(engine,{peerConnection:{getSenders:()=>[sender]},localStream:{getVideoTracks:()=>[camera]}});
  assert.equal(await engine.shareScreen(),stream);
  assert.equal(sender.replaceTrack.mock.calls[0].arguments[0],screen);
  await engine.stopScreenShare();
  assert.equal(sender.replaceTrack.mock.calls[1].arguments[0],camera);
  assert.equal(screen.stop.mock.callCount(),1);
});

test('screen sharing in a voice call renegotiates the added video track', async (t) => {
  const screen = {kind:'video',stop:t.mock.fn(),onended:null};
  const stream = {getVideoTracks:()=>[screen],getTracks:()=>[screen]};
  const previous = Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getDisplayMedia:async()=>stream}}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'navigator',previous);else Reflect.deleteProperty(globalThis,'navigator');});
  const engine = new P2pMediaEngine([], 'alice',()=>{},()=>({callId:'c',peerUserId:'bob'}));
  const addTrack=t.mock.fn();Object.assign(engine,{peerConnection:{getSenders:()=>[],addTrack}});
  const offer=t.mock.method(engine,'createOffer',async()=>{});
  await engine.shareScreen();
  assert.equal(addTrack.mock.callCount(),1);
  assert.deepEqual(offer.mock.calls[0].arguments,['bob','c']);
});
