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
    this.sessionId = (window.DJOPUS_CONFIG && window.DJOPUS_CONFIG.sessionId) ||
      new URLSearchParams(window.location.search).get('session') || 'default';
    this.statusTimer = null;
    this.pendingEval = null;
    this.pendingEvalClearTimer = null;
    this.gestureUnlockInstalled = false;
  }

  StrudelWSBridge.prototype.connect = function() {
    var self = this;
    // In widget mode (ChatGPT iframe), window.location.host is empty — use config's wsUrl
    var wsBase = (window.DJOPUS_CONFIG && window.DJOPUS_CONFIG.wsUrl);
    var url;
    if (wsBase) {
      url = wsBase + '?session=' + this.sessionId + '&role=browser';
    } else {
      var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      url = protocol + '//' + window.location.host + '/ws?session=' + this.sessionId + '&role=browser';
    }

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
        try {
          if (!sm.setCode || !sm.evaluate) {
            throw new Error('Strudel REPL is not ready yet.');
          }
          self.beginPendingEval(msg.request_id, msg.payload.code);
          sm.setCode(msg.payload.code);
          Promise.resolve(sm.evaluate(true)).then(function() {
            setTimeout(function() {
              var diagnostics = self.getAudioDiagnostics(sm);
              if (diagnostics.audioContextState && diagnostics.audioContextState !== 'running') {
                self.showAudioUnlockPrompt();
                self.send({
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
                self.clearAudioUnlockPrompt();
                self.send({
                  type: 'ack',
                  request_id: msg.request_id,
                  status: 'playing',
                  payload: {
                    codeLength: (msg.payload.code || '').length,
                    audioContextState: diagnostics.audioContextState
                  }
                });
              }
              self.finishPendingEval();
            }, 120);
          }).catch(function(err) {
            self.clearPendingEval();
            self.send({ type: 'error', request_id: msg.request_id, payload: { message: err.message, code: msg.payload.code } });
          });
        } catch (err) {
          self.clearPendingEval();
          self.send({ type: 'error', request_id: msg.request_id, payload: { message: err.message, code: msg.payload.code } });
        }
        break;

      case 'stop':
        if (sm.stop) sm.stop();
        self.clearAudioUnlockPrompt();
        break;

      case 'set_code':
        try {
          if (!sm.setCode) {
            throw new Error('Strudel editor is not ready yet.');
          }
          sm.setCode(msg.payload.code);
          self.send({
            type: 'ack',
            request_id: msg.request_id,
            status: 'code_set',
            payload: { codeLength: (msg.payload.code || '').length }
          });
        } catch (err) {
          self.send({ type: 'error', request_id: msg.request_id, payload: { message: err.message, code: msg.payload.code } });
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
        try {
          if (!sm.setCode || sm.code === undefined) {
            throw new Error('Strudel editor is not ready yet.');
          }
          sm.setCode(sm.code + '\n' + msg.payload.code);
          self.send({ type: 'ack', request_id: msg.request_id, status: 'appended' });
        } catch (err) {
          self.send({ type: 'error', request_id: msg.request_id, payload: { message: err.message } });
        }
        break;

      case 'replace_code':
        try {
          if (!sm.setCode || sm.code === undefined) {
            throw new Error('Strudel editor is not ready yet.');
          }
          var current = sm.code;
          var updated = current.split(msg.payload.search).join(msg.payload.replace);
          sm.setCode(updated);
          self.send({ type: 'ack', request_id: msg.request_id, status: 'replaced', payload: { changed: current !== updated } });
        } catch (err) {
          self.send({ type: 'error', request_id: msg.request_id, payload: { message: err.message } });
        }
        break;

      case 'add_effect':
        try {
          if (!sm.setCode || sm.code === undefined) {
            throw new Error('Strudel editor is not ready yet.');
          }
          var effectStr = '.' + msg.payload.effect + '(';
          if (msg.payload.params) {
            effectStr += Object.values(msg.payload.params).join(', ');
          }
          effectStr += ')';
          sm.setCode(sm.code + effectStr);
          self.send({ type: 'ack', request_id: msg.request_id, status: 'effect_added' });
        } catch (err) {
          self.send({ type: 'error', request_id: msg.request_id, payload: { message: err.message } });
        }
        break;

      case 'session_state':
        // Delay restore to win the race against Strudel's own local/session storage restore.
        // Apply the server state even when it's empty so a fresh ChatGPT session does not
        // momentarily inherit the last local browser pattern.
        setTimeout(function() {
          if (!sm.setCode) return;
          if (!msg.payload.currentPattern) {
            self.clearLocalRestoreState();
            if (sm.stop) sm.stop();
          }
          sm.setCode(msg.payload.currentPattern || '');
        }, 1500);
        break;

      case 'recover_audio':
        self.recoverAudio(sm, msg.request_id);
        break;

      case 'reset_session':
        try {
          self.clearPendingEval();
          self.clearAudioUnlockPrompt();
          self.clearLocalRestoreState();
          if (sm.stop) sm.stop();
          if (sm.setCode) sm.setCode(msg.payload && msg.payload.code ? msg.payload.code : '');
        } catch (err) {
          console.warn('[strudel-ws] reset_session error:', err);
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

  StrudelWSBridge.prototype.beginPendingEval = function(requestId, code) {
    if (!requestId) return;
    this.clearPendingEval();
    this.pendingEval = { request_id: requestId, code: code };
  };

  StrudelWSBridge.prototype.finishPendingEval = function() {
    var self = this;
    if (!this.pendingEval) return;
    if (this.pendingEvalClearTimer) {
      clearTimeout(this.pendingEvalClearTimer);
    }
    this.pendingEvalClearTimer = setTimeout(function() {
      self.clearPendingEval();
    }, 1500);
  };

  StrudelWSBridge.prototype.clearPendingEval = function() {
    if (this.pendingEvalClearTimer) {
      clearTimeout(this.pendingEvalClearTimer);
      this.pendingEvalClearTimer = null;
    }
    this.pendingEval = null;
  };

  StrudelWSBridge.prototype.reportPendingEvalError = function(message) {
    if (!this.pendingEval || !message) return false;
    this.send({
      type: 'error',
      request_id: this.pendingEval.request_id,
      payload: {
        message: message,
        code: this.pendingEval.code
      }
    });
    this.clearPendingEval();
    return true;
  };

  StrudelWSBridge.prototype.getAudioContext = function(sm) {
    if (!sm || !sm.repl) return null;
    return sm.repl.audioContext || sm.repl._audioContext || null;
  };

  StrudelWSBridge.prototype.getAudioDiagnostics = function(sm) {
    var ctx = this.getAudioContext(sm);
    return {
      audioContextState: ctx ? ctx.state : null,
      hasAudioContext: !!ctx,
      isPlaying: !!(sm && sm.repl && sm.repl.scheduler && sm.repl.scheduler.started),
    };
  };

  StrudelWSBridge.prototype.resumeAudioContext = function(sm) {
    var ctx = this.getAudioContext(sm || window.strudelMirror);
    if (!ctx || typeof ctx.resume !== 'function' || ctx.state === 'running') {
      return Promise.resolve(ctx ? ctx.state : null);
    }
    return Promise.resolve(ctx.resume()).then(function() {
      return ctx.state;
    }).catch(function(err) {
      console.warn('[strudel-ws] audio resume failed:', err);
      return ctx.state;
    });
  };

  StrudelWSBridge.prototype.installGestureAudioUnlock = function() {
    var self = this;
    if (this.gestureUnlockInstalled) return;
    this.gestureUnlockInstalled = true;

    function tryUnlock() {
      var sm = window.strudelMirror;
      self.resumeAudioContext(sm);
      setTimeout(function() {
        self.resumeAudioContext(sm).then(function(state) {
          if (state === 'running') {
            self.clearAudioUnlockPrompt();
          }
        });
      }, 80);
    }

    document.addEventListener('pointerdown', tryUnlock, { passive: true });
    document.addEventListener('touchend', tryUnlock, { passive: true });
  };

  StrudelWSBridge.prototype.clearLocalRestoreState = function() {
    var keys = ['latestCode', 'viewingPatternData', 'activePattern'];
    keys.forEach(function(key) {
      try { window.localStorage.removeItem(key); } catch (e) {}
      try { window.sessionStorage.removeItem(key); } catch (e) {}
    });
  };

  StrudelWSBridge.prototype.showAudioUnlockPrompt = function(message) {
    var self = this;
    var existing = document.getElementById('djopus-audio-unlock');
    if (existing) {
      var label = existing.querySelector('[data-djopus-audio-label]');
      if (label && message) label.textContent = message;
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
      self.resumeAudioContext(window.strudelMirror).then(function(state) {
        if (state === 'running') {
          self.clearAudioUnlockPrompt();
        }
      });
    });

    document.body.appendChild(prompt);
  };

  StrudelWSBridge.prototype.clearAudioUnlockPrompt = function() {
    var existing = document.getElementById('djopus-audio-unlock');
    if (existing) {
      existing.remove();
    }
  };

  StrudelWSBridge.prototype.recoverAudio = function(sm, requestId) {
    var self = this;
    var code = sm && sm.code ? sm.code : '';
    var before = self.getAudioDiagnostics(sm);

    self.resumeAudioContext(sm).then(function() {
      var afterResume = self.getAudioDiagnostics(sm);
      if (code && sm && sm.evaluate && (!afterResume.audioContextState || afterResume.audioContextState === 'running')) {
        return Promise.resolve(sm.evaluate(true)).then(function() {
          return self.getAudioDiagnostics(sm);
        });
      }
      return afterResume;
    }).then(function(finalDiagnostics) {
      if (finalDiagnostics.audioContextState && finalDiagnostics.audioContextState !== 'running') {
        self.showAudioUnlockPrompt('Tap here to enable audio in DJ Opus');
        self.send({
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

      self.clearAudioUnlockPrompt();
      self.send({
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
      self.send({ type: 'error', request_id: requestId, payload: { message: err.message || String(err), code: code } });
    });
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
      bridge.installGestureAudioUnlock();
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
