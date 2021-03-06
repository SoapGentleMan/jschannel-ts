//tslint:disable:max-line-length no-any
/*
 * js_channel is a very lightweight abstraction on top of
 * postMessage which defines message formats and semantics
 * to support interactions more rich than just message passing
 * js_channel supports:
 *  + query/response - traditional rpc
 *  + query/update/response - incremental async return of results
 *    to a query
 *  + notifications - fire and forget
 *  + error handling
 *
 * js_channel is based heavily on json-rpc, but is focused at the
 * problem of inter-iframe RPC.
 *
 * Message types:
 *  There are 5 types of messages that can flow over this channel,
 *  and you may determine what type of message an object is by
 *  examining its parameters:
 *  1. Requests
 *    + integer id
 *    + string method
 *    + (optional) any params
 *  2. Callback Invocations (or just "Callbacks")
 *    + integer id
 *    + string callback
 *    + (optional) params
 *  3. Error Responses (or just "Errors)
 *    + integer id
 *    + string error
 *    + (optional) string message
 *  4. Responses
 *    + integer id
 *    + (optional) any result
 *  5. Notifications
 *    + string method
 *    + (optional) any params
 */

;

export interface ChannelObj {
  build: (...arg) => ChannelInstanceObj
}

export interface ChannelInstanceObj {
  unbind: (...arg) => {}
  bind: (...arg) => ChannelInstanceObj
  call: (...arg) => void
  notify: (...arg) => void
  destroy: (...arg) => void
}

export const Channel: ChannelObj = (() => {
  "use strict";

  // current transaction id, start out at a random *odd* number between 1 and a million
  // There is one current transaction counter id per page, and it's shared between
  // channel instances.  That means of all messages posted from a single javascript
  // evaluation context, we'll never have two with the same id.
  let s_curTranId = Math.floor(Math.random() * 1000001);

  // no two bound channels in the same javascript evaluation context may have the same origin, scope, and window.
  // futher if two bound channels have the same window and scope, they may not have *overlapping* origins
  // (either one or both support '*').  This restriction allows a single onMessage handler to efficiently
  // route messages based on origin and scope.  The s_boundChans maps origins to scopes, to message
  // handlers.  Request and Notification messages are routed using this table.
  // Finally, channels are inserted into this table when built, and removed when destroyed.
  const s_boundChans = {};

  // add a channel to s_boundChans, throwing if a dup exists
  function s_addBoundChan(win, origin, scope, handler) {
    function hasWin(arr) {
      for (const i of arr) {
        if (i.win === win) {
          return true;
        }
      }
      return false;
    }

    // does she exist?
    let exists = false;
    if (origin === '*') {
      // we must check all other origins, sadly.
      for (const k in s_boundChans) {
        if (!s_boundChans.hasOwnProperty(k)) {
          continue;
        }
        if (k === '*') {
          continue;
        }
        if (typeof s_boundChans[k][scope] === 'object') {
          exists = hasWin(s_boundChans[k][scope]);
          if (exists) {
            break;
          }
        }
      }
    } else {
      // we must check only '*'
      if ((s_boundChans['*'] && s_boundChans['*'][scope])) {
        exists = hasWin(s_boundChans['*'][scope]);
      }
      if (!exists && s_boundChans[origin] && s_boundChans[origin][scope]) {
        exists = hasWin(s_boundChans[origin][scope]);
      }
    }
    if (exists) {
      throw new Error("A channel is already bound to the same window which overlaps with origin '" + origin + "' and has scope '" + scope + "'")
    }

    if (typeof s_boundChans[origin] !== 'object') {
      s_boundChans[origin] = {};
    }
    if (typeof s_boundChans[origin][scope] !== 'object') {
      s_boundChans[origin][scope] = [];
    }
    s_boundChans[origin][scope].push({ win, handler });
  }

  function s_removeBoundChan(win, origin, scope) {
    const arr = s_boundChans[origin][scope];
    arr.forEach((item, index) => {
      if (item.win === win) {
        arr[index] = null
      }
    })
    s_boundChans[origin][scope] = arr.filter(item => !!item)
    if (s_boundChans[origin][scope].length === 0) {
      delete s_boundChans[origin][scope];
    }
  }

  function s_isArray(obj) {
    if (Array.isArray) {
      return Array.isArray(obj)
    }
    else {
      return (obj.constructor.toString().indexOf("Array") !== -1);
    }
  }

  // No two outstanding outbound messages may have the same id, period.  Given that, a single table
  // mapping "transaction ids" to message handlers, allows efficient routing of Callback, Error, and
  // Response messages.  Entries are added to this table when requests are sent, and removed when
  // responses are received.
  const s_transIds = {};

  // class singleton onMessage handler
  // this function is registered once and all incoming messages route through here.  This
  // arrangement allows certain efficiencies, message data is only parsed once and dispatch
  // is more efficient, especially for large numbers of simultaneous channels.
  const s_onMessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
      if (typeof m !== 'object' || m === null) {
        throw new Error("malformed")
      }
    } catch (e) {
      // just ignore any posted messages that do not consist of valid JSON
      return;
    }

    const w = e.source;
    const o = e.origin;
    let s;
    let i;
    let meth;

    if (typeof m.method === 'string') {
      const ar = m.method.split('::');
      if (ar.length === 2) {
        s = ar[0];
        meth = ar[1];
      } else {
        meth = m.method;
      }
    }

    if (typeof m.id !== 'undefined') {
      i = m.id
    }

    // w is message source window
    // o is message origin
    // m is parsed message
    // s is message scope
    // i is message id (or undefined)
    // meth is unscoped method name
    // ^^ based on these factors we can route the message

    // if it has a method it's either a notification or a request,
    // route using s_boundChans
    if (typeof meth === 'string') {
      let delivered = false;
      if (s_boundChans[o] && s_boundChans[o][s]) {
        for (const j of s_boundChans[o][s]) {
          if (j.win === w) {
            j.handler(o, meth, m);
            delivered = true;
            break;
          }
        }
      }

      if (!delivered && s_boundChans['*'] && s_boundChans['*'][s]) {
        for (const j of s_boundChans['*'][s]) {
          if (j.win === w) {
            j.handler(o, meth, m);
            break;
          }
        }
      }
    } else if (typeof i !== 'undefined') {     // otherwise it must have an id (or be poorly formed
      if (s_transIds[i]) {
        s_transIds[i](o, meth, m)
      }
    }
  };

  // Setup postMessage event listeners
  if (window.addEventListener) {
    window.addEventListener('message', s_onMessage, false)
  } else if ((window as Window & { attachEvent?: any }).attachEvent) {
    (window as Window & { attachEvent?: any }).attachEvent('onmessage', s_onMessage)
  }

  /* a messaging channel is constructed from a window and an origin.
   * the channel will assert that all messages received over the
   * channel match the origin
   *
   * Arguments to Channel.build(cfg):
   *
   *   cfg.window - the remote window with which we'll communicate
   *   cfg.origin - the expected origin of the remote window, may be '*'
   *                which matches any origin
   *   cfg.scope  - the 'scope' of messages.  a scope string that is
   *                prepended to message names.  local and remote endpoints
   *                of a single channel must agree upon scope. Scope may
   *                not contain double colons ('::').
   *   cfg.debugOutput - A boolean value.  If true and window.console.log is
   *                a function, then debug strings will be emitted to that
   *                function.
   *   cfg.debugOutput - A boolean value.  If true and window.console.log is
   *                a function, then debug strings will be emitted to that
   *                function.
   *   cfg.postMessageObserver - A function that will be passed two arguments,
   *                an origin and a message.  It will be passed these immediately
   *                before messages are posted.
   *   cfg.gotMessageObserver - A function that will be passed two arguments,
   *                an origin and a message.  It will be passed these arguments
   *                immediately after they pass scope and origin checks, but before
   *                they are processed.
   *   cfg.onReady - A function that will be invoked when a channel becomes "ready",
   *                this occurs once both sides of the channel have been
   *                instantiated and an application level handshake is exchanged.
   *                the onReady function will be passed a single argument which is
   *                the channel object that was returned from build().
   */
  return {
    build: (cfg) => {
      const debug = (m) => {
        if (cfg.debugOutput && window.console && window.console.log) {
          // try to stringify, if it doesn't work we'll let javascript's built in toString do its magic
          try {
            if (typeof m !== 'string') {
              m = JSON.stringify(m)
            }
          } catch (e) {
            //do nothing
          }
          console.log("[" + chanId + "] " + m);
        }
      };

      /* browser capabilities check */
      if (!window.postMessage) {
        throw new Error("jschannel cannot run this browser, no postMessage")
      }
      if (!(window as Window & { JSON?: any }).JSON || !JSON.stringify || !JSON.parse) {
        throw new Error("jschannel cannot run this browser, no JSON parsing/serialization")
      }

      /* basic argument validation */
      if (typeof cfg !== 'object') {
        throw new Error("Channel build invoked without a proper object argument")
      }

      if (!cfg.window || !cfg.window.postMessage) {
        throw new Error("Channel.build() called without a valid window argument")
      }

      /* we'd have to do a little more work to be able to run multiple channels that intercommunicate the same
       * window...  Not sure if we care to support that */

      if (window === cfg.window) {
        throw new Error("target window is same as present window -- not allowed")
      }

      // let's require that the client specify an origin.  if we just assume '*' we'll be
      // propagating unsafe practices.  that would be lame.
      let validOrigin = false;
      if (typeof cfg.origin === 'string') {
        const oMatch = cfg.origin.match(/^https?:\/\/(?:[-a-zA-Z0-9_\.])+(?::\d+)?/);
        if (cfg.origin === "*") {
          validOrigin = true
        }
        // allow valid domains under http and https.  Also, trim paths off otherwise valid origins.
        else if (null !== oMatch) {
          cfg.origin = oMatch[0].toLowerCase();
          validOrigin = true;
        }
      }

      if (!validOrigin) {
        throw new Error("Channel.build() called with an invalid origin")
      }

      if (typeof cfg.scope !== 'undefined') {
        if (typeof cfg.scope !== 'string') {
          throw new Error('scope, when specified, must be a string')
        }
        if (cfg.scope.split('::').length > 1) {
          throw new Error("scope may not contain double colons: '::'")
        }
      }

      /* private constiables */
      // generate a random and psuedo unique id for this channel
      let chanId = (() => {
        let text = "";
        const alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        for (const i of [1, 1, 1, 1, 1]) {
          text += alpha.charAt(Math.floor(Math.random() * alpha.length));
        }
        return text;
      })();

      // registrations: mapping method names to call objects
      let regTbl = {};
      // current oustanding sent requests
      let outTbl = {};
      // current oustanding received requests
      let inTbl = {};
      // are we ready yet?  when false we will block outbound messages.
      let ready = false;
      let pendingQueue = [];

      const createTransaction = (id, origin, callbacks) => {
        let shouldDelayReturn = false;
        let completed = false;

        return {
          origin,
          invoke: (cbName, v) => {
            // verify in table
            if (!inTbl[id]) {
              throw new Error("attempting to invoke a callback of a nonexistent transaction: " + id)
            }
            // verify that the callback name is valid
            let valid = false;
            for (const i of callbacks) {
              if (cbName === i) {
                valid = true;
                break;
              }
            }
            if (!valid) {
              throw new Error("request supports no such callback '" + cbName + "'")
            }

            // send callback invocation
            postMessage({ id, callback: cbName, params: v });
          },
          error: (error, message) => {
            completed = true;
            // verify in table
            if (!inTbl[id]) {
              throw new Error("error called for nonexistent message: " + id)
            }

            // remove transaction from table
            delete inTbl[id];

            // send error
            postMessage({ id, error, message });
          },
          complete: (v) => {
            completed = true;
            // verify in table
            if (!inTbl[id]) {
              throw new Error("complete called for nonexistent message: " + id)
            }
            // remove transaction from table
            delete inTbl[id];
            // send complete
            postMessage({ id, result: v });
          },
          delayReturn: (delay?) => {
            if (typeof delay === 'boolean') {
              shouldDelayReturn = (delay === true);
            }
            return shouldDelayReturn;
          },
          completed: () => {
            return completed;
          }
        };
      };

      const setTransactionTimeout = (transId, timeout, method) => {
        return window.setTimeout(() => {
          if (outTbl[transId]) {
            // XXX: what if client code raises an exception here?
            const msg = "timeout (" + timeout + "ms) exceeded on method '" + method + "'";
            //以前是(1, outTbl[transId].error)
            outTbl[transId].error("timeout_error", msg);
            delete outTbl[transId];
            delete s_transIds[transId];
          }
        }, timeout);
      };

      const onMessage = (origin, method, m) => {
        // if an observer was specified at allocation time, invoke it
        if (typeof cfg.gotMessageObserver === 'function') {
          // pass observer a clone of the object so that our
          // manipulations are not visible (i.e. method unscoping).
          // This is not particularly efficient, but then we expect
          // that message observers are primarily for debugging anyway.
          try {
            cfg.gotMessageObserver(origin, m);
          } catch (e) {
            debug("gotMessageObserver() raised an exception: " + e.toString());
          }
        }

        // now, what type of message is this?
        if (m.id && method) {
          // a request!  do we have a registered handler for this request?
          if (regTbl[method]) {
            const trans = createTransaction(m.id, origin, m.callbacks ? m.callbacks : []);
            inTbl[m.id] = {};
            try {
              // callback handling.  we'll magically create functions inside the parameter list for each
              // callback
              if (m.callbacks && s_isArray(m.callbacks) && m.callbacks.length > 0) {
                for (const i of m.callbacks) {
                  let object = m.params;
                  const pathItems = i.split('/');
                  for (const j of pathItems) {
                    if (pathItems.findIndex(j) === pathItems.length - 1) {
                      continue
                    }
                    if (typeof object[j] !== 'object') {
                      object[j] = {}
                    }
                    object = object[j];
                  }
                  object[pathItems[pathItems.length - 1]] = (() => {
                    return (params) => {
                      return trans.invoke(i, params);
                    };
                  })();
                }
              }
              const resp = regTbl[method](trans, m.params);
              if (!trans.delayReturn() && !trans.completed()) {
                trans.complete(resp);
              }
            } catch (e) {
              // automagic handling of exceptions:
              let error = "runtime_error";
              let message = null;
              // * if it's a string then it gets an error code of 'runtime_error' and string is the message
              if (typeof e === 'string') {
                message = e;
              } else if (typeof e === 'object') {
                // either an array or an object
                // * if it's an array of length two, then  array[0] is the code, array[1] is the error message
                if (e && s_isArray(e) && e.length === 2) {
                  error = e[0];
                  message = e[1];
                }
                // * if it's an object then we'll look form error and message parameters
                else if (typeof e.error === 'string') {
                  error = e.error;
                  if (!e.message) {
                    message = "";
                  } else if (typeof e.message === 'string') {
                    message = e.message;
                  } else {
                    e = e.message;  // let the stringify/toString message give us a reasonable verbose error string
                  }
                }
              }

              // message is *still* null, let's try harder
              if (message === null) {
                try {
                  message = JSON.stringify(e);
                  /* On MSIE8, this can result in 'out of memory', which
                   * leaves message undefined. */
                  if (typeof(message) === 'undefined') {
                    message = e.toString();
                  }
                } catch (e2) {
                  message = e.toString();
                }
              }

              trans.error(error, message);
            }
          }
        } else if (m.id && m.callback) {
          if (!outTbl[m.id] || !outTbl[m.id].callbacks || !outTbl[m.id].callbacks[m.callback]) {
            debug("ignoring invalid callback, id:" + m.id + " (" + m.callback + ")");
          } else {
            // XXX: what if client code raises an exception here?
            outTbl[m.id].callbacks[m.callback](m.params);
          }
        } else if (m.id) {
          if (!outTbl[m.id]) {
            debug("ignoring invalid response: " + m.id);
          } else {
            // XXX: what if client code raises an exception here?
            if (m.error) {
              //原本是(1, outTbl[m.id].error)(m.error, m.message)
              outTbl[m.id].error(m.error, m.message);
            } else {
              if (m.result !== undefined) {
                //原本是(1, outTbl[m.id].success)(m.result)
                outTbl[m.id].success(m.result);
              } else {
                //原本是(1, outTbl[m.id].success)()
                outTbl[m.id].success();
              }
            }
            delete outTbl[m.id];
            delete s_transIds[m.id];
          }
        } else if (method) {
          // tis a notification.
          if (regTbl[method]) {
            // yep, there's a handler for that.
            // transaction has only origin for notifications.
            regTbl[method]({ origin }, m.params);
            // if the client throws, we'll just let it bubble out
            // what can we do?  Also, here we'll ignore return values
          }
        }
      };

      // now register our bound channel for msg routing
      s_addBoundChan(cfg.window, cfg.origin, ((typeof cfg.scope === 'string') ? cfg.scope : ''), onMessage);

      // scope method names based on cfg.scope specified when the Channel was instantiated
      const scopeMethod = (m) => {
        if (typeof cfg.scope === 'string' && cfg.scope.length) {
          m = [cfg.scope, m].join("::");
        }
        return m;
      };

      // a small wrapper around postmessage whose primary function is to handle the
      // case that clients start sending messages before the other end is "ready"
      const postMessage = (msg, force?) => {
        if (!msg) {
          throw new Error("postMessage called with null message")
        }

        // delay posting if we're not ready yet.
        const verb = (ready ? "post  " : "queue ");
        debug(verb + " message: " + JSON.stringify(msg));
        if (!force && !ready) {
          pendingQueue.push(msg);
        } else {
          if (typeof cfg.postMessageObserver === 'function') {
            try {
              cfg.postMessageObserver(cfg.origin, msg);
            } catch (e) {
              debug("postMessageObserver() raised an exception: " + e.toString());
            }
          }

          cfg.window.postMessage(JSON.stringify(msg), cfg.origin);
        }
      };

      const onReady = (trans, type) => {
        debug('ready msg received');
        if (ready) {
          throw new Error("received ready message while in ready state.  help!")
        }

        if (type === 'ping') {
          chanId += '-R';
        } else {
          chanId += '-L';
        }

        obj.unbind('__ready'); // now this handler isn't needed any more.
        ready = true;
        debug('ready msg accepted.');

        if (type === 'ping') {
          obj.notify({ method: '__ready', params: 'pong' });
        }

        // flush queue
        while (pendingQueue.length) {
          postMessage(pendingQueue.pop());
        }

        // invoke onReady observer if provided
        if (typeof cfg.onReady === 'function') {
          cfg.onReady(obj);
        }
      };

      const obj: ChannelInstanceObj = {
        // tries to unbind a bound message handler.  returns false if not possible
        unbind: (method) => {
          if (regTbl[method]) {
            if (!(delete regTbl[method])) {
              throw new Error("can't delete method: " + method);
            }
            return true;
          }
          return false;
        },
        bind: (method, cb) => {
          if (!method || typeof method !== 'string') {
            throw new Error("'method' argument to bind must be string")
          }
          if (!cb || typeof cb !== 'function') {
            throw new Error("callback missing from bind params")
          }

          if (regTbl[method]) {
            throw new Error("method '" + method + "' is already bound!")
          }
          regTbl[method] = cb;
          return obj;
        },
        call: (m) => {
          if (!m) {
            throw new Error('missing arguments to call function')
          }
          if (!m.method || typeof m.method !== 'string') {
            throw new Error("'method' argument to call must be string")
          }
          if (!m.success || typeof m.success !== 'function') {
            throw new Error("'success' callback missing from call")
          }

          // now it's time to support the 'callback' feature of jschannel.  We'll traverse the argument
          // object and pick out all of the functions that were passed as arguments.
          const callbacks = {};
          const callbackNames = [];
          const seen = [];

          const pruneFunctions = (path, obj1) => {
            if (seen.indexOf(obj1) >= 0) {
              throw new Error("params cannot be a recursive data structure")
            }
            seen.push(obj1);

            if (typeof obj1 === 'object') {
              for (const k in obj1) {
                if (!obj1.hasOwnProperty(k)) {
                  continue;
                }
                const np = path + (path.length ? '/' : '') + k;
                if (typeof obj1[k] === 'function') {
                  callbacks[np] = obj1[k];
                  callbackNames.push(np);
                  delete obj1[k];
                } else if (typeof obj1[k] === 'object') {
                  pruneFunctions(np, obj1[k]);
                }
              }
            }
          };
          pruneFunctions("", m.params);

          // build a 'request' message and send it
          const msg: any = { id: s_curTranId, method: scopeMethod(m.method), params: m.params };
          if (callbackNames.length) {
            msg.callbacks = callbackNames;
          }

          if (m.timeout) {
            // XXX: This function returns a timeout ID, but we don't do anything with it.
            // We might want to keep track of it so we can cancel it using clearTimeout()
            // when the transaction completes.
            setTransactionTimeout(s_curTranId, m.timeout, scopeMethod(m.method));
          }

          // insert into the transaction table
          outTbl[s_curTranId] = { callbacks, error: m.error, success: m.success };
          s_transIds[s_curTranId] = onMessage;

          // increment current id
          s_curTranId++;

          postMessage(msg);
        },
        notify: (m) => {
          if (!m) {
            throw new Error('missing arguments to notify function')
          }
          if (!m.method || typeof m.method !== 'string') {
            throw new Error("'method' argument to notify must be string");
          }

          // no need to go into any transaction table
          postMessage({ method: scopeMethod(m.method), params: m.params });
        },
        destroy: () => {
          s_removeBoundChan(cfg.window, cfg.origin, ((typeof cfg.scope === 'string') ? cfg.scope : ''));
          if (window.removeEventListener) {
            window.removeEventListener('message', s_onMessage, false);
          } else if ((window as Window & { detachEvent?: any }).detachEvent) {
            (window as Window & { detachEvent?: any }).detachEvent('onmessage', s_onMessage);
          }
          ready = false;
          regTbl = {};
          inTbl = {};
          outTbl = {};
          cfg.origin = null;
          pendingQueue = [];
          debug("channel destroyed");
          chanId = "";
        }
      };

      obj.bind('__ready', onReady);
      if (cfg.type && cfg.type === 'child') {
        setTimeout(() => {
          postMessage({ method: scopeMethod('__ready'), params: "ping" }, true);
        }, 0);
      }

      return obj;
    }
  };
})()
