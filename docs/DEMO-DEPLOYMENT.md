# Deploy the guided demo and call fixes

The public marketing website deployment does not deploy the demo at `/demo/`.

This update includes signaling authorization changes for one-to-one SFU producer announcements, SDK screen-share changes, and demo controls. Deploy both signaling and web assets. No database migration is added by this update.

On the VM, in the existing checkout:

```sh
cd ~/rtc-platform
git status --short
git pull --ff-only origin main
sudo docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build signaling
sudo docker compose -f docker-compose.prod.yml --env-file .env.production build web-build
sudo docker compose -f docker-compose.prod.yml --env-file .env.production run --rm web-build
curl -fsS https://rtcplatform.duckdns.org/ready
```

Stop before pulling if the checkout contains changes that must be preserved. Deploy during a quiet period because restarting signaling interrupts active calls.

Hard-refresh `/demo/`. The current demo has one Device A/B panel and an invitation link, not simultaneous User A and User B panels. Use the invitation on another device.

Acceptance checks:
- Connect and join both devices; exchange messages.
- Start a video call. Only the recipient should see Accept/Reject.
- Confirm both cameras on both devices in normal mobile mode.
- From desktop, share a screen; verify the receiving device shows it.
- Press Stop sharing, and repeat using the browser's own Stop sharing control. Confirm local capture stops; in P2P video calls the camera returns to the existing remote tile.
- End the call and repeat with the opposite caller.
- Repeat voice then screen share, supported group calls, and different networks.

Automated validation covers scoped SFU signaling and rejection of invalid peers/rooms, P2P screen replacement/restoration and voice-call renegotiation, plus demo caller/callee controls using a fixture relay. It does not prove physical-device media delivery.
