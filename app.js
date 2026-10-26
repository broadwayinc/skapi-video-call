/*
    app.js runs the whole application.

    How a call comes about:
      1. The page signs the visitor in with skapi.anonymousLogin(): a temporary account, no sign-up.
      2. Without ?room= in the address a new room id is made and put there; the address is the link to share.
      3. Everyone with the link joins the realtime group of that room. Realtime says who is there (USER_JOINED,
         USER_LEFT) and carries the WebRTC signaling; the call itself goes straight between the two browsers.
      4. When two people are in the room, the one with the smaller user id calls (skapi.connectRTC()) and the other
         accepts at once (connectRTC() on the rtc:incoming message). Nobody has to click anything.
      5. The call carries the camera and the microphone, the screen when shared, and two data channels:
         "chat" for messages and "drawing" for the shared board. Files go through rtcConnection.sendFile().

    Sections: project and sign-in, the room, the call and its tiles, controls, the drawing board, the chat, helpers.
*/
"use strict";

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------------------------------------
   Project and sign-in
   --------------------------------------------------------------------------------------------------- */

/*
    Your Skapi project ID. This is the one line to change when you run this app on a project of your own:
    create a project at www.skapi.com, turn on "Anonymous Login" in its settings, and paste its ID here.
*/
const PROJECT_ID = "5VqfG6NuS163eFEcYy-7Zd6TgdLUaFxseKMT1qveY";

const skapi = new Skapi(PROJECT_ID, { autoLogin: true });

const me = { user_id: null, name: loadName() };

/*
    Temporary accounts only. autoLogin brings back the temporary account of an earlier visit, so a reload keeps
    the same account; a regular user who is logged in on this origin is logged out here first.
*/
async function signIn() {
    // Validate the restored session with a token refresh before using it. autoLogin brings back the
    // temporary account of an earlier visit, but the server sweeps a temporary account 30 minutes
    // after its last keep-alive. When the visitor returns after that window the stored token is still
    // structurally valid (not expired, signature good), so the session restores, yet the account
    // behind it no longer exists. The refresh is what detects this: it fails for a deleted account and
    // signs the dead session out, so getProfile resolves to null and we make a fresh account below.
    // Without the refresh the page carries a token for a deleted user to the realtime server, the
    // WebSocket is rejected (the 400), the SDK's socket never opens, and the lobby hangs forever on
    // "Connecting to the service...".
    let user = await skapi.getProfile({ refreshToken: true }).catch(() => null);
    if (user && !user.anonymous) {
        await skapi.logout();
        user = null;
    }
    if (!user) user = await skapi.anonymousLogin();
    return user;
}

/* ---------------------------------------------------------------------------------------------------
   The room: the link, who is here, and who calls whom
   --------------------------------------------------------------------------------------------------- */

/*
    The room. Opened without ?room= the page makes a room and is its host; opened through a link it is a guest.
    The host is in the room from the start. A guest looks in first and enters with the Enter button.
    (The tab remembers the room it made, so the host stays the host after a reload.)
*/
const urlParams = new URLSearchParams(location.search);
let room = urlParams.get("room");
let host = false;
if (!room) {
    room = randomId();
    urlParams.set("room", room);
    history.replaceState(null, "", "?" + urlParams.toString());
    host = true;
    try { sessionStorage.setItem("videocall:host", room); } catch (err) { }
} else {
    try { host = sessionStorage.getItem("videocall:host") === room; } catch (err) { }
}
const GROUP = "room-" + room;
let entered = host; // in the room's realtime group, visible to the others (a guest's tab remembers it entered, for reloads)
try { if (sessionStorage.getItem("videocall:entered") === room) entered = true; } catch (err) { }

// The address to share: this page with the room.
function shareUrl() {
    const url = new URL(location.href);
    url.hash = "";
    url.search = "";
    url.searchParams.set("room", room);
    return url.href;
}

const peers = new Map(); // connection id -> { user_id, name }: the other people in the room
let call = null; // the outgoing call, returned by skapi.connectRTC(), until it is answered
let receiver = null; // the incoming call, the rtc:incoming realtime message, until it is answered
let rtc = null; // the established connection (RTCResolved)
let peer = null; // { user_id, cid, name } of the person on the call
let endedWith = null; // user id of the person a call was ended with on purpose: no automatic call to them again
let leftByMe = false;
let cancelled = false;
let lobbyNote = "";
let attempt = 0; // counts calls started and ended; a step that outlives its call sees the number change and stops

function onRealtime(rt) {
    if (rt.type === "notice") {
        if (rt.code === "USER_JOINED" && rt.sender !== me.user_id) {
            peers.set(rt.sender_cid, { user_id: rt.sender, name: null });
            reconcile();
        } else if (rt.code === "USER_LEFT" || rt.code === "USER_DISCONNECTED") {
            peers.delete(rt.sender_cid);
            if (endedWith && ![...peers.values()].some((p) => p.user_id === endedWith)) endedWith = null; // gone; whoever comes next is called
            reconcile();
        }
    }

    if (rt.type === "rtc:incoming") {
        acceptCall(rt).catch((err) => showError(err.message));
    }

    if (rt.type === "rtc:closed" && receiver && receiver.sender_cid === rt.sender_cid) {
        // the caller gave up before this side answered
        receiver = null;
        endCall();
    }

    if (rt.type === "error") {
        // "Connection ID ... is not connected" is a signal sent to someone who already left; nothing to show
        if (/is not connected/i.test(String(rt.message))) console.warn(rt.message);
        else showError(String(rt.message || "The realtime connection failed."));
    }
}

/*
    Decides what to do with the people in the room. Runs whenever that changes.
    Two people, no call: the one with the smaller user id calls, the other waits for the call.
*/
function reconcile() {
    if (!entered || rtc || call || receiver || appState() === "calling") {
        return;
    }
    const others = [...peers.entries()].filter(([, p]) => p.user_id !== me.user_id);
    $("btnJoin").hidden = true;
    $("btnCancel").hidden = true;

    if (others.length === 0) {
        setLobbyStatus(host ? "Waiting for someone to open your link." : "Nobody else is here yet. Keep this page open.");
        setStatus("Waiting for someone to join");
        return;
    }
    if (others.length > 1) {
        setLobbyStatus("Two people are already in this call. Waiting for one of them to leave.", true);
        setStatus("The call is full");
        return;
    }

    const [cid, p] = others[0];
    const name = p.name || "Guest";
    if (p.user_id === endedWith) {
        if (lobbyNote === `${name} left the call.`) {
            lobbyNote = "";
            setLobbyStatus(`${name} left the call but is still here.`);
        } else {
            setLobbyStatus(`${name} is still here.`);
        }
        setStatus("Call ended");
        $("btnJoin").hidden = false;
        return;
    }
    if (me.user_id < p.user_id) {
        callPeer(cid, p).catch((err) => { showError(err.message); setState("lobby"); });
    } else {
        setLobbyStatus(`${name} is here. Connecting...`, false, true);
        setStatus("Connecting...");
    }
}

/* ---------------------------------------------------------------------------------------------------
   The call
   --------------------------------------------------------------------------------------------------- */

const CHANNELS = [{ protocol: "chat", ordered: true }, { protocol: "drawing", ordered: true }];
const channels = { chat: null, drawing: null }; // the data channels, once open
const camState = { me: true, them: true };
const micState = { me: true, them: true };
const remoteAudioStream = new MediaStream();
let announced = false; // "<name> joined" written in the chat once per call

/*
    What this side sends: the camera and the microphone the preview could open. What it could not open is
    asked for with `receive`, so the other side's camera and voice arrive all the same.
*/
async function mediaOptions() {
    await previewReady;
    const media = {};
    if (preview.audio) media.audio = true;
    if (preview.video) media.video = true;
    const receive = {};
    if (!preview.audio) receive.audio = true;
    if (!preview.video) receive.video = true;
    return { media, receive };
}

async function callPeer(cid, p) {
    if (rtc || call || receiver || appState() === "calling") return;
    const my = beginCall({ user_id: p.user_id, cid, name: p.name || "Guest" });
    setLobbyStatus(`Calling ${peer.name}...`, false, true);

    const options = await mediaOptions();
    if (attempt !== my) return; // cancelled while the camera was opening
    stopPreview(); // the connection opens the camera itself
    const connector = await skapi.connectRTC({
        cid,
        ...options,
        channels: CHANNELS,
        meta: { kind: "video call", room, name: me.name },
    }, onRTC);
    if (attempt !== my) { connector.hangup(); return; }
    call = connector;
    const connection = await connector.connection; // resolves when the other side picks up
    if (attempt !== my) { connection.hangup(); return; }
    call = null;
    rtc = connection;
    applyPrefs();
    refreshLocalTiles();
}

// Every call in this room is accepted at once: having the link is the invitation.
async function acceptCall(rt) {
    if (rtc && peer && rt.sender === peer.user_id) {
        // the same person calls again: they reloaded their page, and the connection to it is dead
        rtc.hangup(); // reports the old connection as closed, which ends it here
    }
    if (rtc || call || receiver || appState() === "calling") {
        rt.hangup(); // busy
        return;
    }
    receiver = rt;
    peers.set(rt.sender_cid, { user_id: rt.sender, name: rt.meta?.name || null });
    const my = beginCall({ user_id: rt.sender, cid: rt.sender_cid, name: rt.meta?.name || "Guest" });
    setLobbyStatus(`${peer.name} is calling. Connecting...`, false, true);

    const options = await mediaOptions();
    if (attempt !== my) return;
    stopPreview();
    const connection = await rt.connectRTC(options, onRTC); // null when the caller hung up meanwhile
    if (attempt !== my) { connection?.hangup?.(); return; }
    receiver = null;
    if (!connection) { endCall(); return; }
    rtc = connection;
    applyPrefs();
    refreshLocalTiles();
}

// The microphone and camera choices made in the waiting room, applied as soon as the call has its tracks.
// mute() keeps a track on the call and sends silence or black frames while it is off, so it can be turned on later.
function applyPrefs() {
    if (!rtc) return;
    rtc.mute({ audio: !prefs.mic, video: !prefs.camera });
    micState.me = prefs.mic && rtc.tracks("microphone").length > 0;
    camState.me = prefs.camera && rtc.tracks("camera").length > 0;
    sendState(); // the chat channel can be open already, with a state sent before the choice was applied
}

function beginCall(who) {
    peer = who;
    leftByMe = false;
    cancelled = false;
    announced = false;
    camState.me = true; camState.them = true;
    micState.me = true; micState.them = true;
    setPeerName(peer.name);
    clearLog();
    setState("calling");
    setStatus(`Connecting to ${peer.name}...`);
    $("btnJoin").hidden = true;
    $("btnCancel").hidden = false;
    return ++attempt;
}

// Cancel gives up a call that is still being set up. hangup() on a ringing call reports it as closed, which ends it here.
function cancelCall() {
    cancelled = true;
    if (call) {
        const c = call;
        call = null;
        c.hangup();
    } else if (receiver) {
        const r = receiver;
        receiver = null;
        r.hangup?.();
        endCall();
    } else {
        endCall();
    }
}

function leaveCall() {
    leftByMe = true;
    if (rtc) rtc.hangup(); // reports the connection as closed, which ends the call here
    else cancelCall();
}

/*
    After a call, however it ended: back to the waiting room with the camera preview.
    A call ended on purpose (Leave, on either side) is not started again by itself: the person who left gets a
    button. A call that was lost (`lost`: the connection dropped, a page was reloaded) may start again by itself.
*/
function endCall(lost) {
    const name = peer ? peer.name : "Guest";
    const mine = leftByMe;
    const gaveUp = cancelled;
    const gone = peer && !peers.has(peer.cid); // their page is closed or reloading
    if (peer && !lost) endedWith = peer.user_id;
    attempt++;
    rtc = null; call = null; receiver = null; peer = null; leftByMe = false; cancelled = false;
    channels.chat = null; channels.drawing = null;

    for (const view of VIEWS) hideTile(view);
    for (const t of remoteAudioStream.getTracks()) remoteAudioStream.removeTrack(t);
    $("btnSound").hidden = true;
    closeBoard(false);
    clearBoard(false);
    stage.view = null;
    renderStage();
    exitChatOverlay();

    lobbyNote = gaveUp ? "Call cancelled." : mine ? "You left the call." : lost && !gone ? "The connection was lost." : `${name} left the call.`;
    setState("lobby");
    previewReady = startPreview();
    reconcile();
}

/*
    Events of the connection: media tracks, connection state, data channels, files.
    Every remote track says what it is in `source`: camera, microphone or screen.
*/
function onRTC(e) {
    switch (e.type) {
        case "track": {
            if (e.track.kind === "audio") {
                remoteAudioStream.addTrack(e.track);
                e.track.addEventListener("ended", () => remoteAudioStream.removeTrack(e.track));
                playRemoteAudio();
                break;
            }
            const view = e.source === "screen" ? "them-screen" : "them-camera";
            showTile(view, new MediaStream([e.track]));
            break;
        }

        case "trackended":
            if (e.track?.kind === "video") hideTile(e.source === "screen" ? "them-screen" : "them-camera");
            break;

        case "trackmute":
            if (e.source === "screen") hideTile("them-screen"); // they stopped sharing
            break;

        case "trackunmute":
            if (e.source === "screen" && e.track) showTile("them-screen", new MediaStream([e.track]));
            break;

        case "unshare":
            // a local track left the call: the Stop sharing button here, or the browser's own one
            refreshLocalTiles();
            break;

        case "connectionstatechange":
            if (rtc && e.target !== rtc.target) break; // the last word of an older connection
            if (!rtc && !call && !receiver && appState() !== "calling") break; // nothing is active
            if (["connecting", "connected"].includes(e.state)) {
                if (appState() !== "incall") {
                    setState("incall");
                    openChat(wideScreen.matches, true);
                }
                setStatus(e.state === "connected" ? `In a call with ${peer?.name || "Guest"}` : "Connecting...");
                refreshLocalTiles();
            } else if (["disconnected", "failed", "closed"].includes(e.state)) {
                endCall(e.state !== "closed"); // "closed" is a hang-up, on either side; the others are a lost connection
            }
            break;

        case "open":
            if (e.label === "chat") {
                channels.chat = e.target;
                sendChat({ t: "hello", name: me.name });
                sendState();
            } else if (e.label === "drawing") {
                channels.drawing = e.target;
            }
            break;

        case "close":
            if (e.label === "chat") channels.chat = null;
            if (e.label === "drawing") channels.drawing = null;
            break;

        case "message":
            if (e.label === "chat") onChatMessage(e.data);
            else if (e.label === "drawing") onDrawMessage(e.data);
            break;

        case "fileprogress":
            fileProgress(e);
            break;

        case "file":
            fileReceived(e);
            break;
    }
}

/* ---- Tiles and the stage ---- */

const VIEWS = ["me-camera", "them-camera", "me-screen", "them-screen", "board"];
const tiles = {};
for (const el of document.querySelectorAll(".tile")) {
    const view = el.dataset.view;
    tiles[view] = { view, el, video: el.querySelector("video"), canvas: el.querySelector("canvas"), name: el.querySelector(".tile-name"), stream: null, shown: false };
    el.addEventListener("click", () => { stage.view = view; renderStage(); });
}
const stage = { view: null };
const STAGE_ORDER = ["them-screen", "board", "them-camera", "me-screen", "me-camera"];

function showTile(view, stream) {
    const t = tiles[view];
    const fresh = !t.shown;
    t.shown = true;
    t.el.hidden = false;
    if (t.video && stream && t.video.srcObject !== stream) {
        t.video.srcObject = stream;
        t.video.play().catch(() => { });
    }
    if (stream) t.stream = stream;
    // a screen or the board that appears takes the stage; the other person's camera takes it from your own
    if (fresh && view !== "me-camera" && view !== "them-camera") stage.view = view;
    else if (fresh && view === "them-camera" && (!stage.view || stage.view === "me-camera")) stage.view = view;
    else if (!stage.view || !tiles[stage.view].shown) pickStage();
    renderStage();
}

function hideTile(view) {
    const t = tiles[view];
    t.shown = false;
    t.el.hidden = true;
    if (t.video) t.video.srcObject = null;
    t.stream = null;
    if (stage.view === view) pickStage();
    renderStage();
}

function pickStage() {
    stage.view = STAGE_ORDER.find((v) => tiles[v].shown) || null;
}

function renderStage() {
    const view = stage.view;
    const video = $("stageVideo");
    const isBoard = view === "board";
    $("boardWrap").hidden = !isBoard;
    $("boardTools").hidden = !isBoard;
    video.hidden = !view || isBoard;

    if (view && !isBoard) {
        const s = tiles[view].stream;
        if (video.srcObject !== s) {
            video.srcObject = s;
            video.play().catch(() => { });
        }
    } else if (video.srcObject) {
        video.srcObject = null;
    }
    video.classList.toggle("mirror", view === "me-camera"); // your own camera is shown as a mirror, like a preview

    const cameraOff = (view === "me-camera" && !camState.me) || (view === "them-camera" && !camState.them);
    $("stage").dataset.camera = cameraOff ? "off" : "on";
    $("stageEmpty").hidden = Boolean(view) && !cameraOff;
    $("stageEmpty").querySelector("span").textContent = cameraOff ? "Camera off" : "Waiting for video";
    $("stageCaption").textContent = view ? tiles[view].name.textContent : "";

    for (const v of VIEWS) tiles[v].el.setAttribute("aria-pressed", String(v === view));
    if (isBoard) paintThumb();
}

// The local tiles and the buttons follow what is on the call. rtc.tracks('camera') lists the local tracks of one source.
function refreshLocalTiles() {
    if (!rtc) return;
    const camera = rtc.tracks("camera");
    const screen = rtc.tracks("screen");
    const microphone = rtc.tracks("microphone");

    if (camera.length) showTile("me-camera", streamFor("me-camera", camera));
    else hideTile("me-camera");
    if (screen.length) showTile("me-screen", streamFor("me-screen", screen));
    else hideTile("me-screen");

    micState.me = microphone.some((t) => t.enabled);
    camState.me = camera.some((t) => t.enabled);
    $("btnMic").hidden = !microphone.length;
    $("btnCamera").hidden = !camera.length;
    updateBar();
    renderBadges();
}

// Keeps a tile's MediaStream when it already holds these tracks, so the video does not restart.
function streamFor(view, tracks) {
    const current = tiles[view].stream;
    if (current) {
        const have = current.getTracks();
        if (have.length === tracks.length && tracks.every((t) => have.includes(t))) return current;
    }
    return new MediaStream(tracks);
}

function setPeerName(name) {
    if (peer) peer.name = name;
    tiles["them-camera"].name.textContent = name;
    tiles["them-screen"].name.textContent = `${name}'s screen`;
    if (appState() === "incall") setStatus(`In a call with ${name}`);
    renderStage();
}

// The microphone and camera badges on the tiles, from the local tracks and the other side's state messages.
function renderBadges() {
    const mine = tiles["me-camera"], theirs = tiles["them-camera"];
    mine.el.querySelector(".tile-badge").hidden = micState.me;
    theirs.el.querySelector(".tile-badge").hidden = micState.them;
    mine.el.dataset.camera = camState.me ? "on" : "off";
    theirs.el.dataset.camera = camState.them ? "on" : "off";
    renderStage();
}

/*
    Every video element on the page is muted; the other side's voice plays from one <audio> element whatever
    is on the stage. A browser that refuses to play sound before the visitor touched the page gets a button.
*/
function playRemoteAudio() {
    const audio = $("remoteAudio");
    if (audio.srcObject !== remoteAudioStream) audio.srcObject = remoteAudioStream;
    audio.play().then(() => { $("btnSound").hidden = true; }).catch(() => { $("btnSound").hidden = false; });
}

/* ---------------------------------------------------------------------------------------------------
   Controls
   --------------------------------------------------------------------------------------------------- */

const wideScreen = window.matchMedia("(min-width: 56.01rem)");
const coarsePointer = window.matchMedia("(pointer: coarse)");

$("btnMic").addEventListener("click", () => {
    if (!rtc) return;
    const on = rtc.tracks("microphone").some((t) => t.enabled);
    rtc.mute({ audio: on }); // mute() keeps the track on the call and sends silence while it is paused
    micState.me = !on;
    updateBar();
    renderBadges();
    sendState();
});

$("btnCamera").addEventListener("click", () => {
    if (!rtc) return;
    const on = rtc.tracks("camera").some((t) => t.enabled);
    rtc.mute({ video: on });
    camState.me = !on;
    updateBar();
    renderBadges();
    sendState();
});

// share('screen') asks which window or tab to share and adds it to the call; unshare('screen') takes it off.
$("btnScreen").addEventListener("click", async () => {
    if (!rtc) return;
    if (rtc.tracks("screen").length) {
        rtc.unshare("screen"); // the unshare event refreshes the tiles
        return;
    }
    if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
        // most phone browsers have no screen capture
        showError("This device does not support screen sharing.");
        return;
    }
    try {
        await rtc.share("screen", { contentHint: "text" });
        refreshLocalTiles();
    } catch (err) {
        if (err?.name !== "NotAllowedError") showError(err.message); // the picker was closed without a choice
    }
});

$("btnBoard").addEventListener("click", () => {
    if (!rtc) return;
    if (boardState.open) closeBoard(true);
    else openBoard(true);
});

$("btnChat").addEventListener("click", () => openChat(!chatOpen()));
$("btnChatClose").addEventListener("click", () => openChat(false));
$("btnLeave").addEventListener("click", leaveCall);
$("btnJoin").addEventListener("click", () => {
    const entry = [...peers.entries()].find(([, p]) => p.user_id !== me.user_id);
    if (!entry) return;
    endedWith = null;
    callPeer(entry[0], entry[1]).catch((err) => { showError(err.message); setState("lobby"); });
});
$("btnCancel").addEventListener("click", cancelCall);
$("btnSound").addEventListener("click", playRemoteAudio);

$("btnCopy").addEventListener("click", () => copyLink($("btnCopy")));
$("btnCopyTop").addEventListener("click", () => copyLink());
$("btnShare").addEventListener("click", () => {
    navigator.share({ title: "Video call", text: "Join my video call", url: shareUrl() }).catch(() => { });
});
if (navigator.share) $("btnShare").hidden = false;

$("btnFullscreen").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
    else document.documentElement.requestFullscreen?.().catch(() => { });
});
if (!document.documentElement.requestFullscreen) $("btnFullscreen").hidden = true;

/*
    The name. Typed in the waiting room, or changed during the call in the settings dialog; the other side gets a
    "hello" with the new name each time and shows "<old> is now <new>" in the chat.
*/
$("nameInput").value = me.name === "Guest" ? "" : me.name;
$("nameInput").addEventListener("input", () => setMyName($("nameInput").value, "lobby"));

$("btnSettings").addEventListener("click", () => {
    $("settingsName").value = me.name === "Guest" ? "" : me.name;
    $("settingsDialog").showModal();
    $("settingsName").select();
});
$("settingsForm").addEventListener("submit", () => setMyName($("settingsName").value, "settings")); // method="dialog" closes it
$("btnSettingsClose").addEventListener("click", () => $("settingsDialog").close());

function setMyName(value, from) {
    const name = String(value || "").trim().slice(0, 40) || "Guest";
    me.name = name;
    try { localStorage.setItem("videocall:name", name); } catch (err) { }
    if (from !== "lobby") $("nameInput").value = name === "Guest" ? "" : name;
    sendChat({ t: "hello", name });
}

/* ---- Waiting room choices: microphone and camera on or off before the call ---- */

const prefs = { mic: true, camera: true };

$("btnPreviewMic").addEventListener("click", () => { prefs.mic = !prefs.mic; renderPrefs(); });
$("btnPreviewCamera").addEventListener("click", () => { prefs.camera = !prefs.camera; renderPrefs(); });

function renderPrefs() {
    const mic = $("btnPreviewMic"), cam = $("btnPreviewCamera");
    mic.setAttribute("aria-pressed", String(!prefs.mic));
    mic.title = prefs.mic ? "Turn the microphone off" : "Turn the microphone on";
    mic.setAttribute("aria-label", mic.title);
    cam.setAttribute("aria-pressed", String(!prefs.camera));
    cam.title = prefs.camera ? "Turn the camera off" : "Turn the camera on";
    cam.setAttribute("aria-label", cam.title);
    for (const t of preview.stream?.getAudioTracks() || []) t.enabled = prefs.mic;
    for (const t of preview.stream?.getVideoTracks() || []) t.enabled = prefs.camera;
    renderPreviewFrame();
}

function updateBar() {
    const mic = $("btnMic"), cam = $("btnCamera"), scr = $("btnScreen"), brd = $("btnBoard");
    mic.setAttribute("aria-pressed", String(!micState.me));
    mic.querySelector(".ctl-label").textContent = micState.me ? "Mute" : "Unmute";
    cam.setAttribute("aria-pressed", String(!camState.me));
    cam.querySelector(".ctl-label").textContent = camState.me ? "Stop video" : "Start video";
    const sharing = Boolean(rtc && rtc.tracks("screen").length);
    scr.setAttribute("aria-pressed", String(sharing));
    scr.querySelector(".ctl-label").textContent = sharing ? "Stop sharing" : "Share screen";
    brd.setAttribute("aria-pressed", String(boardState.open));
    brd.querySelector(".ctl-label").textContent = boardState.open ? "Close board" : "Drawing board";
}

/* ---- The camera preview in the waiting room ---- */

const preview = { stream: null, video: false, audio: false, pending: null, error: null };
let previewReady = Promise.resolve();

// Opens the camera and the microphone for the preview, or what the browser allows of them. One opening at a time.
function startPreview() {
    if (!preview.pending) {
        preview.pending = openPreview().finally(() => { preview.pending = null; });
    }
    return preview.pending;
}

async function openPreview() {
    if (preview.stream) return;
    const attempts = [{ video: true, audio: true }, { video: true }, { audio: true }];
    let error = null;
    for (const constraints of attempts) {
        try {
            preview.stream = await navigator.mediaDevices.getUserMedia(constraints);
            break;
        } catch (err) {
            error = err;
            if (err.name === "NotAllowedError" && constraints.audio && !constraints.video) break;
        }
    }
    preview.video = Boolean(preview.stream?.getVideoTracks().length);
    preview.audio = Boolean(preview.stream?.getAudioTracks().length);
    preview.error = preview.stream ? null : error;

    const video = $("previewVideo");
    video.srcObject = preview.video ? preview.stream : null;
    if (preview.video) video.play().catch(() => { });
    renderPrefs();
}

// What the preview frame shows over the video: nothing, "Camera off", or why there is no camera.
function renderPreviewFrame() {
    const off = $("previewOff"), text = $("previewOffText");
    if (!preview.stream) return; // stopped: the frame says "Connecting..."
    if (!preview.video) {
        off.hidden = false;
        text.textContent = preview.error?.name === "NotAllowedError" ? "Camera blocked. Allow it in the address bar to be seen." : "No camera";
        return;
    }
    off.hidden = prefs.camera;
    text.textContent = "Camera off";
}

// The preview goes away when the call opens the camera itself; the frame says what is happening meanwhile.
function stopPreview() {
    if (preview.stream) {
        for (const t of preview.stream.getTracks()) t.stop();
        preview.stream = null;
    }
    $("previewVideo").srcObject = null;
    $("previewOff").hidden = false;
    $("previewOffText").textContent = "Connecting...";
}

/* ---------------------------------------------------------------------------------------------------
   The shared drawing board
   One canvas with a fixed size; positions travel as fractions of it, so both sides draw the same picture
   whatever size the board has on their screen. Messages on the "drawing" channel, as JSON:
     { t: "open" } / { t: "close" }   the board is shown or hidden on both sides
     { t: "seg", a: [x, y], b: [x, y], c: color, w: width, e: eraser }   one piece of a stroke
     { t: "clear" }
   --------------------------------------------------------------------------------------------------- */

const board = $("board");
const bctx = board.getContext("2d");
const thumb = tiles.board.canvas;
const tctx = thumb.getContext("2d");
const pen = { color: "#111827", width: 7, eraser: false };
const boardState = { open: false, drawing: false, last: null };
let thumbPending = false;

function boardPosition(event) {
    const r = board.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (event.clientY - r.top) / r.height)) };
}

function drawSegment(a, b, color, width, eraser) {
    bctx.save();
    bctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
    bctx.strokeStyle = color;
    bctx.lineWidth = eraser ? width * 3 : width;
    bctx.lineCap = "round";
    bctx.lineJoin = "round";
    bctx.beginPath();
    bctx.moveTo(a.x * board.width, a.y * board.height);
    bctx.lineTo(b.x * board.width + (a.x === b.x && a.y === b.y ? 0.01 : 0), b.y * board.height);
    bctx.stroke();
    bctx.restore();
    paintThumb();
}

function sendDraw(message) {
    if (channels.drawing?.readyState === "open") channels.drawing.send(JSON.stringify(message));
}

function round(n) {
    return Math.round(n * 10000) / 10000;
}

board.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    boardState.drawing = true;
    boardState.last = boardPosition(event);
    try { board.setPointerCapture(event.pointerId); } catch (err) { }
    segment(boardState.last, boardState.last);
});

board.addEventListener("pointermove", (event) => {
    if (!boardState.drawing) return;
    const events = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
    for (const ev of events.length ? events : [event]) {
        const point = boardPosition(ev);
        segment(boardState.last, point);
        boardState.last = point;
    }
});

for (const name of ["pointerup", "pointercancel"]) {
    board.addEventListener(name, () => {
        boardState.drawing = false;
        boardState.last = null;
    });
}

function segment(a, b) {
    drawSegment(a, b, pen.color, pen.width, pen.eraser);
    sendDraw({ t: "seg", a: [round(a.x), round(a.y)], b: [round(b.x), round(b.y)], c: pen.color, w: pen.width, e: pen.eraser ? 1 : 0 });
}

function onDrawMessage(data) {
    let m;
    try { m = JSON.parse(data); } catch (err) { return; }
    switch (m.t) {
        case "open": openBoard(false); break;
        case "close": closeBoard(false); break;
        case "clear": clearBoard(false); break;
        case "seg":
            if (Array.isArray(m.a) && Array.isArray(m.b)) {
                drawSegment({ x: +m.a[0], y: +m.a[1] }, { x: +m.b[0], y: +m.b[1] }, String(m.c || "#111827"), Math.min(64, +m.w || 7), Boolean(m.e));
            }
            break;
    }
}

function openBoard(tell) {
    if (!boardState.open) {
        boardState.open = true;
        showTile("board");
        if (tell) addSystemLine("You opened the drawing board.");
        else addSystemLine(`${peer?.name || "Guest"} opened the drawing board.`);
    }
    stage.view = "board";
    renderStage();
    updateBar();
    if (tell) sendDraw({ t: "open" });
}

function closeBoard(tell) {
    if (!boardState.open) return;
    boardState.open = false;
    boardState.drawing = false;
    hideTile("board");
    updateBar();
    if (tell) sendDraw({ t: "close" });
}

function clearBoard(tell) {
    bctx.clearRect(0, 0, board.width, board.height);
    paintThumb();
    if (tell) sendDraw({ t: "clear" });
}

// The thumbnail is a small copy of the board, repainted at most once a frame.
function paintThumb() {
    if (thumbPending) return;
    thumbPending = true;
    requestAnimationFrame(() => {
        thumbPending = false;
        tctx.clearRect(0, 0, thumb.width, thumb.height);
        tctx.drawImage(board, 0, 0, thumb.width, thumb.height);
    });
}

for (const b of document.querySelectorAll(".swatch")) {
    b.addEventListener("click", () => {
        pen.color = b.dataset.color;
        pen.eraser = false;
        $("btnEraser").setAttribute("aria-pressed", "false");
        for (const s of document.querySelectorAll(".swatch")) s.setAttribute("aria-pressed", String(s === b));
    });
}
for (const b of document.querySelectorAll(".size")) {
    b.addEventListener("click", () => {
        pen.width = Number(b.dataset.width);
        for (const s of document.querySelectorAll(".size")) s.setAttribute("aria-pressed", String(s === b));
    });
}
$("btnEraser").addEventListener("click", () => {
    pen.eraser = !pen.eraser;
    $("btnEraser").setAttribute("aria-pressed", String(pen.eraser));
});
$("btnClear").addEventListener("click", () => clearBoard(true));
$("btnBoardClose").addEventListener("click", () => closeBoard(true));

/* ---------------------------------------------------------------------------------------------------
   Chat
   Messages on the "chat" channel, as JSON:
     { t: "hello", name }                 who this is; sent when the channel opens and when the name changes
     { t: "msg", text, ts }               a message, markdown
     { t: "state", mic, camera }          microphone and camera on or off, for the badges on the tiles
   Files go through rtc.sendFile(): the SDK chunks them over a channel of its own and the other side gets
   fileprogress events and then a file event with the File.
   --------------------------------------------------------------------------------------------------- */

const log = $("chatLog");
const input = $("chatInput");
let unread = 0;

function sendChat(message) {
    if (channels.chat?.readyState !== "open") return false;
    channels.chat.send(JSON.stringify(message));
    return true;
}

function sendState() {
    sendChat({ t: "state", mic: micState.me, camera: camState.me });
}

function onChatMessage(data) {
    let m;
    try { m = JSON.parse(data); } catch (err) { return; }
    switch (m.t) {
        case "hello": {
            const name = String(m.name || "").trim().slice(0, 40) || "Guest";
            const before = peer?.name;
            setPeerName(name);
            if (peer && peers.has(peer.cid)) peers.get(peer.cid).name = name; // the waiting room uses it after the call
            if (!announced) { announced = true; addSystemLine(`${name} joined the call.`); }
            else if (before !== name) addSystemLine(`${before} is now ${name}.`);
            break;
        }
        case "msg":
            addMessage({ mine: false, name: peer?.name || "Guest", text: String(m.text ?? ""), ts: Number(m.ts) || Date.now() });
            break;
        case "state":
            micState.them = m.mic !== false;
            camState.them = m.camera !== false;
            renderBadges();
            break;
    }
}

function chatOpen() {
    return $("call").classList.contains("chat-open");
}

function openChat(open, silent) {
    $("call").classList.toggle("chat-open", open);
    $("btnChat").setAttribute("aria-pressed", String(open));
    if (open) {
        unread = 0;
        $("unread").hidden = true;
        autosize();
        scrollToEnd();
        if (!silent && !coarsePointer.matches) input.focus();
    }
}

/*
    The width of the chat on a wide screen. The handle on the panel's left edge drags it, the arrow keys move it when
    the handle has the focus, a double-click puts it back, and the width is remembered on this device.
*/
const CHAT_WIDTH_KEY = "videocall:chatWidth";
let chatWidth = 0;
try { chatWidth = Number(localStorage.getItem(CHAT_WIDTH_KEY)) || 0; } catch (err) { }

function remPx() {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

// Keeps the chat readable and leaves the stage room: between 16rem and the call's width less 20rem.
function setChatWidth(px, save) {
    const call = $("call");
    const rem = remPx();
    const min = 16 * rem;
    const max = Math.max(min, call.clientWidth - 20 * rem);
    chatWidth = Math.round(Math.min(max, Math.max(min, px)));
    call.style.setProperty("--chat-width", chatWidth + "px");
    if (save) {
        try { localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidth)); } catch (err) { }
    }
}

function resetChatWidth() {
    chatWidth = 0;
    $("call").style.removeProperty("--chat-width");
    try { localStorage.removeItem(CHAT_WIDTH_KEY); } catch (err) { }
}

$("chatResizer").addEventListener("pointerdown", (event) => {
    if (!wideScreen.matches) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const right = $("call").getBoundingClientRect().right;
    const move = (ev) => setChatWidth(right - ev.clientX, false);
    const stop = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
        document.body.classList.remove("resizing");
        if (chatWidth) setChatWidth(chatWidth, true);
        autosize();
    };
    try { handle.setPointerCapture(event.pointerId); } catch (err) { }
    document.body.classList.add("resizing");
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
});

$("chatResizer").addEventListener("dblclick", resetChatWidth);

$("chatResizer").addEventListener("keydown", (event) => {
    const current = chatWidth || $("chat").getBoundingClientRect().width;
    if (event.key === "ArrowLeft") setChatWidth(current + 16, true);
    else if (event.key === "ArrowRight") setChatWidth(current - 16, true);
    else if (event.key === "Home") resetChatWidth();
    else return;
    event.preventDefault();
});

// On a phone the chat covers the call; leaving the call takes it away.
function exitChatOverlay() {
    if (!wideScreen.matches) openChat(false, true);
}

function clearLog() {
    log.replaceChildren();
    unread = 0;
    $("unread").hidden = true;
}

function nearEnd() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 48;
}

function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
}

function timeOf(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// A message in the log: who and when, then the text rendered from markdown.
function addMessage({ mine, name, text, ts }) {
    const stick = mine || nearEnd();
    const row = document.createElement("div");
    row.className = "msg " + (mine ? "me" : "them");
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const who = document.createElement("span");
    who.className = "msg-who";
    who.textContent = name;
    const time = document.createElement("time");
    time.dateTime = new Date(ts).toISOString();
    time.textContent = timeOf(ts);
    meta.append(who, time);
    const body = document.createElement("div");
    body.className = "msg-body md";
    body.innerHTML = renderMarkdown(text); // renderMarkdown escapes everything that is not its own markup
    enhanceCodeBlocks(body);
    row.append(meta, body);
    log.appendChild(row);
    if (stick) scrollToEnd();
    if (!mine && !chatOpen()) {
        unread++;
        $("unread").textContent = String(unread);
        $("unread").hidden = false;
    }
    return row;
}

function addSystemLine(text) {
    const row = document.createElement("div");
    row.className = "msg system";
    row.textContent = text;
    const stick = nearEnd();
    log.appendChild(row);
    if (stick) scrollToEnd();
}

// Every code block gets a Copy button, and colours when it names its language (```js, ```python ...).
function enhanceCodeBlocks(container) {
    for (const pre of container.querySelectorAll("pre")) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "copy-code";
        button.textContent = "Copy";
        button.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(pre.querySelector("code").textContent);
                button.textContent = "Copied";
                setTimeout(() => { button.textContent = "Copy"; }, 1200);
            } catch (err) {
                button.textContent = "Select and copy";
            }
        });
        pre.appendChild(button);
        if (pre.dataset.lang) highlightCode(pre.querySelector("code"), pre.dataset.lang).catch((err) => console.warn("highlight:", err.message));
    }
}

/*
    Syntax colours come from highlight.js, loaded from the CDN the first time a code block names a language.
    The common languages come with the main file; another one is fetched on its own when the block asks for it.
*/
const HLJS_BASE = "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/";
let hljsLoading = null;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error("could not load " + src));
        document.head.appendChild(s);
    });
}

function loadHighlighter() {
    if (!hljsLoading) {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = HLJS_BASE + "styles/github-dark.min.css";
        document.head.appendChild(css);
        hljsLoading = loadScript(HLJS_BASE + "highlight.min.js");
    }
    return hljsLoading;
}

async function highlightCode(code, lang) {
    await loadHighlighter();
    if (!window.hljs) return;
    if (!hljs.getLanguage(lang)) {
        try { await loadScript(`${HLJS_BASE}languages/${encodeURIComponent(lang)}.min.js`); } catch (err) { return; } // not a language highlight.js knows
        if (!hljs.getLanguage(lang)) return;
    }
    code.className = "language-" + lang;
    hljs.highlightElement(code);
}

/* ---- The composer: a text area that grows, indents with Tab and sends with Enter ---- */

// The box takes the height of its text, up to its max-height; only then does it scroll.
function autosize() {
    if (!input.getClientRects().length) return; // not shown: nothing to measure
    const style = getComputedStyle(input);
    const max = parseFloat(style.maxHeight) || Infinity;
    const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    input.style.height = "auto";
    const needed = input.scrollHeight + border;
    input.style.height = Math.min(needed, max) + "px";
    input.style.overflowY = needed > max ? "auto" : "hidden";
}

input.addEventListener("input", autosize);
window.addEventListener("resize", autosize);

// Tab puts a tab in front of the caret, or in front of every selected line; Shift+Tab takes one away.
function indent(outdent) {
    const { selectionStart: s, selectionEnd: e, value } = input;
    if (!outdent && s === e) {
        input.setRangeText("\t", s, e, "end");
        autosize();
        return;
    }
    const start = value.lastIndexOf("\n", s - 1) + 1;
    let end = value.indexOf("\n", e === s ? e : e - 1);
    if (end === -1) end = value.length;
    const lines = value.slice(start, end).split("\n");
    const changed = lines.map((l) => outdent ? l.replace(/^(\t| {1,4})/, "") : "\t" + l).join("\n");
    input.setRangeText(changed, start, end, "select");
    autosize();
}

// Shift+Enter starts a new line that keeps the indentation of the line it leaves, the way a code editor does.
function newLine() {
    const { selectionStart: s, selectionEnd: e, value } = input;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const indentation = /^[ \t]*/.exec(value.slice(lineStart, s))[0]; // the leading tabs and spaces before the caret
    const text = "\n" + indentation;
    // execCommand keeps the browser's undo history; setRangeText is the fallback
    let done = false;
    try { done = document.execCommand("insertText", false, text); } catch (err) { }
    if (!done) input.setRangeText(text, s, e, "end");
    autosize();
}

input.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
        event.preventDefault();
        indent(event.shiftKey);
        return;
    }
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return; // a phone keyboard still composing a word
    event.preventDefault();
    if (event.shiftKey) newLine();
    else submitChat();
});

$("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    submitChat();
});

function submitChat() {
    const text = input.value.replace(/\s+$/, "");
    if (!text.trim()) return;
    if (!sendChat({ t: "msg", text, ts: Date.now() })) {
        showError("The chat is not connected yet.");
        return;
    }
    addMessage({ mine: true, name: me.name, text, ts: Date.now() });
    input.value = "";
    setTimeout(() => { input.value = ""; }, 0); // a word a phone keyboard is still composing could come back
    autosize();
    if (coarsePointer.matches) input.blur();
}

/* ---- Files ---- */

$("btnFile").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", () => {
    const file = $("fileInput").files[0];
    $("fileInput").value = "";
    if (file) sendFile(file);
});

function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function fileRow(mine, name, size) {
    const row = addMessage({ mine, name: mine ? me.name : (peer?.name || "Guest"), text: "", ts: Date.now() });
    const body = row.querySelector(".msg-body");
    body.classList.remove("md");
    body.classList.add("msg-file");
    const title = document.createElement("div");
    title.innerHTML = `<svg class="icon"><use href="#i-attach"/></svg> `;
    title.append(name, " ");
    const sizeText = document.createElement("span");
    sizeText.className = "file-size";
    sizeText.textContent = formatSize(size);
    title.append(sizeText);
    const progress = document.createElement("progress");
    progress.max = size || 1;
    progress.value = 0;
    body.append(title, progress);
    return { row, body, progress };
}

async function sendFile(file) {
    if (!rtc) return;
    const { body, progress } = fileRow(true, file.name, file.size);
    try {
        await rtc.sendFile(file, { onProgress: (sent) => { progress.value = sent; } });
        progress.remove();
        const done = document.createElement("span");
        done.className = "file-size";
        done.textContent = "Sent";
        body.append(done);
    } catch (err) {
        progress.remove();
        const failed = document.createElement("span");
        failed.className = "file-size";
        failed.textContent = "Failed: " + err.message;
        body.append(failed);
    }
}

const incomingFiles = new Map(); // file id -> { body, progress }

function fileProgress(e) {
    let entry = incomingFiles.get(e.id);
    if (!entry) {
        entry = fileRow(false, e.name, e.size);
        incomingFiles.set(e.id, entry);
    }
    entry.progress.value = e.received;
}

function fileReceived(e) {
    let entry = incomingFiles.get(e.id);
    if (!entry) entry = fileRow(false, e.name, e.size);
    incomingFiles.delete(e.id);
    entry.progress.remove();
    const stick = nearEnd(); // decided before the row grows
    const url = URL.createObjectURL(e.file);
    if (/^image\//.test(e.mime)) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = e.name;
        img.addEventListener("load", () => { if (stick) scrollToEnd(); }); // the picture gets its height only once it has loaded
        entry.body.append(img);
    }
    const link = document.createElement("a");
    link.href = url;
    link.download = e.name;
    link.innerHTML = `<svg class="icon"><use href="#i-download"/></svg> Download`;
    entry.body.append(link);
    if (stick) scrollToEnd();
}

/* ---------------------------------------------------------------------------------------------------
   Helpers
   --------------------------------------------------------------------------------------------------- */

function appState() {
    return $("app").dataset.state;
}

function setState(state) {
    $("app").dataset.state = state;
    const inCall = state === "incall";
    $("lobby").hidden = inCall;
    $("call").hidden = !inCall;
    $("bar").hidden = !inCall;
    if (inCall) {
        if (chatWidth) setChatWidth(chatWidth, false); // the width chosen last time, within what this window allows
        autosize();
    }
}

function setStatus(text) {
    $("statusText").textContent = text;
}

// The line under the waiting-room card. `busy` shows a turning ring in front of it while something is in progress.
function setLobbyStatus(text, alert, busy) {
    const el = $("lobbyStatus");
    el.textContent = lobbyNote ? `${lobbyNote} ${text}` : text;
    el.classList.toggle("alert", Boolean(alert));
    el.classList.toggle("busy", Boolean(busy));
}

function loadName() {
    try { return localStorage.getItem("videocall:name") || "Guest"; } catch (err) { return "Guest"; }
}

function randomId() {
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function copyLink(button) {
    const url = shareUrl();
    try {
        await navigator.clipboard.writeText(url);
    } catch (err) {
        const field = $("shareInput");
        field.select();
        document.execCommand("copy");
    }
    if (button) {
        const label = button.querySelector("span");
        const text = label.textContent;
        label.textContent = "Copied";
        setTimeout(() => { label.textContent = text; }, 1500);
    } else {
        showToast("Link copied");
    }
}

function showToast(text, { error = false, detail = "", sticky = false } = {}) {
    const box = document.createElement("div");
    box.className = "toast" + (error ? " error" : "");
    const body = document.createElement("div");
    body.style.flex = "1";
    const p = document.createElement("p");
    p.textContent = text;
    body.appendChild(p);
    if (detail) {
        const d = document.createElement("p");
        d.textContent = detail;
        body.appendChild(d);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "icon-btn";
    close.setAttribute("aria-label", "Dismiss");
    close.innerHTML = `<svg class="icon"><use href="#i-close"/></svg>`;
    close.addEventListener("click", () => box.remove());
    box.append(body, close);
    $("toasts").appendChild(box);
    if (!sticky) setTimeout(() => box.remove(), error ? 8000 : 4000);
}

function showError(message) {
    console.error(message);
    showToast(message, { error: true });
}

/* ---------------------------------------------------------------------------------------------------
   Start
   --------------------------------------------------------------------------------------------------- */

$("shareInput").value = shareUrl();

// Who else is in the room, from the realtime group's list. Returns how many others there are.
async function listRoom() {
    const res = await skapi.getRealtimeUsers({ group: GROUP });
    peers.clear();
    for (const p of res.list) {
        if (p.user_id !== me.user_id) peers.set(p.cid, { user_id: p.user_id, name: null });
    }
    return peers.size;
}

// The guest's Enter button: join the room's group, which makes this visitor visible, and connect.
async function enterRoom() {
    if (entered) return;
    entered = true;
    $("btnEnter").hidden = true;
    setLobbyStatus("Entering...", false, true);
    try {
        await skapi.joinRealtime({ group: GROUP });
        try { sessionStorage.setItem("videocall:entered", room); } catch (err) { }
        await listRoom();
        reconcile();
    } catch (err) {
        entered = false;
        $("btnEnter").hidden = false;
        showError(err.message);
    }
}

$("btnEnter").addEventListener("click", () => { enterRoom(); });

async function main() {
    try {
        // The camera does not depend on the account: it opens right away, while the sign-in runs.
        // Signing in takes a moment, longer when a temporary account from an earlier visit has expired and the
        // SDK has to give it up and make a new one; the waiting room says so meanwhile.
        previewReady = startPreview();
        setLobbyStatus("Connecting to the service...", false, true);
        const user = await signIn();
        me.user_id = user.user_id;
        setState("lobby");
        setStatus("Connecting...");

        await skapi.connectRealtime(onRealtime);
        if (entered) {
            await skapi.joinRealtime({ group: GROUP });
            await listRoom();
            reconcile();
        } else {
            // a guest looks in first and enters when ready
            const others = await listRoom();
            peers.clear(); // not in the group yet, so no notices: the list is read again on entering
            setLobbyStatus(others === 0 ? "Nobody else is here yet. Enter and wait for them." : others === 1 ? "Someone is waiting for you. Enter when you are ready." : "Two people are already in this call.");
            setStatus("Ready to enter");
            $("btnEnter").hidden = false;
        }
    } catch (err) {
        console.error(err);
        setStatus("Could not start");
        setLobbyStatus("Could not connect to the service. Reload the page to try again.", true);
        if (/anonymous login is not enabled/i.test(err?.message || "")) {
            showToast("Anonymous login is turned off for this project.", {
                error: true, sticky: true,
                detail: "Turn on Anonymous Login in the project's settings at www.skapi.com, then reload this page.",
            });
        } else {
            showToast(err?.message || String(err), { error: true, sticky: true });
        }
    }
}

main();
