(function() {
  'use strict';

  var RECONNECT_DELAY = 2000;
  var MAX_RECONNECT = 10;
  var STATUS_INTERVAL = 5000;

  function StrudelWSBridge() {
    this.ws = null;
    this.reconnectAttempts = 0;
    // Use URL ?session= param, or default to 'default' (matches MCP's DJOPUS_SESSION default)
    // For isolated sessions, open djopus.moore.nyc?session=myname
    this.sessionId = new URLSearchParams(window.location.search).get('session') || 'default';
    this.statusTimer = null;
  }

  StrudelWSBridge.prototype.connect = function() {
    var self = this;
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = protocol + '//' + window.location.host + '/ws?session=' + this.sessionId + '&role=browser';

    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', function() {
      console.log('[strudel-ws] connected to session:', self.sessionId, '| To connect MCP: DJOPUS_SESSION=' + self.sessionId);
      self.reconnectAttempts = 0;
      self.startStatusReporting();
    });

    this.ws.addEventListener('message', function(event) {
      try {
        var msg = JSON.parse(event.data);
        self.handleCommand(msg);
      } catch (err) {
        console.error('[strudel-ws] parse error:', err);
      }
    });

    this.ws.addEventListener('close', function() {
      console.log('[strudel-ws] disconnected');
      self.stopStatusReporting();
      self.scheduleReconnect();
    });

    this.ws.addEventListener('error', function(err) {
      console.error('[strudel-ws] error:', err);
    });
  };

  StrudelWSBridge.prototype.handleCommand = function(msg) {
    var sm = window.strudelMirror;
    if (!sm) {
      console.warn('[strudel-ws] strudelMirror not ready');
      return;
    }

    var self = this;

    switch (msg.type) {
      case 'evaluate':
        if (sm.setCode) sm.setCode(msg.payload.code);
        if (sm.evaluate) {
          sm.evaluate(true).catch(function(err) {
            self.send({ type: 'error', request_id: msg.request_id, payload: { message: err.message, code: msg.payload.code } });
          });
        }
        break;

      case 'stop':
        if (sm.stop) sm.stop();
        break;

      case 'set_code':
        if (sm.setCode) sm.setCode(msg.payload.code);
        break;

      case 'set_tempo':
        try {
          var bpm = msg.payload.bpm;
          var cps = bpm / 60 / 4;
          // Evaluate setcps without changing editor content
          if (sm.repl && sm.repl.evaluate) {
            sm.repl.evaluate('setcps(' + cps + ')', false);
          }
          self.send({ type: 'ack', request_id: msg.request_id, status: 'tempo_set', payload: { bpm: bpm } });
        } catch (err) {
          self.send({ type: 'error', request_id: msg.request_id, payload: { message: err.message } });
        }
        break;

      case 'get_code':
        self.send({
          type: 'code_response',
          request_id: msg.request_id,
          payload: { code: sm.code || '' }
        });
        break;

      case 'append_code':
        if (sm.setCode && sm.code !== undefined) {
          sm.setCode(sm.code + '\n' + msg.payload.code);
        }
        self.send({ type: 'ack', request_id: msg.request_id, status: 'appended' });
        break;

      case 'replace_code':
        if (sm.setCode && sm.code !== undefined) {
          var current = sm.code;
          var updated = current.split(msg.payload.search).join(msg.payload.replace);
          sm.setCode(updated);
          self.send({ type: 'ack', request_id: msg.request_id, status: 'replaced', payload: { changed: current !== updated } });
        }
        break;

      case 'add_effect':
        if (sm.setCode && sm.code !== undefined) {
          var effectStr = '.' + msg.payload.effect + '(';
          if (msg.payload.params) {
            effectStr += Object.values(msg.payload.params).join(', ');
          }
          effectStr += ')';
          sm.setCode(sm.code + effectStr);
          self.send({ type: 'ack', request_id: msg.request_id, status: 'effect_added' });
        }
        break;

      case 'session_state':
        // Delay restore to win the race against Strudel's localStorage restoration
        if (msg.payload.currentPattern && msg.payload.currentPattern.length > 0 && sm.setCode) {
          setTimeout(function() {
            sm.setCode(msg.payload.currentPattern);
          }, 1500);
        }
        break;

      default:
        console.warn('[strudel-ws] unknown command:', msg.type);
    }
  };

  StrudelWSBridge.prototype.send = function(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  };

  StrudelWSBridge.prototype.startStatusReporting = function() {
    var self = this;
    this.statusTimer = setInterval(function() {
      var sm = window.strudelMirror;
      if (!sm) return;

      var bpm = null;
      try {
        if (sm.repl && sm.repl.scheduler && sm.repl.scheduler.cps) {
          bpm = Math.round(sm.repl.scheduler.cps * 60 * 4);
        }
      } catch (e) {}

      self.send({
        type: 'status_report',
        payload: {
          isPlaying: !!(sm.repl && sm.repl.scheduler && sm.repl.scheduler.started),
          codeLength: (sm.code || '').length,
          hasErrors: false,
          bpm: bpm,
          errorMessage: null
        }
      });
    }, STATUS_INTERVAL);
  };

  StrudelWSBridge.prototype.stopStatusReporting = function() {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  };

  StrudelWSBridge.prototype.scheduleReconnect = function() {
    if (this.reconnectAttempts >= MAX_RECONNECT) {
      console.error('[strudel-ws] max reconnect attempts reached');
      return;
    }
    var self = this;
    this.reconnectAttempts++;
    setTimeout(function() { self.connect(); }, RECONNECT_DELAY);
  };

  function waitAndConnect() {
    if (window.strudelMirror) {
      var bridge = new StrudelWSBridge();
      bridge.connect();
      window.strudelWSBridge = bridge;
    } else {
      setTimeout(waitAndConnect, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitAndConnect);
  } else {
    waitAndConnect();
  }
})();
