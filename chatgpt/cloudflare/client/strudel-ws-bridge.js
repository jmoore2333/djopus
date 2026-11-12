/*
 * DJ Opus browser bridge.
 *
 * A classic script that the Strudel REPL page loads. It connects to the session's Durable Object over
 * /ws as the "browser" role, runs the agent's commands against window.strudelMirror, and reports back.
 * It also tells the session what the user plays by hand (a code_update), so that the session's code is what
 * is playing and not what the agent last sent.
 * The session is the one in the page's address, /s/<id>: a page opened anywhere else makes an id of its own
 * and puts it there.
 *
 * It has two layers:
 *   - createBridge(deps) is the connection, the commands and the session sync. It reads no globals:
 *     everything it needs comes in through deps, so test/unit/bridge.test.ts drives it in plain Node
 *     with a fake WebSocket and fake timers.
 *   - boot() is the browser-only wiring: DOM events, the status pill and the audio prompt.
 *     It holds no logic worth testing: what the pill says (pillState) and where its links go (SOURCE_LINKS)
 *     are decided in the core.
 *
 * Loaded under CommonJS (the unit tests do that, see client/package.json), the file exports the core
 * and does not boot.
 */
(function() {
  'use strict';

  var PING_INTERVAL = 25000;       // an open socket is pinged this often
  var PONG_TIMEOUT = 10000;        // a ping unanswered for this long means the socket is dead
  var STATUS_INTERVAL = 5000;      // how often the status is checked. A report goes out only when it changed
  var RESTORE_DELAY = 1500;        // the first session_state waits this long to win the race against Strudel's own restore
  var MAX_RECONNECT_DELAY = 30000;
  var CONNECT_TIMEOUT = 10000;     // a socket still connecting after this long is closed and tried again
  var RESTORE_GUARD_MS = 10000;    // how long after the editor first appears the page's own setCode calls are ignored
  var MAX_CODE_BYTES = 65536;      // the server refuses code over this many UTF-8 bytes and keeps what it had
  var WS_CONNECTING = 0;           // WebSocket readyState values, which the standard fixes
  var WS_OPEN = 1;

  // Where Strudel keeps what it restores on the next load. Its settings are a nanostores persistentMap under
  // the 'strudel-settings' prefix, so the last code lives at 'strudel-settings' + 'latestCode'. The other two
  // are sessionStorage atoms.
  var LOCAL_KEYS = {
    local: ['strudel-settingslatestCode'],
    session: ['viewingPatternData', 'activePattern']
  };

  // The commands an agent sends the page by way of the session. session_state is not one of them: the server sends
  // that to every page that connects, whether or not an agent has come.
  var AGENT_COMMANDS = [
    'evaluate', 'stop', 'set_code', 'set_tempo', 'get_code', 'append_code', 'replace_code', 'add_effect',
    'recover_audio', 'reset_session'
  ];

  // What the status pill shows: the connection's status, except that an open connection that no agent has used yet is
  // 'waiting'. The page is there, and the agent has not found it. The first command that reaches the page ends that for
  // as long as the page lives, and then the pill says what the connection is doing.
  function pillState(status, agentSeen) {
    return status === 'connected' && !agentSeen ? 'waiting' : status;
  }

  // The links of the AGPL source offer, in the order the pill shows them. The player serves a patched build of Strudel,
  // which is AGPL-3.0: the first link is the source of this app and its patches, and the second is the Strudel commit
  // the build is pinned to.
  var SOURCE_LINKS = [
    { label: 'Source', href: 'https://github.com/jmoore2333/djopus', title: 'The source code of DJ Opus' },
    {
      label: 'Strudel',
      href: 'https://codeberg.org/uzu/strudel/src/commit/9f19e4616a358ad31032e0f9af82060d23bc0d70',
      title: 'The Strudel source this player is built from'
    }
  ];

  // Doubles from 1 s up to 30 s, then spread over the upper half of that so many tabs do not retry together.
  function nextReconnectDelay(attempt, random) {
    return Math.min(MAX_RECONNECT_DELAY, 1000 * Math.pow(2, attempt)) * (0.5 + 0.5 * random());
  }

  // A session id is 16 random bytes written as 26 characters of Crockford's base32 in lowercase (the digits and
  // the letters without i, l, o and u). src/core/session-id.ts makes and checks ids the same way: this file is a
  // classic script and cannot import it, so the alphabet and the pattern are repeated here, and
  // test/unit/bridge-session.test.ts holds the two together.
  var SESSION_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
  var SESSION_ID_BYTES = 16;
  var SESSION_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/;

  // A new session id from the platform's random numbers (crypto.getRandomValues, which comes in as
  // getRandomValues): the 128 bits in order, most significant first, five to a character, and the 3 bits that
  // are left over followed by two bits of zero. The id is the only thing that lets a visitor into a session, so
  // there is nothing to fall back on if there is no secure random source.
  function mintSessionId(getRandomValues) {
    if (typeof getRandomValues !== 'function') throw new Error('no secure random source to make a session id from');
    var bytes = new Uint8Array(SESSION_ID_BYTES);
    getRandomValues(bytes);
    var id = '';
    var buffer = 0;   // the bits not written out yet: at most 4 between two bytes
    var bits = 0;
    for (var i = 0; i < bytes.length; i++) {
      buffer = (buffer << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        id += SESSION_ID_ALPHABET.charAt((buffer >> bits) & 31);
      }
      buffer &= (1 << bits) - 1;
    }
    if (bits > 0) id += SESSION_ID_ALPHABET.charAt((buffer << (5 - bits)) & 31);
    return id;
  }

  // Which session a page is. DJOPUS_CONFIG.sessionId, which the ChatGPT widget sets, wins. Otherwise the player
  // URL /s/<id> names it. A page at / or at /s/ with anything but an id is a new session: mint() makes the id, and
  // rewriteTo is the path to put in the address bar so that a reload keeps it. ?session= is not read.
  function resolveSessionId(location, config, mint) {
    if (config && typeof config.sessionId === 'string' && config.sessionId !== '') {
      return { id: config.sessionId, rewriteTo: null };
    }
    var onPath = /^\/s\/([^\/]+)\/?$/.exec(location.pathname);
    if (onPath && SESSION_ID_PATTERN.test(onPath[1])) return { id: onPath[1], rewriteTo: null };
    var id = mint();
    return { id: id, rewriteTo: '/s/' + id };
  }

  function createBridge(deps) {
    var timers = deps.timers;
    var config = deps.getConfig() || {};
    var resolved = resolveSessionId(deps.location, config, function() {
      return mintSessionId(deps.getRandomValues);
    });
    var sessionId = resolved.id;
    if (resolved.rewriteTo !== null) putInAddressBar(resolved.rewriteTo);

    var ws = null;                   // the current socket. Events from any other socket are stale and ignored
    var attempt = 0;                 // failed attempts since the last open
    var reconnectTimer = null;       // set while a reconnect is pending
    var offline = false;             // the browser said it has no network
    var pingTimer = null;
    var pongTimer = null;            // set while a ping is unanswered
    var statusTimer = null;
    var lastStatusKey = null;        // what the last status_report said
    var sawFirstState = false;
    var lastAppliedRev = null;       // null until a session_state with a rev has been taken in
    var syncedCode = null;           // the code the editor and the server last had in common: what a reconnect's state is compared with
    var agreedCode = null;           // the code the server is known to hold, null when that is not known: what a play by hand is compared with
    var restoreTimer = null;         // the first session_state, waiting to be applied
    var restoreApply = null;         // what that restore does, so an edit can run it early
    var restoreForNewSession = false; // the waiting first state is of a new session, whose editor was emptied at once
    var connectTimer = null;         // set while a socket is still connecting
    var guard = null;                // the restore guard, while it is installed
    var guardInstalled = false;      // it is installed once, on the first editor the bridge sees
    var restoreWindowOver = false;   // the guard's window has ended: a wrapper that somebody still holds lets every call through
    var pendingEval = null;
    var pendingEvalClearTimer = null;
    var agentSeen = false;           // a command of an agent has reached the page
    var evaluationsWatched = false;  // the editor's evaluate is wrapped. That is done once
    var bridgeEvaluations = 0;       // the evaluations the bridge itself is starting right now: those are not the user's
    var editorWrites = 0;            // how often the bridge has written the editor: a call that spans a write ran on older text

    var bridge = {
      sessionId: sessionId,
      playerUrl: playerUrl,
      status: 'connecting',
      pill: 'connecting',
      connect: connect,
      onVisible: onVisible,
      onOnline: onOnline,
      onOffline: onOffline,
      reportPendingEvalError: reportPendingEvalError,
      resumeAudio: function() { return resumeAudioContext(currentMirror()); },
      unlockAudio: unlockAudio
    };
    return bridge;

    // --- Connection ---

    function setStatus(next) {
      if (bridge.status === next) return;
      bridge.status = next;
      notify(deps.onStatus, next, 'status');
      updatePill();
    }

    // What the pill shows follows the connection, and the first command of an agent. The page is told when that changes.
    function updatePill() {
      var next = pillState(bridge.status, agentSeen);
      if (bridge.pill === next) return;
      bridge.pill = next;
      notify(deps.onPill, next, 'pill');
    }

    // A handler is the page's, and the bridge goes on when it fails. A page without the handler does not want it.
    function notify(handler, value, name) {
      if (typeof handler !== 'function') return;
      try {
        handler(value);
      } catch (err) {
        console.error('[strudel-ws] ' + name + ' handler failed:', err);
      }
    }

    // An agent has sent the page a command. From here on the pill says how the connection is.
    function noteAgent() {
      if (agentSeen) return;
      agentSeen = true;
      updatePill();
    }

    // The session goes into the address bar, so that a reload comes back to it. A page that may not rewrite its
    // own address (a sandboxed frame) still has its session until the next load makes it a new one.
    function putInAddressBar(path) {
      try {
        deps.replaceUrl(path);
      } catch (err) {
        console.warn('[strudel-ws] could not put the session in the address bar:', err);
      }
    }

    // The link to this session's player, which the status pill copies and an agent opens or connects to.
    function playerUrl() {
      return deps.location.origin + '/s/' + encodeURIComponent(sessionId);
    }

    function socketUrl() {
      // The id in the query and nothing else: the app's /ws takes browsers only, and a socket that names no role
      // is a browser. (Query strings are redacted from the logs, and paths are not.)
      var query = '?session=' + encodeURIComponent(sessionId);
      // In widget mode (the ChatGPT iframe) the page may have no host of its own, so the config's wsUrl wins.
      if (config.wsUrl) return config.wsUrl + query;
      var protocol = deps.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return protocol + '//' + deps.location.host + '/ws' + query;
    }

    function connect() {
      currentMirror(); // the first look at the editor starts the restore guard
      if (reconnectTimer !== null) {
        timers.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws && (ws.readyState === WS_CONNECTING || ws.readyState === WS_OPEN)) return;

      var sock;
      try {
        sock = new deps.WebSocketImpl(socketUrl());
      } catch (err) {
        // Reconnecting never stops, not even for a socket that cannot be built.
        console.error('[strudel-ws] could not open a socket:', err);
        setStatus(offline ? 'offline' : 'reconnecting');
        scheduleReconnect();
        return;
      }
      ws = sock;
      // connect() leaves a connecting socket alone, so one that never opens would block every later attempt.
      connectTimer = timers.setTimeout(function() {
        connectTimer = null;
        if (sock === ws && sock.readyState === WS_CONNECTING) {
          dropSocket(sock, 'no connection after ' + CONNECT_TIMEOUT / 1000 + ' s');
        }
      }, CONNECT_TIMEOUT);

      sock.addEventListener('open', function() {
        if (sock === ws) onOpen(sock);
      });
      sock.addEventListener('message', function(event) {
        if (sock === ws) onMessage(event);
      });
      sock.addEventListener('close', function() {
        onClose(sock);
      });
      sock.addEventListener('error', function(err) {
        if (sock === ws) console.warn('[strudel-ws] socket error:', err);
      });
    }

    function clearConnectTimer() {
      if (connectTimer !== null) {
        timers.clearTimeout(connectTimer);
        connectTimer = null;
      }
    }

    function onOpen(sock) {
      clearConnectTimer();
      console.log('[strudel-ws] connected to session:', sessionId);
      attempt = 0;
      offline = false; // a connection that opened proves there is a network
      setStatus('connected');
      startHeartbeat(sock);
      startStatusReporting();
    }

    function onClose(sock) {
      if (sock !== ws) return; // a socket that was already replaced or given up on
      ws = null;
      clearConnectTimer();
      stopHeartbeat();
      stopStatusReporting();
      console.log('[strudel-ws] disconnected');
      setStatus(offline ? 'offline' : 'reconnecting');
      scheduleReconnect();
    }

    function scheduleReconnect() {
      if (reconnectTimer !== null) return;
      var delay = nextReconnectDelay(attempt, deps.random);
      attempt++;
      reconnectTimer = timers.setTimeout(function() {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    // A hidden tab runs its timers about once a minute, so waiting out the backoff would leave the page
    // disconnected well after the user is back. If a reconnect is pending, both of these make it now. If the
    // socket looks open, they probe it: a socket that died while the machine slept or changed networks can
    // look open for a long time.
    function onVisible() {
      if (reconnectTimer !== null) connect();
      else probe();
    }

    function onOnline() {
      offline = false;
      if (reconnectTimer !== null) connect();
      else probe();
      if (bridge.status === 'offline') {
        setStatus(ws && ws.readyState === WS_OPEN ? 'connected' : 'reconnecting');
      }
    }

    function onOffline() {
      offline = true;
      setStatus('offline');
    }

    function send(msg) {
      if (!ws || ws.readyState !== WS_OPEN) return false;
      try {
        ws.send(JSON.stringify(msg));
        return true;
      } catch (err) {
        console.warn('[strudel-ws] send failed:', err);
        return false;
      }
    }

    // --- Liveness ---

    // A socket can die without a close event (a sleeping laptop, a dropped Wi-Fi). The server answers the
    // text frame 'ping' with 'pong' even while it is hibernated, so a missing pong means the socket is dead.
    function startHeartbeat(sock) {
      stopHeartbeat();
      pingTimer = timers.setInterval(function() {
        sendPing(sock);
      }, PING_INTERVAL);
    }

    // Sends a ping and starts the clock on its pong, unless an earlier ping is still waiting for one.
    function sendPing(sock) {
      if (sock !== ws || sock.readyState !== WS_OPEN) return;
      try {
        sock.send('ping');
      } catch (err) {
        return;
      }
      if (pongTimer === null) {
        pongTimer = timers.setTimeout(function() {
          pongTimer = null;
          dropSocket(sock, 'no pong');
        }, PONG_TIMEOUT);
      }
    }

    // Finds out within PONG_TIMEOUT whether the current socket still works, not at the next ping.
    function probe() {
      if (ws) sendPing(ws);
    }

    function stopHeartbeat() {
      if (pingTimer !== null) {
        timers.clearInterval(pingTimer);
        pingTimer = null;
      }
      if (pongTimer !== null) {
        timers.clearTimeout(pongTimer);
        pongTimer = null;
      }
    }

    function onPong() {
      if (pongTimer !== null) {
        timers.clearTimeout(pongTimer);
        pongTimer = null;
      }
    }

    // Closes a socket that did not answer (or did not connect). A dead connection may never deliver its close
    // event, so the close is handled here instead of waiting for it. If the event does come, onClose ignores it.
    function dropSocket(sock, reason) {
      console.warn('[strudel-ws] ' + reason + ', reconnecting');
      try {
        sock.close();
      } catch (err) {
        // already closed
      }
      onClose(sock);
    }

    // --- Status reports ---

    // One report right after open, then one only when something in it changed. Sending every 5 s would
    // wake the Durable Object every 5 s for every open tab and keep idle sessions from hibernating.
    function startStatusReporting() {
      stopStatusReporting();
      lastStatusKey = null;
      reportStatus();
      statusTimer = timers.setInterval(reportStatus, STATUS_INTERVAL);
    }

    function stopStatusReporting() {
      if (statusTimer !== null) {
        timers.clearInterval(statusTimer);
        statusTimer = null;
      }
    }

    function reportStatus() {
      var sm = currentMirror();
      if (!sm) return;

      var bpm = null;
      try {
        if (sm.repl && sm.repl.scheduler && sm.repl.scheduler.cps) {
          bpm = Math.round(sm.repl.scheduler.cps * 60 * 4);
        }
      } catch (e) {}
      var isPlaying = !!(sm.repl && sm.repl.scheduler && sm.repl.scheduler.started);
      var codeLength = (sm.code || '').length;

      var key = isPlaying + '|' + codeLength + '|' + bpm;
      if (key === lastStatusKey) return;
      var sent = send({
        type: 'status_report',
        payload: {
          isPlaying: isPlaying,
          codeLength: codeLength,
          hasErrors: false,
          bpm: bpm,
          errorMessage: null
        }
      });
      if (sent) lastStatusKey = key;
    }

    // --- Incoming frames ---

    function onMessage(event) {
      var data = event && event.data;
      if (typeof data !== 'string') return;
      if (data === 'pong') {
        onPong();
        return;
      }

      var msg;
      try {
        msg = JSON.parse(data);
      } catch (err) {
        return; // not JSON, so not ours
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

      try {
        handleCommand(msg);
      } catch (err) {
        console.error('[strudel-ws] command failed:', err);
      }
    }

    function handleCommand(msg) {
      if (AGENT_COMMANDS.indexOf(msg.type) !== -1) noteAgent(); // it reached the page, whether or not the editor can run it
      var sm = currentMirror();
      if (!sm) {
        console.warn('[strudel-ws] strudelMirror not ready');
        return;
      }

      switch (msg.type) {
        case 'evaluate':
          evaluate(msg, sm);
          break;

        case 'stop':
          // The ack is what the agent's stop waits for, so it follows the stop and says nothing the page did not do.
          try {
            if (sm.stop) sm.stop();
            clearAudioUnlockPrompt();
            send({ type: 'ack', request_id: msg.request_id, status: 'stopped' });
          } catch (err) {
            send({ type: 'error', request_id: msg.request_id, payload: { message: err.message } });
          }
          break;

        case 'set_code':
          try {
            if (!sm.setCode) {
              throw new Error('Strudel editor is not ready yet.');
            }
            writeEditor(sm, msg.payload.code);
            markAgreed(msg.payload.code);
            send({
              type: 'ack',
              request_id: msg.request_id,
              status: 'code_set',
              payload: { codeLength: (msg.payload.code || '').length }
            });
          } catch (err) {
            send({ type: 'error', request_id: msg.request_id, payload: { message: err.message, code: msg.payload.code } });
          }
          break;

        case 'set_tempo':
          try {
            var bpm = msg.payload.bpm;
            var cps = bpm / 60 / 4;
            // Evaluate setcps without changing editor content
            if (sm.repl && sm.repl.evaluate) {
              sm.repl.evaluate('setcps(' + cps + ')', false);
            } else {
              throw new Error('Strudel tempo controls are not ready yet.');
            }
            send({ type: 'ack', request_id: msg.request_id, status: 'tempo_set', payload: { bpm: bpm } });
          } catch (err) {
            send({ type: 'error', request_id: msg.request_id, payload: { message: err.message } });
          }
          break;

        case 'get_code':
          // If the first state is still waiting, the editor holds Strudel's own restore, not the session's code.
          flushRestore();
          var shown = sm.code || '';
          // The server takes this answer as its pattern only if it is still waiting for it: not the answer of a second
          // tab, or one that a newer command has passed. The page cannot tell which, so what the server holds is not
          // known any more (markTold).
          markTold(shown);
          send({
            type: 'code_response',
            request_id: msg.request_id,
            payload: { code: shown }
          });
          break;

        case 'append_code':
          editCode(msg, sm, 'appended', function(code) {
            return { code: code + '\n' + msg.payload.code };
          });
          break;

        case 'replace_code':
          editCode(msg, sm, 'replaced', function(code) {
            var updated = code.split(msg.payload.search).join(msg.payload.replace);
            return { code: updated, payload: { changed: code !== updated } };
          });
          break;

        case 'add_effect':
          editCode(msg, sm, 'effect_added', function(code) {
            var effectStr = '.' + msg.payload.effect + '(';
            if (msg.payload.params) {
              effectStr += Object.values(msg.payload.params).join(', ');
            }
            effectStr += ')';
            return { code: code + effectStr };
          });
          break;

        case 'session_state':
          applySessionState(sm, msg.payload);
          break;

        case 'recover_audio':
          flushRestore(); // it plays what the editor holds
          recoverAudio(sm, msg.request_id);
          break;

        case 'reset_session':
          try {
            clearPendingEval();
            clearAudioUnlockPrompt();
            clearLocalRestoreState();
            if (sm.stop) sm.stop();
            var resetCode = msg.payload && msg.payload.code ? msg.payload.code : '';
            if (sm.setCode) writeEditor(sm, resetCode);
            markAgreed(resetCode);
          } catch (err) {
            console.warn('[strudel-ws] reset_session error:', err);
          }
          break;

        default:
          console.warn('[strudel-ws] unknown command:', msg.type);
      }
    }

    function evaluate(msg, sm) {
      try {
        if (!sm.setCode || !sm.evaluate) {
          throw new Error('Strudel REPL is not ready yet.');
        }
        beginPendingEval(msg.request_id, msg.payload.code);
        writeEditor(sm, msg.payload.code);
        markAgreed(msg.payload.code);
        Promise.resolve(evaluateForBridge(sm, true)).then(function() {
          timers.setTimeout(function() {
            var diagnostics = getAudioDiagnostics(sm);
            if (diagnostics.audioContextState && diagnostics.audioContextState !== 'running') {
              showAudioUnlockPrompt();
              send({
                type: 'ack',
                request_id: msg.request_id,
                status: 'needs_user_gesture',
                payload: {
                  codeLength: (msg.payload.code || '').length,
                  audioContextState: diagnostics.audioContextState,
                  message: 'DJ Opus queued the pattern, but this browser still needs a tap inside the widget to unlock audio.'
                }
              });
            } else {
              clearAudioUnlockPrompt();
              send({
                type: 'ack',
                request_id: msg.request_id,
                status: 'playing',
                payload: {
                  codeLength: (msg.payload.code || '').length,
                  audioContextState: diagnostics.audioContextState
                }
              });
            }
            finishPendingEval();
          }, 120);
        }).catch(function(err) {
          clearPendingEval();
          send({ type: 'error', request_id: msg.request_id, payload: { message: err.message, code: msg.payload.code } });
        });
      } catch (err) {
        clearPendingEval();
        send({ type: 'error', request_id: msg.request_id, payload: { message: err.message, code: msg.payload.code } });
      }
    }

    // An append, a replace and an effect each change the editor and then tell the server the whole text
    // it ended up with. The agent only sent a fragment, and the server takes the editor's word for the rest, if it
    // is still waiting for the ack. As for a get_code answer, the page cannot tell if it is (markTold).
    // transform(code) returns the new text and, optionally, more ack payload.
    function editCode(msg, sm, status, transform) {
      try {
        if (!sm.setCode || sm.code === undefined) {
          throw new Error('Strudel editor is not ready yet.');
        }
        // If the first state is still waiting, the editor holds Strudel's own restore or nothing. Bring the
        // session's code in first, so the edit lands on it and the ack tells the server the right text.
        flushRestore();
        var change = transform(sm.code);
        writeEditor(sm, change.code);
        var code = typeof sm.code === 'string' ? sm.code : change.code;
        markTold(code);
        var payload = change.payload || {};
        payload.code = code;
        send({ type: 'ack', request_id: msg.request_id, status: status, payload: payload });
      } catch (err) {
        send({ type: 'error', request_id: msg.request_id, payload: { message: err.message } });
      }
    }

    // --- Manual edits ---

    // The user plays the editor's text by hand with Ctrl+Enter, the play button or Vim's :w, and each of those calls the
    // editor's evaluate. The bridge wraps it, once, to learn what was played: StrudelMirror has evaluate on its
    // prototype, so the wrapper is an own property that shadows it, and the page looks evaluate up on the editor each
    // time it calls, so the wrapper sees every call. The evaluations the bridge starts for the agent's commands go through
    // evaluateForBridge and are not reported: the session already holds that code.
    function watchEvaluations(sm) {
      if (evaluationsWatched || typeof sm.evaluate !== 'function') return;
      evaluationsWatched = true; // tried once: an editor that does not allow it is not asked again at every look
      var original = sm.evaluate;
      function wrapper() {
        // An evaluation that does not start playback is not what plays (the export renders audio with one).
        var manual = bridgeEvaluations === 0 && arguments[0] !== false;
        // The call plays the text the editor holds as it starts, and the user can type on while it runs. How many
        // times the bridge has written the editor is noted too: see reportManualEvaluation.
        var started = manual ? { code: sm.code, writes: editorWrites } : undefined;
        var result = original.apply(this, arguments);
        if (!manual) return result;
        // The caller gets what the editor would have given it: the value, or the failure. The report is on the side.
        if (result && typeof result.then === 'function') {
          return result.then(function(value) {
            reportManualEvaluation(sm, started);
            return value;
          });
        }
        reportManualEvaluation(sm, started);
        return result;
      }
      try {
        sm.evaluate = wrapper;
      } catch (err) {
        // A host object that does not allow it. The report is a bonus, and the bridge must still connect.
        console.warn('[strudel-ws] could not watch the editor for evaluations by hand:', err);
      }
    }

    // Starts an evaluation for a command of the bridge's. The wrapper tells it from the user's by the count, which is up
    // only while the call itself runs: an evaluation the user starts meanwhile is still the user's.
    function evaluateForBridge(sm, autostart) {
      bridgeEvaluations++;
      try {
        return sm.evaluate(autostart);
      } finally {
        bridgeEvaluations--;
      }
    }

    // An evaluation by hand went through. If the text is one the session does not hold, and ran without an error, the
    // session is told. A failed evaluation plays nothing new: Strudel does not reject for code that is wrong, it sets
    // evalError and goes on playing what played before. Like a command, a report that goes out replaces the first state
    // of a new session that is still waiting (markSynced), and one that cannot go out is not taken for sent. The
    // session's code, for this, is what the server said in a state, what one of its commands put there, and what a
    // report of this page's gave it (agreedCode), and nothing is known after an answer or an ack that the server may
    // not have taken: then the play is reported. A redundant report costs nothing, as the session takes only code
    // that differs from its own.
    //
    // The text has to be the session's or the user's own on it, and not Strudel's. For a session with code, the editor
    // holds Strudel's own restore until the first state is applied, and reporting that would put it over the session's
    // code, so nothing is reported while the first state waits. A call can end long after it started (the first one
    // waits for the samples to load), so a call that spans a write of the bridge's, which is when the first state is
    // applied or a command replaces the code, ran on older text than the editor holds now, and is not reported either.
    // `started` is the editor's text, and the count of writes, as the call began.
    function reportManualEvaluation(sm, started) {
      try {
        var code = started.code;
        // Before the first state the page does not know what the session holds, and the editor holds Strudel's own restore.
        if (!sawFirstState || typeof code !== 'string' || code === agreedCode) return;
        if (editorHoldsRestore() || editorWrites !== started.writes) return;
        var state = sm.repl && sm.repl.state;
        if (state && state.evalError) return;
        if (utf8Length(code) > MAX_CODE_BYTES) {
          console.warn('[strudel-ws] the editor holds more than the ' + MAX_CODE_BYTES + ' bytes that a session takes, so the session is not told what plays');
          return;
        }
        if (send({ type: 'code_update', payload: { code: code } })) markAgreed(code);
      } catch (err) {
        console.warn('[strudel-ws] could not tell the session about an evaluation:', err);
      }
    }

    // --- Session sync ---

    function clearLocalRestoreState() {
      removeKeys(deps.localStorage, LOCAL_KEYS.local);
      removeKeys(deps.sessionStorage, LOCAL_KEYS.session);
    }

    function removeKeys(storage, keys) {
      keys.forEach(function(key) {
        try { storage.removeItem(key); } catch (e) {}
      });
    }

    // The editor holds this code, and the page and the server have exchanged it: one of the server's commands put it
    // there, or an answer, an ack or a report of the page's carried it to the server. A reconnect's state is compared
    // with it, so that the user's typing since is not thrown away, and a first state that is still waiting would put
    // older code over it, so that one is dropped. The server refuses code over its limit and keeps what it had, so such
    // code is not synced. This does not say that the server holds the code: see markAgreed and markTold.
    function markSynced(code) {
      cancelRestore();
      if (utf8Length(code) <= MAX_CODE_BYTES) syncedCode = code;
    }

    // The same, and the server is known to hold the code: one of its commands put it there, or a report of this page's
    // did. (A state says what the server holds as it arrives: see applySessionState.)
    function markAgreed(code) {
      markSynced(code);
      if (utf8Length(code) <= MAX_CODE_BYTES) agreedCode = code;
    }

    // The same, for the editor's text that the page told the server in a get_code answer or the ack of an edit. The
    // server takes it only if it is still waiting for it, which the page cannot tell. So the server may hold this code,
    // or the one it held before, and what it holds is not known: a play of either is news until a state, a command or a
    // report says what it holds.
    function markTold(code) {
      markSynced(code);
      agreedCode = null;
    }

    function utf8Length(text) {
      return new TextEncoder().encode(text).length;
    }

    function cancelRestore() {
      if (restoreTimer !== null) {
        timers.clearTimeout(restoreTimer);
        restoreTimer = null;
      }
      restoreApply = null;
    }

    // The first state of a session with code is waiting, so the editor holds Strudel's own restore and not the
    // session's code. (The editor of a new session was emptied at once: what is in it is the user's.)
    function editorHoldsRestore() {
      return restoreTimer !== null && !restoreForNewSession;
    }

    // Applies the first state now, if it is still waiting. For anything that reads the editor or builds on it
    // during the wait: what is in the editor then is not the session's code.
    function flushRestore() {
      var apply = restoreApply;
      cancelRestore();
      if (apply) apply();
    }

    // The server sends session_state on every connect. The page takes it in once, on its first connect, and
    // after that only when the server moved on while the page was away. Applying it on every reconnect threw
    // away whatever was in the editor, and stopping playback for an empty one cut the music.
    function applySessionState(sm, payload) {
      // A frame without a payload is not a state. It must not read as a new, empty session.
      if (!sm.setCode || !payload || typeof payload !== 'object') return;
      var pattern = typeof payload.currentPattern === 'string' ? payload.currentPattern : '';
      // A server from before rev existed sends none. It is taken in on the first connect and ignored after.
      var rev = typeof payload.rev === 'number' && isFinite(payload.rev) ? payload.rev : null;
      // Whatever the page does with the state, it says what the session holds now: after an eviction that lost
      // something it is less than the page thought, and a play of the editor's text puts it back.
      agreedCode = pattern;

      if (!sawFirstState) {
        sawFirstState = true;
        lastAppliedRev = rev;
        syncedCode = pattern;
        restoreFirstState(pattern, pattern === '' && (rev === null || rev === 0));
        return;
      }

      if (rev === null || (lastAppliedRev !== null && rev <= lastAppliedRev)) return;
      lastAppliedRev = rev;
      // A first state still waiting means the editor does not hold the code the page last synced, so that
      // code says nothing about whether this state has anything to bring over.
      var restoreWaiting = restoreTimer !== null;
      cancelRestore();
      // The editor already shows it, or the page already took this code in and the user has edited it since:
      // either way there is nothing newer to bring over, and typing is not thrown away. The rev alone cannot
      // tell, because it also moves for the commands this page has already run.
      if (pattern !== sm.code && (restoreWaiting || pattern !== syncedCode)) writeEditor(sm, pattern);
      syncedCode = pattern;
    }

    // Strudel restores its own last session a moment after the editor starts, and would put it over the
    // server's code, so the first state is applied 1.5 s later. A session that is new (no code, no rev) has
    // nothing to restore: its editor and Strudel's saved session are emptied. That happens at once, so a stale
    // pattern is not on screen for 1.5 s, and again after the delay. A late restore after the first state is
    // also ignored: see installRestoreGuard.
    function restoreFirstState(pattern, isNewSession) {
      function apply() {
        var current = currentMirror();
        if (!current || !current.setCode) return;
        if (isNewSession) clearLocalRestoreState();
        writeEditor(current, pattern);
      }
      if (isNewSession) apply();
      restoreApply = apply;
      restoreForNewSession = isNewSession;
      restoreTimer = timers.setTimeout(function() {
        restoreTimer = null;
        restoreApply = null;
        apply();
      }, RESTORE_DELAY);
    }

    // --- Restore guard ---

    // Strudel restores the user's last session with editor.setCode(), and that restore can land seconds late,
    // after the server's code is in the editor: it did when the player URL had a ?session= query, which Strudel
    // first looked up as a share hash in Supabase. The player URL has no query now, and the guard stays anyway. A
    // late restore would carry the stale text into the next edit or get_code, and from there into the session. So
    // for RESTORE_GUARD_MS after the bridge first sees the editor, setCode calls that the bridge did not make are
    // ignored, from the moment the server's state has arrived. Before that nothing of the server's is in the
    // editor yet, and a page that cannot reach the server should still show the user's last session. The
    // bridge's own writes go to the original method (see writeEditor), past the guard. Anything else on the
    // page that calls setCode in those seconds is ignored too, such as loading a pattern from the Patterns tab.
    function installRestoreGuard(sm) {
      if (guardInstalled || typeof sm.setCode !== 'function') return;
      guardInstalled = true;
      var original = sm.setCode;
      // StrudelMirror has setCode on its prototype. The guard shadows it with an own property and removes that again.
      var ownProperty = Object.prototype.hasOwnProperty.call(sm, 'setCode');
      function wrapper() {
        if (!sawFirstState || restoreWindowOver) return original.apply(sm, arguments);
        console.log('[strudel-ws] ignored a setCode call from the page: the session\'s code stays');
      }
      try {
        sm.setCode = wrapper;
      } catch (err) {
        // A host object that does not allow it. The guard is a bonus, and the bridge must still connect.
        console.warn('[strudel-ws] could not guard the editor against a late restore:', err);
        return;
      }
      guard = { mirror: sm, original: original, wrapper: wrapper, ownProperty: ownProperty };
      timers.setTimeout(removeRestoreGuard, RESTORE_GUARD_MS);
    }

    function removeRestoreGuard() {
      var installed = guard;
      guard = null;
      // The wrapper may be out of reach by now: somebody who took it, or put a wrapper of their own over it,
      // keeps calling it. It checks this flag, so it stops ignoring calls however it is held.
      restoreWindowOver = true;
      // If somebody replaced setCode since, that one is theirs now.
      if (!installed || installed.mirror.setCode !== installed.wrapper) return;
      if (installed.ownProperty) installed.mirror.setCode = installed.original;
      else delete installed.mirror.setCode;
    }

    // The bridge's own writes to the editor.
    function writeEditor(sm, code) {
      var write = guard && guard.mirror === sm ? guard.original : sm.setCode;
      editorWrites++;
      write.call(sm, code);
    }

    // The editor. The first time there is one, the restore guard goes on and its evaluations are watched.
    function currentMirror() {
      var sm = deps.getMirror();
      if (sm) {
        installRestoreGuard(sm);
        watchEvaluations(sm);
      }
      return sm;
    }

    // --- Pending evaluation ---

    function beginPendingEval(requestId, code) {
      if (!requestId) return;
      clearPendingEval();
      pendingEval = { request_id: requestId, code: code };
    }

    function finishPendingEval() {
      if (!pendingEval) return;
      if (pendingEvalClearTimer) {
        timers.clearTimeout(pendingEvalClearTimer);
      }
      pendingEvalClearTimer = timers.setTimeout(function() {
        clearPendingEval();
      }, 1500);
    }

    function clearPendingEval() {
      if (pendingEvalClearTimer) {
        timers.clearTimeout(pendingEvalClearTimer);
        pendingEvalClearTimer = null;
      }
      pendingEval = null;
    }

    // An error the page raises while an evaluation is pending belongs to that evaluation.
    function reportPendingEvalError(message) {
      if (!pendingEval || !message) return false;
      send({
        type: 'error',
        request_id: pendingEval.request_id,
        payload: {
          message: message,
          code: pendingEval.code
        }
      });
      clearPendingEval();
      return true;
    }

    // --- Audio ---

    function showAudioUnlockPrompt(message) {
      if (deps.showAudioUnlockPrompt) deps.showAudioUnlockPrompt(message);
    }

    function clearAudioUnlockPrompt() {
      if (deps.clearAudioUnlockPrompt) deps.clearAudioUnlockPrompt();
    }

    function getAudioContext(sm) {
      if (!sm || !sm.repl) return null;
      return sm.repl.audioContext || sm.repl._audioContext || null;
    }

    function getAudioDiagnostics(sm) {
      var ctx = getAudioContext(sm);
      return {
        audioContextState: ctx ? ctx.state : null,
        hasAudioContext: !!ctx,
        isPlaying: !!(sm && sm.repl && sm.repl.scheduler && sm.repl.scheduler.started),
      };
    }

    function resumeAudioContext(sm) {
      var ctx = getAudioContext(sm || currentMirror());
      if (!ctx || typeof ctx.resume !== 'function' || ctx.state === 'running') {
        return Promise.resolve(ctx ? ctx.state : null);
      }
      return Promise.resolve(ctx.resume()).then(function() {
        return ctx.state;
      }).catch(function(err) {
        console.warn('[strudel-ws] audio resume failed:', err);
        return ctx.state;
      });
    }

    // What the boot layer runs on the first tap or touch: browsers only let audio start after a gesture.
    function unlockAudio() {
      var sm = currentMirror();
      resumeAudioContext(sm);
      timers.setTimeout(function() {
        resumeAudioContext(sm).then(function(state) {
          if (state === 'running') {
            clearAudioUnlockPrompt();
          }
        });
      }, 80);
    }

    function recoverAudio(sm, requestId) {
      var code = sm && sm.code ? sm.code : '';
      var before = getAudioDiagnostics(sm);

      resumeAudioContext(sm).then(function() {
        var afterResume = getAudioDiagnostics(sm);
        if (code && sm && sm.evaluate && (!afterResume.audioContextState || afterResume.audioContextState === 'running')) {
          return Promise.resolve(evaluateForBridge(sm, true)).then(function() {
            return getAudioDiagnostics(sm);
          });
        }
        return afterResume;
      }).then(function(finalDiagnostics) {
        if (finalDiagnostics.audioContextState && finalDiagnostics.audioContextState !== 'running') {
          showAudioUnlockPrompt('Tap here to enable audio in DJ Opus');
          send({
            type: 'ack',
            request_id: requestId,
            status: 'needs_user_gesture',
            payload: {
              audioContextState: finalDiagnostics.audioContextState,
              wasPlaying: before.isPlaying,
              codeLength: code.length,
              message: 'Audio still needs a tap inside the widget to unlock on this device.',
            }
          });
          return;
        }

        clearAudioUnlockPrompt();
        send({
          type: 'ack',
          request_id: requestId,
          status: 'audio_recovered',
          payload: {
            audioContextState: finalDiagnostics.audioContextState,
            wasPlaying: before.isPlaying,
            codeLength: code.length,
            recovered: true,
          }
        });
      }).catch(function(err) {
        send({ type: 'error', request_id: requestId, payload: { message: err.message || String(err), code: code } });
      });
    }
  }

  // --- Boot (browser only) ---

  // Wires the core to the page. Nothing here is unit-tested, so it only connects things.
  function boot() {
    var bridge = null; // set below. The audio prompt reads it when it is tapped

    // How each state of the pill (see pillState) looks.
    var PILL_VIEW = {
      connecting: { text: 'Connecting...', color: '#ffcc00' },
      waiting: { text: 'Waiting for your agent', color: '#4da3ff' },
      connected: { text: 'Connected', color: '#3ddc84' },
      reconnecting: { text: 'Reconnecting...', color: '#ffcc00' },
      offline: { text: 'Offline', color: '#ff5c5c' }
    };

    function readStorage(name) {
      try {
        return window[name];
      } catch (e) {
        return null; // a sandboxed frame throws just for looking
      }
    }

    function showAudioUnlockPrompt(message) {
      var existing = document.getElementById('djopus-audio-unlock');
      if (existing) {
        var existingLabel = existing.querySelector('[data-djopus-audio-label]');
        if (existingLabel && message) existingLabel.textContent = message;
        return;
      }

      var prompt = document.createElement('button');
      prompt.id = 'djopus-audio-unlock';
      prompt.type = 'button';
      prompt.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;' +
        'padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,0.16);' +
        'background:rgba(10,16,32,0.92);color:#f6f6f6;font:600 13px/1.4 system-ui,sans-serif;' +
        'box-shadow:0 12px 30px rgba(0,0,0,0.35);text-align:left;';

      var label = document.createElement('span');
      label.setAttribute('data-djopus-audio-label', 'true');
      label.textContent = message || 'Tap here to enable audio in DJ Opus';
      prompt.appendChild(label);

      prompt.addEventListener('click', function() {
        bridge.resumeAudio().then(function(state) {
          if (state === 'running') {
            clearAudioUnlockPrompt();
          }
        });
      });

      document.body.appendChild(prompt);
    }

    function clearAudioUnlockPrompt() {
      var existing = document.getElementById('djopus-audio-unlock');
      if (existing) {
        existing.remove();
      }
    }

    function copyText(text) {
      function fallback() {
        var area = document.createElement('textarea');
        area.value = text;
        area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(area);
        area.select();
        var copied = false;
        try { copied = document.execCommand('copy'); } catch (e) {}
        area.remove();
        return copied ? Promise.resolve() : Promise.reject(new Error('copy failed'));
      }
      if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
        return window.navigator.clipboard.writeText(text).catch(fallback);
      }
      return fallback();
    }

    // A small fixed pill: what the connection is doing (or that it waits for an agent), a button that copies the link to
    // this session, and the links of the source offer. It wraps on a narrow screen.
    function createStatusPill() {
      var pill = document.createElement('div');
      pill.id = 'djopus-status';
      pill.setAttribute('role', 'status');
      pill.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99990;display:flex;flex-wrap:wrap;align-items:center;' +
        'gap:4px 8px;max-width:calc(100vw - 24px);box-sizing:border-box;' +
        'padding:5px 10px 5px 10px;border-radius:18px;border:1px solid rgba(255,255,255,0.16);' +
        'background:rgba(10,16,32,0.88);color:#f6f6f6;font:600 12px/1.2 system-ui,sans-serif;' +
        'box-shadow:0 6px 18px rgba(0,0,0,0.3);';

      var dot = document.createElement('span');
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex:none;';
      var text = document.createElement('span');

      var copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy link';
      copy.title = 'Copy the link to this session';
      copy.style.cssText = 'border:1px solid rgba(255,255,255,0.2);border-radius:999px;padding:3px 9px;cursor:pointer;' +
        'background:rgba(255,255,255,0.08);color:inherit;font:inherit;';
      copy.addEventListener('click', function() {
        copyText(bridge.playerUrl()).then(function() {
          copy.textContent = 'Copied';
        }, function() {
          copy.textContent = 'Copy failed';
        }).then(function() {
          window.setTimeout(function() { copy.textContent = 'Copy link'; }, 1500);
        });
      });

      pill.appendChild(dot);
      pill.appendChild(text);
      pill.appendChild(copy);

      // The AGPL source offer. They open in a tab of their own, and without a way back to this page.
      SOURCE_LINKS.forEach(function(link) {
        var anchor = document.createElement('a');
        anchor.href = link.href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.title = link.title;
        anchor.textContent = link.label;
        anchor.style.cssText = 'color:inherit;opacity:0.75;text-decoration:underline;font-weight:500;';
        pill.appendChild(anchor);
      });
      document.body.appendChild(pill);

      return function show(state) {
        var view = PILL_VIEW[state] || PILL_VIEW.connecting;
        text.textContent = view.text;
        dot.style.background = view.color;
      };
    }

    function start() {
      var config = window.DJOPUS_CONFIG;
      // The ChatGPT widget has its own chrome and no room for a pill.
      var showPill = config && config.mode === 'widget' ? function() {} : createStatusPill();
      showPill('connecting');

      bridge = createBridge({
        WebSocketImpl: window.WebSocket,
        getMirror: function() { return window.strudelMirror || null; },
        getConfig: function() { return window.DJOPUS_CONFIG; },
        location: window.location,
        // Called through wrappers: window.setTimeout throws when it is called as a method of another object.
        timers: {
          setTimeout: function(fn, ms) { return window.setTimeout(fn, ms); },
          clearTimeout: function(id) { window.clearTimeout(id); },
          setInterval: function(fn, ms) { return window.setInterval(fn, ms); },
          clearInterval: function(id) { window.clearInterval(id); }
        },
        random: Math.random,
        getRandomValues: function(bytes) { return window.crypto.getRandomValues(bytes); },
        replaceUrl: function(path) { window.history.replaceState(null, '', path); },
        localStorage: readStorage('localStorage'),
        sessionStorage: readStorage('sessionStorage'),
        onPill: showPill,
        showAudioUnlockPrompt: showAudioUnlockPrompt,
        clearAudioUnlockPrompt: clearAudioUnlockPrompt
      });

      document.addEventListener('pointerdown', bridge.unlockAudio, { passive: true });
      document.addEventListener('touchend', bridge.unlockAudio, { passive: true });

      document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') bridge.onVisible();
      });
      window.addEventListener('online', bridge.onOnline);
      window.addEventListener('offline', bridge.onOffline);
      if (window.navigator.onLine === false) bridge.onOffline();

      window.addEventListener('error', function(event) {
        var message = event && event.error && event.error.message
          ? event.error.message
          : event && event.message
            ? event.message
            : null;
        bridge.reportPendingEvalError(message);
      });
      window.addEventListener('unhandledrejection', function(event) {
        var reason = event && event.reason;
        var message = reason && reason.message
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : null;
        bridge.reportPendingEvalError(message);
      });

      bridge.connect();
      window.strudelWSBridge = bridge;
    }

    function waitAndConnect() {
      if (window.strudelMirror) {
        start();
      } else {
        setTimeout(waitAndConnect, 500);
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', waitAndConnect);
    } else {
      waitAndConnect();
    }
  }

  if (typeof module === 'object' && module !== null && module.exports) {
    // Loaded as a CommonJS module (the unit tests): hand out the core and boot nothing.
    module.exports = {
      createBridge: createBridge,
      nextReconnectDelay: nextReconnectDelay,
      resolveSessionId: resolveSessionId,
      mintSessionId: mintSessionId,
      SESSION_ID_PATTERN: SESSION_ID_PATTERN,
      LOCAL_KEYS: LOCAL_KEYS,
      pillState: pillState,
      SOURCE_LINKS: SOURCE_LINKS
    };
    return;
  }
  boot();
})();
